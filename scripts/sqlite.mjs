import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function inside(root, path) {
  const pathFromRoot = relative(root, path);
  return !isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith('..' + sep);
}

export function sqlitePath() {
  return resolve(/* turbopackIgnore: true */ process.env.PROJECTOS_DB_PATH || './local-data/projectos.sqlite');
}

export function assertSqliteWritable(path = sqlitePath()) {
  const marker = path + '.postgres-cutover';
  try {
    lstatSync(marker);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('SQLite is sealed for PostgreSQL cutover');
}

export function sealSqliteSource(path) {
  const source = realpathSync(path);
  const marker = source + '.postgres-cutover';
  let fd;
  try { fd = openSync(marker, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST' && lstatSync(marker).isFile()) return;
    throw error;
  }
  try {
    writeFileSync(fd, 'ProjectOS PostgreSQL cutover\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (process.platform !== 'win32') {
    const directory = openSync(dirname(marker), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

export function openSqlite() {
  const path = sqlitePath();
  const forbidden = [resolve('public'),resolve('.next'),resolve('.git'),resolve('node_modules')];
  if (forbidden.some(root => inside(root, path))) throw new Error('Unsafe database location');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const canonical = resolve(realpathSync(dirname(path)), basename(path));
  assertSqliteWritable(canonical);
  if (forbidden.some(root => inside(existsSync(root) ? realpathSync(root) : root, canonical))) {
    throw new Error('Unsafe database location');
  }
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Symlink database path not permitted');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const db = new DatabaseSync(path, { timeout: 5000 });
  try { chmodSync(path, 0o600); } catch { /* POSIX file mode is platform dependent. */ }
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
  try {
    db.exec(INITIAL_SCHEMA);
    if (addColumn(db, 'sessions', 'last_seen_at', 'INTEGER NOT NULL DEFAULT 0')) {
      db.exec('UPDATE sessions SET last_seen_at=created_at WHERE last_seen_at=0');
    }
    addColumn(db, 'audit_events', 'actor_snapshot', "TEXT NOT NULL DEFAULT ''");
    for (const [name, definition] of Object.entries({
      mfa_seed: 'TEXT', mfa_pending: 'TEXT', mfa_pending_session: 'TEXT', mfa_pending_until: 'INTEGER NOT NULL DEFAULT 0',
      mfa_last_step: 'INTEGER NOT NULL DEFAULT -1', mfa_failed: 'INTEGER NOT NULL DEFAULT 0',
      mfa_locked_until: 'INTEGER NOT NULL DEFAULT 0',
    })) addColumn(db, 'users', name, definition);
    addColumn(db, 'memberships', 'project_ids', 'TEXT');
    addColumn(db, 'workspace_invites', 'project_ids', 'TEXT');
    addColumn(db, 'records', 'record_version', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'delivery_retries', 'lease_token', 'TEXT');
    addColumn(db, 'notification_outbox', 'expires_at', 'INTEGER');
    addColumn(db, 'notification_outbox', 'telegram_title', 'TEXT');
    addColumn(db, 'notification_outbox', 'telegram_project', 'TEXT');
    if (addColumn(db, 'delivery_retries', 'dispatch_at', 'INTEGER')) {
      db.exec("UPDATE delivery_retries SET dispatch_at=claimed_at WHERE notification_id IN (SELECT id FROM notification_outbox WHERE state='sending')");
    }
    addColumn(db, 'delivery_retries', 'provider_id', 'TEXT');
    addColumn(db, 'delivery_retries', 'last_error', 'TEXT');
    db.exec(`CREATE TRIGGER IF NOT EXISTS projectos_notification_cancellation AFTER UPDATE OF state ON notification_outbox
      FOR EACH ROW WHEN OLD.state='sending' AND NEW.state='cancelled' AND EXISTS (
        SELECT 1 FROM delivery_retries WHERE notification_id=OLD.id AND dispatch_at IS NOT NULL
      ) BEGIN UPDATE notification_outbox SET state='unknown' WHERE id=OLD.id; END`);
    addColumn(db, 'monitor_observations', 'tls_expires_at', 'TEXT');
    addColumn(db, 'monitor_observations', 'source', "TEXT NOT NULL DEFAULT 'https'");
    addColumn(db, 'machine_observations', 'disk_used_bytes', 'INTEGER');
    addColumn(db, 'machine_observations', 'disk_total_bytes', `INTEGER CHECK(
      (disk_used_bytes IS NULL AND disk_total_bytes IS NULL) OR
      (disk_used_bytes IS NOT NULL AND disk_total_bytes IS NOT NULL AND
        disk_used_bytes >= 0 AND disk_total_bytes > 0 AND disk_used_bytes <= disk_total_bytes)
    )`);
    db.exec('COMMIT');
    return db;
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
}

function addColumn(db, table, column, definition) {
  const columns = db.prepare('PRAGMA table_info(' + table + ')').all();
  if (columns.some(entry => entry.name === column)) return false;
  db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
  return true;
}

const INITIAL_SCHEMA = `CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL,
      failed_logins INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS workspaces(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memberships(
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
      PRIMARY KEY(user_id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS sessions(
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS records(
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT,
      payload TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,kind,id)
    );
    CREATE INDEX IF NOT EXISTS idx_records_project ON records(workspace_id,project_id);
    CREATE TABLE IF NOT EXISTS audit_events(
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL, record_id TEXT NOT NULL, action TEXT NOT NULL,
      title TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ws_date ON audit_events(workspace_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS document_versions(
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL, revision INTEGER NOT NULL,
      payload TEXT NOT NULL, saved_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,document_id,revision)
    );
    CREATE TABLE IF NOT EXISTS notification_outbox(
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      reminder_id TEXT NOT NULL, scheduled_for TEXT NOT NULL, channel TEXT NOT NULL,
      state TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT,
      UNIQUE(workspace_id, reminder_id, scheduled_for, channel)
    );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_membership_one_workspace ON memberships(user_id);
  CREATE INDEX IF NOT EXISTS idx_memberships_workspace ON memberships(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS workspace_invites (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('editor','viewer')),
    token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
    redeemed_at INTEGER, revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_invites_workspace ON workspace_invites(workspace_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id, code_hash)
  );
  CREATE TABLE IF NOT EXISTS record_tombstones (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, id TEXT NOT NULL, record_version INTEGER NOT NULL,
    PRIMARY KEY(workspace_id, kind, id)
  );
  CREATE TABLE IF NOT EXISTS delivery_retries (
    notification_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
    retry_after INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS outbox_by_channel ON notification_outbox(channel, state, created_at);
  CREATE TABLE IF NOT EXISTS monitor_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL,
    resource_id TEXT NOT NULL, checked_at TEXT NOT NULL, state TEXT NOT NULL, status_code INTEGER,
    latency_ms INTEGER, diagnostic TEXT NOT NULL, UNIQUE(workspace_id, resource_id, checked_at)
  );
  CREATE INDEX IF NOT EXISTS idx_observation_latest ON monitor_observations(workspace_id, resource_id, checked_at DESC);
  CREATE TABLE IF NOT EXISTS ai_quota (
    user_id TEXT NOT NULL, hourly_window TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY(user_id, hourly_window)
  );
  CREATE TABLE IF NOT EXISTS auth_rate_limits (
    scope TEXT NOT NULL, bucket TEXT NOT NULL, expires_at INTEGER NOT NULL, hits INTEGER NOT NULL,
    PRIMARY KEY(scope, bucket)
  );
  CREATE INDEX IF NOT EXISTS auth_rate_limits_expiry ON auth_rate_limits(expires_at);
  CREATE TABLE IF NOT EXISTS vault_checks (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, ref_id TEXT NOT NULL,
    reference_version INTEGER NOT NULL, checked_at TEXT NOT NULL, status TEXT NOT NULL, provider_version INTEGER,
    PRIMARY KEY(workspace_id, ref_id)
  );
  CREATE TABLE IF NOT EXISTS github_snapshots (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, project_id TEXT NOT NULL,
    repo TEXT NOT NULL, checked_at TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(workspace_id, project_id, repo)
  );
  CREATE TABLE IF NOT EXISTS github_deliveries (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, project_id TEXT NOT NULL,
    repo TEXT NOT NULL, delivery_id TEXT NOT NULL, payload_hash TEXT NOT NULL, event_type TEXT NOT NULL, received_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id, project_id, repo, delivery_id), UNIQUE(workspace_id, project_id, repo, payload_hash)
  );
  CREATE TABLE IF NOT EXISTS machine_observations (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, resource_id TEXT NOT NULL,
    checked_at TEXT NOT NULL, cpu_percent REAL NOT NULL, used_bytes INTEGER NOT NULL,total_bytes INTEGER NOT NULL,
    PRIMARY KEY(workspace_id,resource_id,checked_at)
  );
  CREATE TABLE IF NOT EXISTS worker_heartbeats (name TEXT PRIMARY KEY, checked_at TEXT NOT NULL);
`;
