import pg from 'pg';
import { createHmac } from 'node:crypto';
import { assertSqliteWritable, openSqlite } from './sqlite.mjs';

let sqlite;
let pool;
let queue = Promise.resolve();

export function postgresConfigured() {
  const configured = Boolean(process.env.PROJECTOS_DATABASE_URL);
  if (!configured && process.env.PROJECTOS_DATABASE_MODE === 'postgres') {
    throw new Error('PostgreSQL cutover requires PROJECTOS_DATABASE_URL');
  }
  return configured;
}

function localHost(hostname) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

export function getPostgresPool() {
  if (pool) return pool;
  const connectionString = process.env.PROJECTOS_DATABASE_URL;
  if (!connectionString) throw new Error('PostgreSQL connection is not configured');
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.search || url.hash) {
    throw new Error('Provide a PostgreSQL URL without connection overrides');
  }
  const ssl = localHost(url.hostname)
    ? false
    : { rejectUnauthorized: true, ca: process.env.PROJECTOS_PG_CA || undefined };
  pool = new pg.Pool({
    connectionString,
    ssl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 10_000,
    allowExitOnIdle: true,
    types: {
      getTypeParser(oid, format) {
        if (oid === 20) return (value) => {
          const parsed = Number(value);
          if (!Number.isSafeInteger(parsed)) throw new Error('PostgreSQL integer exceeds safe range');
          return parsed;
        };
        if (oid === 1184) return value => new Date(value).toISOString();
        return pg.types.getTypeParser(oid, format);
      },
    },
  });
  pool.on('error', () => console.error('ProjectOS PostgreSQL idle connection closed unexpectedly'));
  return pool;
}

export function getDb() {
  if (postgresConfigured()) throw new Error('SQLite is unavailable while PostgreSQL is configured');
  if (process.env.NODE_ENV === 'production') {
    const origin = process.env.PROJECTOS_PUBLIC_ORIGIN;
    if (!origin || !localHost(new URL(origin).hostname)) {
      throw new Error('PostgreSQL is required outside localhost');
    }
  }
  assertSqliteWritable();
  sqlite ??= openSqlite();
  return sqlite;
}

export async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
  sqlite?.close();
  sqlite = undefined;
}

function sqliteExecutor(connection) {
  return {
    dialect: 'sqlite',
    async all(statement, ...params) { return connection.prepare(statement).all(...params); },
    async one(statement, ...params) { return connection.prepare(statement).get(...params); },
    async run(statement, ...params) { return Number(connection.prepare(statement).run(...params).changes); },
  };
}

function postgresExecutor(connection) {
  function execute(statement, params) {
    let parameter = 0;
    // Repository SQL is static and uses '?' only as a parameter marker.
    const text = statement.replace(/\?/g, () => '$' + (++parameter));
    if (parameter !== params.length) throw new Error('SQL parameter count mismatch');
    return connection.query(text, params);
  }
  return {
    dialect: 'postgres',
    async all(statement, ...params) { return (await execute(statement, params)).rows; },
    async one(statement, ...params) { return (await execute(statement, params)).rows[0]; },
    async run(statement, ...params) { return (await execute(statement, params)).rowCount ?? 0; },
  };
}

function sqliteExclusive(action) {
  const result = queue.then(() => action(getDb()));
  queue = result.catch(() => {});
  return result;
}

export const sql = {
  get dialect() { return postgresConfigured() ? 'postgres' : 'sqlite'; },
  all(statement, ...params) {
    if (postgresConfigured()) return postgresExecutor(getPostgresPool()).all(statement, ...params);
    return sqliteExclusive(db => sqliteExecutor(db).all(statement, ...params));
  },
  one(statement, ...params) {
    if (postgresConfigured()) return postgresExecutor(getPostgresPool()).one(statement, ...params);
    return sqliteExclusive(db => sqliteExecutor(db).one(statement, ...params));
  },
  run(statement, ...params) {
    if (postgresConfigured()) return postgresExecutor(getPostgresPool()).run(statement, ...params);
    return sqliteExclusive(db => sqliteExecutor(db).run(statement, ...params));
  },
};

async function inTransaction(action, readOnly) {
  if (!postgresConfigured()) {
    return sqliteExclusive(async db => {
      db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
      try {
        const value = await action(sqliteExecutor(db));
        if (!readOnly) assertSqliteWritable();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
  }
  const client = await getPostgresPool().connect();
  let discard = false;
  function onConnectionError() { discard = true; }
  client.on('error', onConnectionError);
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    const db = postgresExecutor(client);
    let workspace;
    let binding;
    const sign = async (context) => {
      const key = process.env.PROJECTOS_DB_SCOPE_KEY;
      if (!key) return;
      if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Invalid database scope signing key');
      binding ??= (await client.query(
        "SELECT pg_backend_pid()::text || ':' || extract(epoch FROM transaction_timestamp())::text AS binding"
      )).rows[0].binding;
      return createHmac('sha256',Buffer.from(key,'hex')).update(binding + ':' + context).digest('hex');
    };
    if (process.env.PROJECTOS_DB_SCOPE_KEY) db.scopeIdentity = async (scope) => {
      const claims = JSON.stringify(scope);
      const mac = await sign('identity:' + claims);
      if (mac) await client.query(
        "SELECT set_config('projectos.identity_scope', $1, true), set_config('projectos.identity_mac', $2, true)",
        [claims, mac],
      );
    };
    db.scopeWorkspace = async (workspaceId, documentScope) => {
      if (!workspaceId || (workspace !== undefined && workspace !== workspaceId)) throw new Error('Invalid transaction workspace');
      workspace = workspaceId;
      const signature = await sign(workspaceId);
      if (!signature) return; // Schema owner maintenance does not require a web scope.
      await client.query("SELECT set_config('projectos.workspace', $1, true), set_config('projectos.workspace_mac', $2, true)",
        [workspaceId,signature]);
      if (documentScope) {
        const claims=JSON.stringify(documentScope);
        const mac = await sign('docs:' + workspaceId + ':' + claims);
        await client.query("SELECT set_config('projectos.document_scope', $1, true), set_config('projectos.document_mac', $2, true)",
          [claims,mac]);
      }
    };
    const value = await action(db);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    if (!discard) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
    }
    throw error;
  } finally {
    client.removeListener('error', onConnectionError);
    client.release(discard);
  }
}

export function transaction(action) { return inTransaction(action, false); }
export function readTransaction(action) { return inTransaction(action, true); }

export async function lockWorkspace(db, workspaceId) {
  const lock = db.dialect === 'postgres' ? ' FOR UPDATE' : '';
  await db.scopeWorkspace?.(workspaceId);
  return db.one('SELECT version,name FROM workspaces WHERE id=?' + lock, workspaceId);
}

export async function lockBootstrap(db) {
  if (db.dialect === 'postgres') await db.one('SELECT pg_advisory_xact_lock(3804522)');
}

export async function requireWebRuntime({ verifyKey = false } = {}) {
  if (process.env.PROJECTOS_DATABASE_MODE !== 'postgres') return;
  if (!/^[a-f0-9]{64}$/i.test(process.env.PROJECTOS_DB_SCOPE_KEY ?? '')) {
    throw new Error('PostgreSQL runtime signing key is required');
  }
  const role = await sql.one(`SELECT NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid)
    AND NOT has_schema_privilege(current_user,'public','CREATE')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner=r.oid AND relnamespace='public'::regnamespace)
    AND has_column_privilege(current_user,'public.users','email','SELECT')
    AND NOT has_column_privilege(current_user,'public.users','password_hash','SELECT')
    AND NOT has_column_privilege(current_user,'public.records','payload','SELECT') AS allowed
    FROM pg_catalog.pg_roles r WHERE rolname=current_user`);
  if (!role?.allowed) throw new Error('A dedicated PostgreSQL web login is required');
  if (verifyKey) {
    const probe = 'projectos-readiness';
    const configured = await readTransaction(async db => {
      await db.scopeWorkspace(probe);
      return (await db.one('SELECT public.projectos_verified_workspace() AS workspace'))?.workspace === probe;
    });
    if (!configured) throw new Error('PostgreSQL runtime signing key does not match');
  }
}

export async function requireWorkerWorkspace(worker, workspace) {
  if (!postgresConfigured()) return;
  const role = await sql.one(`SELECT NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid)
    AND NOT has_schema_privilege(current_user,'public','CREATE')
    AND NOT has_column_privilege(current_user,'public.users','email','SELECT')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner=r.oid AND relnamespace='public'::regnamespace)
    AS allowed FROM pg_catalog.pg_roles r WHERE rolname=current_user`);
  if (!role?.allowed || !workspace) throw new Error('A dedicated PostgreSQL worker login and workspace are required');
  const scope = worker === 'monitor'
    ? await sql.one('SELECT public.projectos_monitor_workspace() AS workspace')
    : worker === 'reminder'
      ? await sql.one('SELECT public.projectos_reminder_workspace() AS workspace')
      : await sql.one(`SELECT id AS workspace FROM workspaces WHERE id=?
          AND has_table_privilege(current_user,'public.delivery_retries','UPDATE')
          AND NOT has_column_privilege(current_user,'public.records','payload','SELECT')`,workspace);
  if (scope?.workspace !== workspace) throw new Error('PostgreSQL worker is outside its configured workspace');
}
