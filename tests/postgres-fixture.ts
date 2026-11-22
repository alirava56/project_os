import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

type Client = {
  connect(): Promise<void>;
  query<Row = Record<string, unknown>>(statement: string, params?: unknown[]): Promise<{rows:Row[]}>;
  end(): Promise<void>;
};
const PgClient: new (options: {connectionString: string}) => Client =
  createRequire(resolve('package.json'))('pg').Client;
const exec = promisify(execFile);

export async function createPostgresFixture() {
  const cluster = new URL(process.env.PROJECTOS_TEST_POSTGRES_URL ?? 'file:/');
  if (!['postgres:', 'postgresql:'].includes(cluster.protocol) ||
    !['127.0.0.1','localhost'].includes(cluster.hostname) || cluster.pathname !== '/postgres' || cluster.search || cluster.hash) {
    throw new Error('Set PROJECTOS_TEST_POSTGRES_URL to an isolated loopback PostgreSQL admin database');
  }
  const suffix = randomBytes(8).toString('hex');
  const database = 'projectos_test_browser_' + suffix;
  const role = 'projectos_browser_' + suffix;
  const password = randomBytes(24).toString('hex');
  const scopeKey = randomBytes(32).toString('hex');
  const ownerUrl = new URL('/' + database,cluster);
  const webUrl = new URL(ownerUrl);
  webUrl.username = role;
  webUrl.password = password;
  const admin = new PgClient({connectionString:cluster.href});
  let databaseCreated = false;
  let roleCreated = false;
  async function dispose() {
    try {
      if (databaseCreated) await admin.query(`DROP DATABASE "${database}"`);
    } finally {
      try {
        if (roleCreated) await admin.query(`DROP ROLE "${role}"`);
      } finally { await admin.end(); }
    }
  }
  async function query<Row = Record<string, unknown>>(statement: string, params?: unknown[]) {
    const client = new PgClient({connectionString:ownerUrl.href});
    await client.connect();
    try { return await client.query<Row>(statement,params); }
    finally { await client.end(); }
  }
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    databaseCreated = true;
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    roleCreated = true;
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^PROJECTOS_|^PG/i.test(name))),
      NODE_ENV:'test' as const,
    };
    await exec(process.execPath, [resolve('scripts/migrate-postgres.mjs')], {
      env: {...env, PROJECTOS_DATABASE_URL:ownerUrl.href}, timeout:30_000,
    });
    const psql = process.env.PROJECTOS_PG_BIN ? join(process.env.PROJECTOS_PG_BIN,'psql') : 'psql';
    await exec(psql, ['-X','-h',cluster.hostname,'-p',cluster.port || '5432','-U',decodeURIComponent(cluster.username),
      '-d',database,'-v','runtime_role='+role,'-f',resolve('schema/postgres/grant-runtime.sql')], {
      env:{...env,PGPASSWORD:decodeURIComponent(cluster.password)}, timeout:30_000,
    });
    await query('INSERT INTO projectos_private.scope_key(singleton,secret) VALUES(true,decode($1,\'hex\'))',[scopeKey]);
    return {url:webUrl.href, scopeKey, query, dispose};
  } catch (error) {
    await dispose();
    throw error;
  }
}

export type PostgresFixture = Awaited<ReturnType<typeof createPostgresFixture>>;
