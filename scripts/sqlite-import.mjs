import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { suspiciousCredential, suspiciousInRecord } from '../src/lib/server/credential-guard.ts';

// Fixed identifiers and ordering. Defaults represent columns added after the earliest preview.
const tables = [
  ['users', ['id'], 'id email display_name password_hash salt created_at failed_logins locked_until mfa_seed mfa_pending mfa_pending_session mfa_pending_until mfa_last_step mfa_failed mfa_locked_until'],
  ['workspaces', ['id'], 'id name version created_at'],
  ['memberships', ['user_id', 'workspace_id'], 'user_id workspace_id role project_ids'],
  ['sessions', ['token_hash'], 'token_hash user_id created_at expires_at last_seen_at'],
  ['records', ['workspace_id', 'kind', 'id'], 'workspace_id kind id project_id payload updated_at record_version'],
  ['record_tombstones', ['workspace_id', 'kind', 'id'], 'workspace_id kind id record_version'],
  ['audit_events', ['id'], 'id workspace_id actor_id kind record_id action title project_id created_at actor_snapshot'],
  ['document_versions', ['workspace_id', 'document_id', 'revision'], 'workspace_id document_id revision payload saved_at'],
  ['workspace_invites', ['id'], 'id workspace_id email role token_hash expires_at created_at redeemed_at revoked_at project_ids'],
  ['mfa_recovery_codes', ['user_id','code_hash'], 'user_id code_hash created_at'],
  ['notification_outbox', ['id'], 'id workspace_id reminder_id scheduled_for channel state created_at delivered_at expires_at telegram_title telegram_project'],
  ['delivery_retries', ['notification_id'], 'notification_id attempts retry_after claimed_at lease_token dispatch_at provider_id last_error'],
  ['monitor_observations', ['id'], 'id workspace_id resource_id checked_at state status_code latency_ms diagnostic source tls_expires_at'],
  ['ai_quota', ['user_id','hourly_window'], 'user_id hourly_window used'],
  ['auth_rate_limits', ['scope','bucket'], 'scope bucket expires_at hits'],
  ['vault_checks',['workspace_id','ref_id'],'workspace_id ref_id reference_version checked_at status provider_version'],
  ['github_snapshots',['workspace_id','project_id','repo'],'workspace_id project_id repo checked_at status payload'],
  ['github_deliveries',['workspace_id','project_id','repo','delivery_id'],'workspace_id project_id repo delivery_id payload_hash event_type received_at'],
  ['machine_observations',['workspace_id','resource_id','checked_at'],'workspace_id resource_id checked_at cpu_percent used_bytes total_bytes disk_used_bytes disk_total_bytes'],
  ['worker_heartbeats', ['name'], 'name checked_at'],
].map(([name, order, columns]) => ({ name, order, columns: columns.split(' ') }));

const numericOrder = new Set(['monitor_observations.id', 'document_versions.revision']);
const isoFields = new Set([
  'users.created_at','workspaces.created_at','records.updated_at','audit_events.created_at','document_versions.saved_at',
  'mfa_recovery_codes.created_at','notification_outbox.created_at','notification_outbox.delivered_at',
  'monitor_observations.checked_at','monitor_observations.tls_expires_at','machine_observations.checked_at','worker_heartbeats.checked_at','vault_checks.checked_at','github_snapshots.checked_at','github_deliveries.received_at',
]);
const defaults = {
  failed_logins: 0, locked_until: 0, mfa_seed: null, mfa_pending: null, mfa_pending_session: null, mfa_pending_until: 0,
  mfa_last_step: -1, mfa_failed: 0, mfa_locked_until: 0, project_ids: null, record_version: 0, actor_snapshot: '',
  lease_token: null, source: 'https', tls_expires_at: null,
  disk_used_bytes: null, disk_total_bytes: null, expires_at:null, telegram_title:null, telegram_project:null,
  dispatch_at:null, provider_id:null, last_error:null,
};
const mandatory = new Set(['users','workspaces','memberships','records','sessions','document_versions','audit_events','notification_outbox']);

class SourceError extends Error {}

function projectRow(table, row) {
  const values = table.columns.map(column => {
    let value = row[column];
    if (value === undefined) {
      if (column === 'last_seen_at') value = row.created_at;
      else if (Object.hasOwn(defaults, column)) value = defaults[column];
      else throw new SourceError('Unexpected schema in ' + table.name);
    }
    if (value !== null && isoFields.has(table.name + '.' + column)) {
      const ms = Date.parse(value);
      if (!Number.isFinite(ms)) throw new SourceError('Invalid timestamp in ' + table.name);
      value = new Date(ms).toISOString();
    }
    return value;
  });
  return values;
}

function validateSensitive(table, row) {
  const fields = ['title', 'display_name', 'name', 'email', 'actor_snapshot', 'action', 'diagnostic', 'telegram_title', 'telegram_project'];
  let flagged = fields.some(field => typeof row[field] === 'string' && suspiciousCredential(row[field]));
  if (Object.hasOwn(row, 'payload')) {
    try { flagged ||= suspiciousInRecord(JSON.parse(row.payload)); }
    catch { throw new SourceError('Invalid JSON in ' + table.name); }
  }
  if (flagged) throw new SourceError('Credential-like legacy data requires offline remediation in ' + table.name);
}

export function openSnapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    db.exec('BEGIN');
    const integrity = db.prepare('PRAGMA quick_check').get();
    if (Object.values(integrity)[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) {
      throw new SourceError('SQLite source failed integrity checks');
    }
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name));
    if ([...mandatory].some(name => !names.has(name)) || [...names].some(name => !tables.some(table => table.name === name))) {
      throw new SourceError('Unmapped or missing SQLite tables; no data imported');
    }
    const snapshot = { db, names, close() { try { db.exec('ROLLBACK'); } finally { db.close(); } } };
    return snapshot;
  } catch (error) {
    db.close();
    throw error;
  }
}

function *rows(snapshot, table) {
  if (!snapshot.names.has(table.name)) return;
  const query = 'SELECT * FROM ' + table.name + ' ORDER BY ' + table.order.join(',');
  for (const row of snapshot.db.prepare(query).iterate()) {
    validateSensitive(table, row);
    yield projectRow(table, row);
  }
}

function newDigest() { return createHash('sha256'); }
function add(digest, table, values) {
  // Rows without disk samples keep their earlier import digest and can be retried.
  const optional = {machine_observations:2,notification_outbox:3,delivery_retries:3}[table.name];
  const stable = optional && values.slice(-optional).every(value => value === null) ? values.slice(0,-optional) : values;
  digest.update(JSON.stringify(stable) + '\n');
}

export function manifest(snapshot) {
  const counts = {};
  const digest = newDigest();
  for (const table of tables) {
    digest.update(table.name + '\n');
    let count = 0;
    for (const values of rows(snapshot, table)) {
      add(digest, table, values);
      count++;
    }
    counts[table.name] = count;
  }
  return { digest: digest.digest('hex'), counts };
}

async function insertTable(client, snapshot, table) {
  let batch = [], bytes = 0;
  async function flush() {
    if (!batch.length) return;
    const params = batch.flat();
    const width = table.columns.length;
    const groups = batch.map((_, row) => '(' + table.columns.map((_, col) => '$' + (row * width + col + 1)).join(',') + ')');
    await client.query('INSERT INTO ' + table.name + '(' + table.columns.join(',') + ') VALUES ' + groups.join(','), params);
    batch = [];
    bytes = 0;
  }
  for (const values of rows(snapshot, table)) {
    if (batch.length >= 100 || bytes >= 2 * 1024 * 1024) await flush();
    batch.push(values);
    bytes += Buffer.byteLength(JSON.stringify(values));
  }
  await flush();
}

async function targetManifest(client) {
  const counts = {};
  const digest = newDigest();
  for (const table of tables) {
    digest.update(table.name + '\n');
    const order = table.order.map(column => {
      const field = table.name + '.' + column;
      return column + (numericOrder.has(field) || isoFields.has(field) ? '' : ' COLLATE "C"');
    }).join(',');
    let cursor = 0;
    while (true) {
      const result = await client.query('SELECT ' + table.columns.join(',') + ' FROM ' + table.name
        + ' ORDER BY ' + order + ' LIMIT 100 OFFSET $1', [cursor]);
      for (const row of result.rows) add(digest, table, projectRow(table, row));
      cursor += result.rowCount;
      if (result.rowCount < 100) break;
    }
    counts[table.name] = cursor;
  }
  return { digest: digest.digest('hex'), counts };
}

export async function verifyRollbackBoundary(pool, expected) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SET LOCAL row_security=off');
    const postgresOnly = ['public.vpn_observations', 'public.semantic_index', 'projectos_private.github_sync_bindings',
      'projectos_private.github_sync_jobs', 'projectos_private.currency_schedules', 'projectos_private.slo_lifecycle'];
    const known = [...tables.map(table => table.name), 'sqlite_imports', 'projectos_schema_migrations',
      ...postgresOnly.filter(name => name.startsWith('public.')).map(name => name.split('.')[1])];
    const extra = await client.query(`SELECT 1 FROM pg_tables WHERE schemaname='public'
      AND NOT (tablename = ANY($1::text[])) LIMIT 1`, [known]);
    for (const name of postgresOnly) {
      const { rows } = await client.query('SELECT to_regclass($1) AS name', [name]);
      if (rows[0].name && (await client.query('SELECT 1 FROM ' + name + ' LIMIT 1')).rowCount) {
        throw new SourceError('Unsafe SQLite rollback: target contains PostgreSQL-only data');
      }
    }
    const recorded = await client.query('SELECT 1 FROM sqlite_imports WHERE source_digest=$1', [expected.digest]);
    if (extra.rowCount || !recorded.rowCount || (await targetManifest(client)).digest !== expected.digest) {
      throw new SourceError('Unsafe SQLite rollback: target differs from the imported snapshot');
    }
    return {status:'matches_imported_snapshot',digest:expected.digest};
  } finally {
    const discard = await client.query('ROLLBACK').then(() => false, () => true);
    client.release(discard);
  }
}

export async function importSnapshot(pool, snapshot, expected, beforeCommit = async () => {}) {
  const client = await pool.connect();
  let discard = false;
  function onConnectionError() { discard = true; }
  client.on('error', onConnectionError);
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(3804522)');
    const recorded = await client.query('SELECT 1 FROM sqlite_imports WHERE source_digest=$1', [expected.digest]);
    if (recorded.rowCount) {
      await client.query('COMMIT');
      return { ...expected, status: 'already_imported' };
    }
    // Empty-target cutover only. Prevent a concurrent writer from changing that premise.
    await client.query('LOCK TABLE ' + tables.map(table => table.name).join(',') + ' IN SHARE ROW EXCLUSIVE MODE');
    for (const table of tables) {
      if ((await client.query('SELECT 1 FROM ' + table.name + ' LIMIT 1')).rowCount) throw new SourceError('PostgreSQL target must be empty');
      await insertTable(client, snapshot, table);
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    const after = await targetManifest(client);
    if (after.digest !== expected.digest || JSON.stringify(after.counts) !== JSON.stringify(expected.counts)) {
      throw new SourceError('PostgreSQL verification did not match the source');
    }
    await client.query(`SELECT setval(pg_get_serial_sequence('monitor_observations','id'),
      COALESCE(MAX(id), 1), COUNT(*) > 0) FROM monitor_observations`);
    await client.query('INSERT INTO sqlite_imports(source_digest,manifest,imported_at) VALUES($1,$2,now())',
      [expected.digest, JSON.stringify(expected)]);
    await beforeCommit(client);
    await client.query('COMMIT');
    return { ...expected, status: 'imported' };
  } catch (error) {
    if (!discard) discard = await client.query('ROLLBACK').then(() => false, () => true);
    throw error;
  } finally {
    client.removeListener('error', onConnectionError);
    client.release(discard);
  }
}

export function migrationError(error) {
  return error instanceof SourceError ? error.message : error?.code ?? error?.name ?? 'Migration error';
}
