/* eslint-disable @typescript-eslint/no-require-imports -- run the TypeScript services with Node's test runner */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomBytes } = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { once } = require('node:events');
const { promisify } = require('node:util');
const ts = require('typescript');
const { Client } = require('pg');

require.extensions['.ts'] = (module, file) => {
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
  }).outputText;
  module._compile(compiled, file);
};

const { closeDatabase, getPostgresPool, getDb, readTransaction, transaction } = require('./database.mjs');
const { setupOwner, authenticate, newSession, lookupSessionUserId } = require('../src/lib/server/auth.ts');
const { accountByUser, loadState, sql } = require('../src/lib/server/db.ts');
const { commitRecordChanges } = require('../src/lib/server/record-service.ts');
const { createInvitation, acceptInvitation } = require('../src/lib/server/invitations.ts');
const { beginMfa, confirmMfa, issueRecoveryCodes, totp } = require('../src/lib/server/mfa.ts');

function project(id) {
  return { id, name: id, subtitle: '', coverTitle: id, description: '', status: 'building', type: 'Website',
    progress: 0, next: '', art: 'navigation/projects' };
}
function create(kind, record) { return { kind, id: record.id, action: 'create', record }; }

test('SQLite to PostgreSQL preserves data and identity; transactional rollback, retries and encrypted restore', { timeout: 90_000 }, async () => {
  const url = new URL(process.env.PROJECTOS_TEST_POSTGRES_URL || 'file:/');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.pathname === '/postgres', 'A disposable, loopback PostgreSQL admin database is required');
  const suffix = randomBytes(6).toString('hex');
  const target = 'projectos_test_' + suffix;
  const restoreTarget = 'projectos_restore_' + suffix;
  const runtimeRole = 'projectos_runtime_' + suffix;
  const deliveryRole = 'projectos_delivery_' + suffix;
  const monitorRole = 'projectos_monitor_' + suffix;
  const reminderRole = 'projectos_reminder_' + suffix;
  let reminderCreated = false;
  let monitorCreated = false;
  let deliveryCreated = false;
  let runtimeCreated = false;
  const connectionFor = db => new URL('/' + db, url).href;
  const admin = new Client({ connectionString: url.href });
  const area = mkdtempSync(join(tmpdir(), 'projectos-pg-test-'));
  const sqlitePath = join(area, 'source.sqlite');
  const legacyBackup = join(area, 'source.posbak'), postgresBackup = join(area, 'postgres.posbak');
  process.env.PROJECTOS_DATABASE_URL = '';
  process.env.PROJECTOS_DB_PATH = sqlitePath;
  process.env.PROJECTOS_SETUP_TOKEN = 'synthetic-test-bootstrap-key-only';
  process.env.PROJECTOS_MFA_ENCRYPTION_KEY = '51'.repeat(32);
  process.env.PROJECTOS_BACKUP_PASSPHRASE = 'synthetic-test-archive-key-2026';
  const ownerEmail = 'postgres-owner@example.test', password = 'synthetic-password-for-testing';
  const run = (entry, ...args) => execFileSync(process.execPath, [join(__dirname, entry), ...args], {
    encoding: 'utf8', env: process.env, timeout: 30_000,
  }).trim();
  const created = [];
  const createdRoles = [];
  await admin.connect();
  try {
    const uid = await setupOwner({setupToken: process.env.PROJECTOS_SETUP_TOKEN, email: ownerEmail, password,
      displayName: 'Test owner', workspace: 'Local test'});
    const owner = await accountByUser(uid);
    const { secret } = await beginMfa(uid, owner.email);
    assert.equal(await confirmMfa(uid, totp(secret)), true);
    assert.equal((await issueRecoveryCodes(uid)).length, 10);
    const archivedSession = await newSession(uid);
    await commitRecordChanges(owner, 0, [
      create('projects', project('alpha')),
      create('projects', project('beta')),
      create('docs', {id:'doc', projectId:'alpha', title:'آزمون', type:'Runbook', body:'Synthetic runbook', revision:1, updated:'2026-11-18'}),
      create('reminders', {id:'rem', projectId:'alpha', title:'Synthetic reminder', due:'2026-11-18', kind:'یادآوری'}),
      create('resources', {id:'vps', name:'Synthetic VPS', projectId:'alpha', linkedProjectIds:[], type:'server',
        address:'203.0.113.10', environment:'Development', status:'registered', provider:'Fixture host', tags:[],
        expires:'2031-03-04',noticeDays:2}),
      create('secrets', {id:'ref', projectId:'alpha', resourceId:'vps', name:'Vault pointer', type:'SSH Key',
        vaultProvider:'1Password', externalRef:'https://start.1password.com/open/i?i=synthetic'}),
    ]);
    const inv = await createInvitation(owner, 'postgres-editor@example.test', 'editor', ['alpha']);
    const editorId = await acceptInvitation({token:inv.token,email:'postgres-editor@example.test',password,displayName:'Test editor'});
    getDb().prepare('INSERT INTO notification_outbox(id,workspace_id,reminder_id,scheduled_for,channel,state,created_at,delivered_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('outbox-fixture',owner.workspaceId,'reminders:rem','2026-11-18','telegram','delivered',new Date().toISOString(),new Date().toISOString());
    const observation=getDb().prepare(`INSERT INTO machine_observations(workspace_id,resource_id,checked_at,cpu_percent,used_bytes,total_bytes,
      disk_used_bytes,disk_total_bytes) VALUES(?,?,?,?,?,?,?,?)`);
    observation.run(owner.workspaceId,'vps','2026-11-18T10:00:00.000Z',25,512,1024,null,null);
    observation.run(owner.workspaceId,'vps','2026-11-18T11:00:00.000Z',35,512,1024,6144,8192);
    const before = await loadState(owner);
    run('encrypted-backup.mjs', legacyBackup);
    await closeDatabase();
    const plan = JSON.parse(run('migrate-sqlite-postgres.mjs','--source',sqlitePath,'--dry-run'));
    assert.equal(plan.counts.records, 6);
    assert.equal(plan.counts.document_versions, 1);
    assert.equal(plan.counts.notification_outbox, 1);
    assert.equal(plan.counts.memberships, 2);
    assert.equal(plan.counts.machine_observations, 2);

    for (const db of [target, restoreTarget]) {
      await admin.query('CREATE DATABASE "' + db + '"');
      created.push(db);
    }
    process.env.PROJECTOS_DATABASE_URL = connectionFor(target);
    process.env.PROJECTOS_RESTORE_URL = connectionFor(restoreTarget);
    const runtimePassword=randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${runtimePassword}'`);
    runtimeCreated = true;
    const priorRelease = new Client({connectionString:connectionFor(target)});
    await priorRelease.connect();
    try {
      await priorRelease.query('CREATE TABLE projectos_schema_migrations(id text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
      const schema = join(__dirname,'../schema/postgres');
      for (const file of readdirSync(schema).filter(file=>/^0(0[1-9]|1[0-7])_.*\.sql$/.test(file)).sort()) {
        await priorRelease.query(readFileSync(join(schema,file),'utf8'));
        await priorRelease.query('INSERT INTO projectos_schema_migrations(id) VALUES($1)',[file.slice(0,-4)]);
      }
      await priorRelease.query(`GRANT SELECT,INSERT,UPDATE ON users,workspace_invites TO "${runtimeRole}";
        GRANT SELECT,INSERT,UPDATE,DELETE ON records,sessions,memberships,mfa_recovery_codes TO "${runtimeRole}";
        GRANT SELECT ON delivery_retries,worker_heartbeats TO "${runtimeRole}"`);
      assert.match(run('migrate-postgres.mjs'), /Applied 018_identity_boundaries/);
      assert.doesNotMatch(run('migrate-postgres.mjs'), /Applied/);
      await priorRelease.query('SET ROLE "'+runtimeRole+'"');
      await assert.rejects(priorRelease.query('SELECT password_hash FROM users'),{code:'42501'});
      await assert.rejects(priorRelease.query('SELECT payload FROM records'),{code:'42501'});
    } finally { await priorRelease.end(); }
    const psql = process.env.PROJECTOS_PG_BIN ? join(process.env.PROJECTOS_PG_BIN, 'psql') : 'psql';
    const roleArgs = ['-X', '-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username),
      '-d', target, '-f', join(__dirname, '../schema/postgres/grant-runtime.sql'), '-v'];
    const psqlOptions = {encoding:'utf8', env:{...process.env, PGPASSWORD:decodeURIComponent(url.password)}, timeout:30_000};
    assert.throws(() => execFileSync(psql,[...roleArgs,'runtime_role='+decodeURIComponent(url.username)],psqlOptions),
      /dedicated unprivileged/);
    execFileSync(psql,[...roleArgs,'runtime_role='+runtimeRole],psqlOptions);
    const scoped = new Client({connectionString:connectionFor(target)});
    try {
      await scoped.connect();
      await scoped.query('SET ROLE "' + runtimeRole + '"');
      await scoped.query('SELECT id FROM records LIMIT 1');
      await scoped.query('UPDATE records SET record_version=record_version WHERE FALSE');
      await assert.rejects(scoped.query('DELETE FROM audit_events WHERE FALSE'),{code:'42501'});
      await assert.rejects(scoped.query('UPDATE document_versions SET revision=revision WHERE FALSE'),{code:'42501'});
      await assert.rejects(scoped.query('SELECT id FROM projectos_schema_migrations'),{code:'42501'});
      await assert.rejects(scoped.query('CREATE TABLE public.runtime_forbidden(id integer)'),{code:'42501'});
    } finally { await scoped.end(); }

    const { importSnapshot, manifest, openSnapshot } = await import('./sqlite-import.mjs');
    const source = openSnapshot(sqlitePath);
    try {
      await assert.rejects(importSnapshot(getPostgresPool(), source, manifest(source), () => {
        throw new Error('simulated pre-commit failure');
      }), /simulated pre-commit failure/);
      assert.equal((await sql.one('SELECT COUNT(*) AS n FROM users')).n, 0);
      assert.equal((await sql.one('SELECT COUNT(*) AS n FROM sqlite_imports')).n, 0);
      await assert.rejects(importSnapshot(getPostgresPool(),source,manifest(source),async client=>{
        const {rows:[db]}=await client.query('SELECT current_database() AS database');
        assert.equal(db.database,target);
        await client.query('SELECT pg_terminate_backend(pg_backend_pid())');
      }),error=>['57P01','ECONNRESET'].includes(error.code));
      assert.equal((await sql.one('SELECT COUNT(*) AS n FROM users')).n,0);
      assert.equal((await sql.one('SELECT COUNT(*) AS n FROM sqlite_imports')).n,0);
    } finally { source.close(); }

    const imported = JSON.parse(run('migrate-sqlite-postgres.mjs','--source',sqlitePath,'--apply','--backup',legacyBackup));
    assert.equal(imported.status, 'imported');
    assert.equal(imported.digest, plan.digest);
    assert.deepEqual(imported.counts, plan.counts);
    assert.equal(existsSync(sqlitePath+'.postgres-cutover'),true);
    const blockedSource=()=>execFileSync(process.execPath,['--input-type=module','-e',
      "import { getDb } from './scripts/database.mjs'; getDb()"],{
      cwd:join(__dirname,'..'),encoding:'utf8',env:{...process.env,PROJECTOS_DATABASE_URL:''},
    });
    assert.throws(blockedSource,/SQLite is sealed for PostgreSQL cutover/);
    const rollbackCheck=()=>run('migrate-sqlite-postgres.mjs','--source',sqlitePath,'--check-rollback','--backup',legacyBackup);
    assert.equal(JSON.parse(rollbackCheck()).status,'matches_imported_snapshot');
    const localEvidence=new Client({connectionString:connectionFor(target)});
    await localEvidence.connect();
    try {
      await localEvidence.query(`INSERT INTO projectos_private.slo_lifecycle(workspace_id,resource_id,state,last_checked)
        SELECT id,'rollback-fixture','insufficient_data',now() FROM workspaces`);
      assert.throws(rollbackCheck,/PostgreSQL-only data/);
      await localEvidence.query("DELETE FROM projectos_private.slo_lifecycle WHERE resource_id='rollback-fixture'");
      assert.equal(JSON.parse(rollbackCheck()).status,'matches_imported_snapshot');
    } finally {await localEvidence.end();}
    assert.equal(JSON.parse(run('migrate-sqlite-postgres.mjs','--source',sqlitePath,'--apply','--backup',legacyBackup)).status, 'already_imported');
    assert.equal(JSON.parse(run('migrate-sqlite-postgres.mjs','--source',sqlitePath,'--dry-run')).digest, plan.digest);

    assert.equal(await authenticate(ownerEmail, password), uid);
    assert.equal(await lookupSessionUserId(archivedSession), uid);
    assert.deepEqual((await loadState(owner)).data.docs, before.data.docs);
    assert.deepEqual((await loadState(owner)).data.secrets, before.data.secrets);
    await assert.rejects(commitRecordChanges(owner, before.version, [{kind:'resources', id:'vps', action:'delete'}]), /Vault references/);
    assert.deepEqual((await loadState(await accountByUser(editorId))).data.projects.map(project => project.id), ['alpha']);
    const edit = (id, next) => ({ kind:'projects', id, action:'replace', record:{...project(id), next} });
    const [one, two] = await Promise.all([
      commitRecordChanges(owner, before.version, [edit('alpha', 'independent A')]),
      commitRecordChanges(owner, before.version, [edit('beta', 'independent B')]),
    ]);
    assert.notEqual(one, two);
    assert.throws(rollbackCheck,/Unsafe SQLite rollback/);
    await assert.rejects(commitRecordChanges(owner, before.version, [edit('alpha', 'stale')]), /changed/);
    const record = await sql.one("SELECT payload FROM records WHERE kind='projects' AND id='alpha'");
    assert.equal(JSON.parse(record.payload).next, 'independent A');
    const identityProbe = new Client({connectionString:connectionFor(target)});
    const unrelated = 'unrelated-' + suffix;
    const otherOwner = 'other-owner-' + suffix;
    const viewerId = 'viewer-' + suffix;
    const editorScope = {role:'editor',projects:['alpha'],actor:editorId};
    const viewerScope = {role:'viewer',projects:['beta'],actor:viewerId};
    const ownerScope = {role:'owner',projects:null,actor:uid};
    const otherOwnerScope = {role:'owner',projects:null,actor:otherOwner};
    const scopeKey=randomBytes(32);
    try {
      await identityProbe.connect();
      await identityProbe.query('INSERT INTO projectos_private.scope_key VALUES(true,$1)',[scopeKey]);
      await assert.rejects(identityProbe.query(
        "UPDATE records SET payload=(payload::jsonb || jsonb_build_object('projectId','beta'))::text WHERE kind='docs'",
      ), {code:'23514', constraint:'records_payload_identity'});
      await assert.rejects(identityProbe.query(
        "UPDATE records SET project_id=NULL WHERE kind='docs'",
      ), {code:'23514', constraint:'records_payload_identity'});
      assert.equal((await identityProbe.query("SELECT project_id FROM records WHERE kind='docs'")).rows[0].project_id,'alpha');
      const stamp = new Date().toISOString();
      await identityProbe.query('INSERT INTO workspaces(id,name,created_at) VALUES($1,$2,$3)', [unrelated,'Synthetic second workspace',stamp]);
      for (const [id,workspace,role,projects] of [[otherOwner,unrelated,'owner',null],[viewerId,owner.workspaceId,'viewer','["beta"]']]) {
        await identityProbe.query('INSERT INTO users(id,email,display_name,password_hash,salt,created_at) VALUES($1,$2,$1,$1,$1,$3)',
          [id,id+'@example.test',stamp]);
        await identityProbe.query('INSERT INTO memberships(user_id,workspace_id,role,project_ids) VALUES($1,$2,$3,$4)',
          [id,workspace,role,projects]);
      }
      await identityProbe.query(`INSERT INTO records(workspace_id,kind,id,project_id,payload,updated_at)
        VALUES($1,'projects','other','other',$2,$3)`,[unrelated,JSON.stringify(project('other')),stamp]);
      const hiddenParent={id:'private-parent',projectId:'beta',linkedProjectIds:[]};
      const sharedResource={id:'shared-resource',projectId:'beta',linkedProjectIds:['alpha'],parentId:hiddenParent.id};
      for (const value of [hiddenParent,sharedResource]) await identityProbe.query(
        "INSERT INTO records(workspace_id,kind,id,project_id,payload,updated_at) VALUES($1,'resources',$2,'beta',$3,$4)",
        [owner.workspaceId,value.id,JSON.stringify(value),stamp]);
      await identityProbe.query('SET ROLE "' + runtimeRole + '"');
      assert.equal((await identityProbe.query('SELECT count(*) FROM records')).rows[0].count,'0');
      await identityProbe.query('BEGIN');
      await identityProbe.query("SELECT set_config('projectos.workspace',$1,true)",[owner.workspaceId]);
      assert.equal((await identityProbe.query('SELECT count(*) FROM records')).rows[0].count,'0');
      const {rows:[{binding}]}=await identityProbe.query(
        "SELECT pg_backend_pid()::text || ':' || extract(epoch FROM transaction_timestamp())::text AS binding");
      const mac=createHmac('sha256',scopeKey).update(binding+':'+owner.workspaceId).digest('hex');
      await identityProbe.query("SELECT set_config('projectos.workspace_mac',$1,true)",[mac]);
      const claims=JSON.stringify(viewerScope);
      const setRecordScope=(value,signed=value)=>identityProbe.query(
        "SELECT set_config('projectos.document_scope',$1,true),set_config('projectos.document_mac',$2,true)",
        [value,createHmac('sha256',scopeKey).update(binding+':docs:'+owner.workspaceId+':'+signed).digest('hex')]);
      await setRecordScope(JSON.stringify(ownerScope),claims);
      assert.equal((await identityProbe.query('SELECT revision FROM document_versions')).rowCount,0);
      assert.equal((await identityProbe.query('SELECT id FROM records')).rowCount,0);
      await setRecordScope(claims);
      assert.equal((await identityProbe.query('SELECT revision FROM document_versions')).rowCount,0);
      assert.equal((await identityProbe.query("SELECT id FROM records WHERE kind='projects' AND id='alpha'")).rowCount,0);
      await setRecordScope(JSON.stringify({...editorScope,role:'viewer'}));
      assert.equal((await identityProbe.query('SELECT id FROM records')).rowCount,0);
      await setRecordScope(JSON.stringify(editorScope));
      assert.equal((await identityProbe.query('SELECT revision FROM document_versions')).rowCount,1);
      await setRecordScope(claims);
      assert.equal((await identityProbe.query("UPDATE records SET record_version=record_version+1 WHERE kind='docs'")).rowCount,0);
      await identityProbe.query('SAVEPOINT viewer_write');
      await assert.rejects(identityProbe.query(`INSERT INTO document_versions(workspace_id,document_id,revision,payload,saved_at)
        VALUES($1,'forbidden-history',100,$2,now())`,[owner.workspaceId,JSON.stringify({id:'forbidden-history',projectId:'beta'})]),{code:'42501'});
      await identityProbe.query('ROLLBACK TO SAVEPOINT viewer_write');
      assert.equal((await identityProbe.query("SELECT id FROM records WHERE kind='docs'")).rowCount,0);
      assert.equal((await identityProbe.query('SELECT id FROM records WHERE workspace_id=$1',[unrelated])).rowCount,0);
      await identityProbe.query("SELECT set_config('projectos.workspace',$1,true)",[unrelated]);
      assert.equal((await identityProbe.query('SELECT count(*) FROM records')).rows[0].count,'0');
      await identityProbe.query("SELECT set_config('projectos.workspace',$1,true)",[owner.workspaceId]);
      await setRecordScope(JSON.stringify(editorScope));
      await identityProbe.query('SAVEPOINT editor_move');
      await assert.rejects(identityProbe.query(`UPDATE records SET project_id='beta',
        payload=jsonb_set(payload::jsonb,'{projectId}','"beta"')::text WHERE kind='docs'`),{code:'42501'});
      await identityProbe.query('ROLLBACK TO SAVEPOINT editor_move');
      await setRecordScope(JSON.stringify(ownerScope));
      await assert.rejects(identityProbe.query(
        "UPDATE records SET workspace_id='outside-fixture' WHERE kind='docs'",
      ),{code:'42501'});
      await identityProbe.query('ROLLBACK');
      assert.equal((await identityProbe.query('SELECT count(*) FROM records')).rows[0].count,'0');
      await identityProbe.query('BEGIN');
      await identityProbe.query("SELECT set_config('projectos.workspace',$1,true), set_config('projectos.workspace_mac',$2,true)",[owner.workspaceId,mac]);
      assert.equal((await identityProbe.query('SELECT count(*) FROM records')).rows[0].count,'0');
      await assert.rejects(identityProbe.query('SELECT secret FROM projectos_private.scope_key'),{code:'42501'});
      await identityProbe.query('ROLLBACK');
      await identityProbe.query('RESET ROLE');
    } finally { await identityProbe.end(); }

    await closeDatabase();
    const limitedUrl=new URL(connectionFor(target));
    limitedUrl.username=runtimeRole;
    limitedUrl.password=runtimePassword;
    process.env.PROJECTOS_DATABASE_URL=limitedUrl.href;
    process.env.PROJECTOS_DB_SCOPE_KEY=scopeKey.toString('hex');
    getPostgresPool().options.max=2;
    const projectIds=(db)=>db.all("SELECT id FROM records WHERE kind='projects' ORDER BY id");
    for (const table of ['users','memberships','sessions','workspaces','workspace_invites','mfa_recovery_codes','ai_quota','auth_rate_limits','record_tombstones']) {
      const found = await sql.one('SELECT COUNT(*) AS n FROM '+table);
      assert.equal(found.n,0,table);
    }
    for (const statement of ['SELECT password_hash,mfa_seed FROM users','SELECT token_hash FROM sessions',
      'SELECT token_hash FROM workspace_invites','SELECT code_hash FROM mfa_recovery_codes',
      'SELECT project_id,payload FROM records','SELECT * FROM delivery_retries','SELECT * FROM notification_outbox']) {
      await assert.rejects(sql.all(statement),{code:'42501'});
    }
    assert.equal((await sql.one("SELECT public.projectos_setup_open() AS open")).open,false);
    assert.equal(await sql.one("SELECT id FROM public.projectos_password_credentials()"),undefined);
    assert.equal(await sql.one("SELECT seed FROM public.projectos_mfa_material()"),undefined);
    assert.deepEqual((await sql.all(`SELECT relname FROM pg_catalog.pg_class
      WHERE relnamespace='projectos_private'::regnamespace AND relforcerowsecurity ORDER BY relname`)).map(row=>row.relname),
    ['monitor_logins','reminder_logins','scope_key']);
    await readTransaction(async db=>{
      await db.scopeWorkspace(owner.workspaceId,editorScope);
      const row=await db.one("SELECT project_id,payload FROM public.projectos_records WHERE id='shared-resource'");
      assert.equal(row.project_id,'alpha');
      assert.deepEqual(JSON.parse(row.payload),{id:'shared-resource',projectId:'alpha',linkedProjectIds:[]});
      assert.deepEqual(await db.all('SELECT id FROM users'),[{id:editorId}]);
      assert.equal(await db.one("SELECT id FROM public.projectos_records WHERE id='private-parent'"),undefined);
    });
    await readTransaction(async db=>{
      await db.scopeWorkspace(owner.workspaceId,ownerScope);
      const row=await db.one("SELECT project_id,payload FROM public.projectos_records WHERE id='shared-resource'");
      assert.equal(row.project_id,'beta');
      assert.deepEqual(JSON.parse(row.payload),{id:'shared-resource',projectId:'beta',linkedProjectIds:['alpha'],parentId:'private-parent'});
    });
    await assert.rejects(transaction(async db=>{
      await db.scopeWorkspace(owner.workspaceId,editorScope);
      await db.run("UPDATE memberships SET role='owner' WHERE user_id=?",editorId);
    }),{code:'42501'});
    await transaction(async stale=>{
      await stale.scopeWorkspace(owner.workspaceId,editorScope);
      assert.deepEqual(await projectIds(stale),[{id:'alpha'}]);
      const renew=projects=>transaction(async ownerDb=>{
        await ownerDb.scopeWorkspace(owner.workspaceId,ownerScope);
        assert.equal(await ownerDb.run('UPDATE memberships SET project_ids=? WHERE user_id=?',projects,editorId),1);
      });
      await renew('["beta"]');
      assert.deepEqual(await projectIds(stale),[]);
      assert.equal(await stale.one("SELECT id FROM public.projectos_records WHERE id='shared-resource'"),undefined);
      await renew('["alpha"]');
    });
    const transactionIds=new Set();
    const tracked=async db=>{
      transactionIds.add((await db.one('SELECT pg_backend_pid() AS pid')).pid);
      assert.deepEqual(await projectIds(db),[]);
    };
    for (let attempt=0;attempt<5;attempt++) {
      await Promise.all([
        assert.rejects(readTransaction(async db=>{
          await tracked(db);
          await db.scopeWorkspace(owner.workspaceId,editorScope);
          assert.deepEqual(await projectIds(db),[{id:'alpha'}]);
          await db.one('SELECT 1/0');
        }),{code:'22012'}),
        readTransaction(async db=>{
          await tracked(db);
          await db.scopeWorkspace(unrelated,otherOwnerScope);
          assert.deepEqual(await projectIds(db),[{id:'other'}]);
        }),
        readTransaction(async db=>{
          await tracked(db);
          await db.scopeWorkspace(owner.workspaceId,viewerScope);
          assert.deepEqual(await projectIds(db),[{id:'beta'}]);
        }),
      ]);
    }
    assert.equal(transactionIds.size,2);
    await readTransaction(tracked);
    const workflowOwner=await accountByUser(uid);
    const workflowEditor=await accountByUser(editorId);
    const secondOwner=await accountByUser(otherOwner);
    const concurrentRoles = [];
    const provision = new Client({connectionString:connectionFor(target)});
    await provision.connect();
    try {
      await provision.query(`INSERT INTO notification_outbox(id,workspace_id,reminder_id,scheduled_for,channel,state,created_at)
        VALUES('concurrent-delivery',$1,'concurrent-fixture','2031-03-01','telegram','pending',now()),
          ('hidden-concurrent-delivery',$2,'concurrent-fixture','2031-03-01','telegram','pending',now())`,[owner.workspaceId,unrelated]);
      const localProbe={id:'concurrent-probe',projectId:'alpha',address:'https://127.0.0.1:1'};
      await provision.query(`INSERT INTO records(workspace_id,kind,id,project_id,payload,updated_at)
        VALUES($1,'resources',$2,'alpha',$3,now())`,[owner.workspaceId,localProbe.id,JSON.stringify(localProbe)]);
      for (const worker of ['monitor','reminder','delivery']) {
        const name='projectos_parallel_'+worker+'_'+suffix;
        const password=randomBytes(24).toString('hex');
        await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}'`);
        createdRoles.push(name);
        execFileSync(psql,['-X','-h',url.hostname,'-p',url.port||'5432','-U',decodeURIComponent(url.username),
          '-d',target,'-f',join(__dirname,'../schema/postgres/grant-'+worker+'.sql'),
          '-v',worker+'_role='+name,'-v','workspace_id='+owner.workspaceId],psqlOptions);
        const address = new URL(connectionFor(target));
        address.username=name;
        address.password=password;
        concurrentRoles.push([worker,address.href]);
      }
    } finally { await provision.end(); }
    const launch = promisify(execFile);
    const workers = concurrentRoles.map(([worker,address])=>{
      const env={...process.env,PROJECTOS_DATABASE_URL:address,PROJECTOS_DB_SCOPE_KEY:'',
        PROJECTOS_NOTIFICATION_WORKSPACE:owner.workspaceId,PROJECTOS_MONITOR_WORKSPACE:owner.workspaceId,
        PROJECTOS_MONITOR_HOSTS:'127.0.0.1',PROJECTOS_TELEGRAM_NOTIFICATIONS:'enabled',
        PROJECTOS_TELEGRAM_BOT_TOKEN:'12345:synthetic-fixture-1234',PROJECTOS_TELEGRAM_CHAT_ID:'12345'};
      const args = worker==='delivery' ? ['--input-type=module','-e',`
        import { requireWorkerWorkspace,closeDatabase } from './scripts/database.mjs';
        import { deliverNotifications } from './scripts/notification-delivery.mjs';
        const workspace=process.env.PROJECTOS_NOTIFICATION_WORKSPACE;
        try {
          await requireWorkerWorkspace('delivery',workspace);
          console.log(JSON.stringify(await deliverNotifications(workspace,{telegram:async()=>true})));
        } finally { await closeDatabase(); }
      `] : [join(__dirname,worker==='monitor'?'run-monitors.mjs':'run-reminders.mjs')];
      return launch(process.execPath,args,{env,cwd:join(__dirname,'..'),timeout:30_000}).then(({stdout})=>JSON.parse(stdout));
    });
    const changesFor=(actor,index)=>create('tasks',{id:'parallel-task-'+index,projectId:actor.workspaceId===unrelated?'other':'alpha',
      title:'Concurrent task',status:'todo',priority:'medium',owner:'',due:'2031-03-01',description:'',checklist:[],comments:[],dependencies:[]});
    const commits = [];
    let terminatedPid;
    const terminated = assert.rejects(transaction(async db=>{
      terminatedPid=(await db.one('SELECT pg_backend_pid() AS pid')).pid;
      await db.scopeWorkspace(owner.workspaceId,ownerScope);
      assert.deepEqual(await projectIds(db),[{id:'alpha'},{id:'beta'}]);
      await db.run("UPDATE workspaces SET name='Rolled back fixture',version=version+1 WHERE id=?",owner.workspaceId);
      await db.one('SELECT pg_terminate_backend(pg_backend_pid())');
    }),error=>['57P01','ECONNRESET'].includes(error.code));
    const reconnect = terminated.then(()=>readTransaction(async db=>{
      assert.notEqual((await db.one('SELECT pg_backend_pid() AS pid')).pid,terminatedPid);
      assert.deepEqual(await projectIds(db),[]);
      await db.scopeWorkspace(unrelated,otherOwnerScope);
      assert.deepEqual(await projectIds(db),[{id:'other'}]);
    }));
    for (let attempt=0;attempt<3;attempt++) {
      const actors = attempt%2 ? [secondOwner,workflowEditor,workflowOwner] : [workflowOwner,workflowEditor,secondOwner];
      commits.push(...actors.map(async (actor,index)=>{
        const state=await loadState(actor);
        const expected=actor.workspaceId===unrelated ? ['other'] : actor.role==='editor' ? ['alpha'] : ['alpha','beta'];
        assert.deepEqual(state.data.projects.map(project=>project.id).sort(),expected);
        return commitRecordChanges(actor,state.version,[changesFor(actor,attempt*3+index)]);
      }));
      commits.push(readTransaction(async db=>{
        await db.scopeWorkspace(owner.workspaceId,viewerScope);
        assert.deepEqual(await projectIds(db),[{id:'beta'}]);
      }));
    }
    const [[monitorRun,schedulerRun,notificationRun]]=await Promise.all([Promise.all(workers),Promise.all(commits),reconnect]);
    assert.equal(monitorRun.tested,1);
    assert.equal(typeof schedulerRun.generated,'number');
    assert.equal(notificationRun.accepted,1);
    const firstState=await loadState(workflowOwner);
    assert.notEqual(firstState.data.preferences.workspace,'Rolled back fixture');
    assert.equal(firstState.data.tasks.filter(task=>task.id.startsWith('parallel-task-')).length,6);
    assert.equal((await loadState(secondOwner)).data.tasks.filter(task=>task.id.startsWith('parallel-task-')).length,3);
    await closeDatabase();
    delete process.env.PROJECTOS_DB_SCOPE_KEY;
    process.env.PROJECTOS_DATABASE_URL=connectionFor(target);
    await sql.run('DELETE FROM workspaces WHERE id=?',unrelated);
    await sql.run('DELETE FROM users WHERE id IN (?,?)',otherOwner,viewerId);
    await sql.run("DELETE FROM records WHERE workspace_id=? AND kind='resources' AND id IN ('private-parent','shared-resource','concurrent-probe')",owner.workspaceId);
    await sql.run("DELETE FROM records WHERE workspace_id=? AND kind='tasks' AND id LIKE 'parallel-task-%'",owner.workspaceId);

    const report = JSON.parse(run('postgres-backup.mjs','backup',postgresBackup));
    assert.equal(report.encrypted, true);
    const invalidBackup = join(area, 'invalid.posbak');
    const { decryptArchive, encryptArchive, postgresHeader } = await import('./encrypted-archive.mjs');
    await encryptArchive(Readable.from([Buffer.from('Synthetic text in place of a PostgreSQL archive')]),
      invalidBackup, process.env.PROJECTOS_BACKUP_PASSPHRASE, postgresHeader);
    assert.throws(() => run('postgres-backup.mjs','restore',invalidBackup), /PostgreSQL restore catalog failed/);
    assert.throws(() => run('postgres-backup.mjs','verify',invalidBackup), /PostgreSQL restore catalog failed/);
    const catalogFixture=join(area,'verify-catalog.dump');
    await decryptArchive(postgresBackup,catalogFixture,process.env.PROJECTOS_BACKUP_PASSPHRASE,postgresHeader);
    const pgRestore=process.env.PROJECTOS_PG_BIN ? join(process.env.PROJECTOS_PG_BIN,'pg_restore') : 'pg_restore';
    // This process sees an archive seeded entirely with synthetic data. Keep production CLI diagnostics fixed and sanitized.
    const catalog=execFileSync(pgRestore,['--list',catalogFixture],{encoding:'utf8',timeout:15_000});
    assert.match(catalog,/TABLE public records\b/);
    assert.match(catalog,/TABLE public machine_observations\b/);
    assert.match(catalog,/TABLE projectos_private scope_key\b/);
    assert.match(catalog,/EXTENSION - pgcrypto\b/);
    assert.doesNotMatch(catalog,/TABLE DATA projectos_private scope_key\b/);
    const truncatedBackup=join(area,'truncated.posbak');
    const archive=readFileSync(catalogFixture);
    await encryptArchive(Readable.from([archive.subarray(0,archive.length-512)]),
      truncatedBackup,process.env.PROJECTOS_BACKUP_PASSPHRASE,postgresHeader);
    assert.throws(() => run('postgres-backup.mjs','verify',truncatedBackup),/PostgreSQL restore .*failed/);
    const verifyOffline=(filename)=>JSON.parse(execFileSync(process.execPath,[join(__dirname,'postgres-backup.mjs'),'verify',filename],{
      encoding:'utf8',env:{...process.env,PROJECTOS_DATABASE_URL:'disabled',PROJECTOS_RESTORE_URL:'disabled'},timeout:30_000,
    }));
    assert.deepEqual(verifyOffline(postgresBackup),{
      ok:true,format:'PROJECTOS-POSTGRES-v1',encrypted:true,catalogVerified:true,dataDecoded:true,
    });
    const restored = JSON.parse(run('postgres-backup.mjs','restore',postgresBackup));
    assert.equal(Number(restored.workspaces), 1);
    assert.equal(Number(restored.document_versions), 1);
    assert.equal(Number(restored.records), 6);
    assert.throws(() => run('postgres-backup.mjs','restore',postgresBackup));
    await closeDatabase();
    process.env.PROJECTOS_DATABASE_URL = connectionFor(restoreTarget);
    assert.equal(await authenticate(ownerEmail, password), uid);
    const current = await loadState(owner);
    assert.equal(current.data.projects.find(item => item.id === 'beta').next, 'independent B');
    assert.equal(current.data.secrets.find(item => item.id === 'ref').resourceId, 'vps');
    assert.equal((await sql.one('SELECT state FROM notification_outbox WHERE id=?','outbox-fixture')).state, 'delivered');
    const disks=await sql.all('SELECT disk_used_bytes,disk_total_bytes FROM machine_observations WHERE workspace_id=? ORDER BY checked_at',owner.workspaceId);
    assert.deepEqual(disks,[{disk_used_bytes:null,disk_total_bytes:null},{disk_used_bytes:6144,disk_total_bytes:8192}]);
    const {reconcileReminders,reminderAlertId}=await import('./reminder-scheduler.mjs');
    const scan=clock=>reconcileReminders({clock:new Date(clock),channels:['email'],notificationWorkspace:owner.workspaceId});
    const vps=current.data.resources.find(item=>item.id==='vps');
    assert.equal(vps.noticeDays,2);
    await scan('2031-03-02T10:00:00Z');
    const old='email-'+reminderAlertId(owner.workspaceId,'تمدید',vps.id,vps.expires,'resources');
    assert.equal((await sql.one('SELECT state FROM notification_outbox WHERE id=?',old)).state,'pending');
    const moved={...vps,expires:'2031-03-05'};
    await commitRecordChanges(owner,(await loadState(owner)).version,[{kind:'resources',id:vps.id,action:'replace',record:moved}]);
    assert.equal((await sql.one('SELECT state FROM notification_outbox WHERE id=?',old)).state,'cancelled');
    await scan('2031-03-03T10:00:00Z');
    const next='email-'+reminderAlertId(owner.workspaceId,'تمدید',vps.id,moved.expires,'resources');
    assert.equal((await sql.one('SELECT state FROM notification_outbox WHERE id=?',next)).state,'pending');

    const invoice={id:'invoice',projectId:'alpha',reference:'FIX-01',title:'Fixture invoice',direction:'receivable',
      currency:'USD',amountUnit:'minor',amount:1250,issuedOn:'2031-03-01',dueOn:'2031-04-01',state:'open',
      installments:[{dueOn:'2031-03-15',amount:500},{dueOn:'2031-04-01',amount:750}]};
    const revision=await commitRecordChanges(owner,(await loadState(owner)).version,[create('invoices',invoice)]);
    const payment={id:'payment-one',projectId:'alpha',invoiceId:invoice.id,reference:'FIX-P۱',
      currency:'USD',amountUnit:'minor',amount:500,paidOn:'2031-03-10'};
    const results=await Promise.allSettled([
      commitRecordChanges(owner,revision,[create('payments',payment)]),
      commitRecordChanges(owner,revision,[create('payments',{...payment,id:'payment-duplicate',reference:'fix-p1'})]),
    ]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.match(results.find(result=>result.status==='rejected').reason.message,/Duplicate payment reference/);
    const afterPayment=await loadState(owner);
    assert.equal(afterPayment.data.payments.length,1);
    assert.equal(afterPayment.data.payments[0].amount,500);
    await assert.rejects(commitRecordChanges(owner,afterPayment.version,[create('payments',{
      ...payment,id:'wrong-currency',reference:'new-ref',currency:'IRR',
    })]),/incompatible/);
    await assert.rejects(commitRecordChanges(owner,afterPayment.version,[create('payments',{
      ...payment,id:'overpayment',reference:'over-ref',amount:751,
    })]),/exceed/);
    const saved=afterPayment.data.payments[0];
    await assert.rejects(commitRecordChanges(owner,afterPayment.version,[{kind:'payments',id:saved.id,action:'delete'}]),/immutable/);
    await assert.rejects(commitRecordChanges(owner,afterPayment.version,[{kind:'invoices',id:invoice.id,action:'replace',
      record:{...invoice,direction:'payable'}}]),/only be voided/);
    await assert.rejects(commitRecordChanges(owner,afterPayment.version,[{kind:'invoices',id:invoice.id,action:'replace',
      record:{...invoice,state:'void'}}]),/incompatible/);
    assert.equal((await loadState(owner)).version,afterPayment.version);
    const unpaid={...invoice,id:'unpaid-invoice',reference:'UNPAID-01'};
    const unpaidVersion=await commitRecordChanges(owner,afterPayment.version,[create('invoices',unpaid)]);
    const voidedVersion=await commitRecordChanges(owner,unpaidVersion,[{kind:'invoices',id:unpaid.id,action:'replace',
      record:{...unpaid,state:'void'}}]);
    await assert.rejects(commitRecordChanges(owner,voidedVersion,[{kind:'invoices',id:unpaid.id,action:'replace',
      record:unpaid}]),/only be voided/);
    assert.equal((await loadState(owner)).data.invoices.find(row=>row.id===unpaid.id).state,'void');
    const quote={id:'fixture-rate',projectId:'beta',from:'USD',to:'IRR',rate:'8421.25',
      source:'Synthetic fixture statement',observedAt:'2026-01-15T00:00:00.000Z'};
    const ratesVersion=await commitRecordChanges(owner,voidedVersion,[create('exchangeRates',quote)]);
    const limited=await accountByUser(editorId);
    assert.deepEqual((await loadState(limited)).data.exchangeRates,[]);
    await assert.rejects(commitRecordChanges(limited,ratesVersion,[create('exchangeRates',{
      ...quote,id:'blocked-rate',projectId:'alpha',
    })]),/permission/);
    await assert.rejects(commitRecordChanges(owner,ratesVersion,[{kind:'exchangeRates',id:quote.id,action:'delete'}]),/immutable/);
    const ledgerRestore='projectos_restore_ledger_'+suffix;
    await admin.query('CREATE DATABASE "'+ledgerRestore+'"');
    created.push(ledgerRestore);
    process.env.PROJECTOS_RESTORE_URL=connectionFor(ledgerRestore);
    const ledgerBackup=join(area,'ledger.posbak');
    assert.equal(JSON.parse(run('postgres-backup.mjs','backup',ledgerBackup)).ok,true);
    assert.equal(verifyOffline(ledgerBackup).dataDecoded,true);
    assert.equal(JSON.parse(run('postgres-backup.mjs','restore',ledgerBackup)).ok,true);
    await closeDatabase();
    process.env.PROJECTOS_DATABASE_URL=connectionFor(ledgerRestore);
    const restoredLedger=(await loadState(owner)).data;
    assert.deepEqual(restoredLedger.payments,[saved]);
    assert.equal(restoredLedger.invoices.find(row=>row.id===unpaid.id).state,'void');
    assert.deepEqual(restoredLedger.exchangeRates,[quote]);
    const deliveryPassword = randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE "${deliveryRole}" LOGIN PASSWORD '${deliveryPassword}'`);
    deliveryCreated = true;
    const otherWorkspace='delivery-other-'+suffix;
    const stamp=new Date().toISOString();
    await sql.run('INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)',otherWorkspace,'Synthetic other workspace',stamp);
    for (const [id,workspace] of [['allowed-delivery',owner.workspaceId],['hidden-delivery',otherWorkspace]]) {
      await sql.run(`INSERT INTO notification_outbox(id,workspace_id,reminder_id,scheduled_for,channel,state,created_at)
        VALUES(?,?,?,'2031-03-01','telegram','pending',?)`,id,workspace,'fixture',stamp);
    }
    execFileSync(psql,['-X','-h',url.hostname,'-p',url.port||'5432','-U',decodeURIComponent(url.username),
      '-d',ledgerRestore,'-f',join(__dirname,'../schema/postgres/grant-delivery.sql'),
      '-v','delivery_role='+deliveryRole,'-v','workspace_id='+owner.workspaceId],psqlOptions);
    await closeDatabase();
    const deliveryUrl=new URL(connectionFor(ledgerRestore));
    deliveryUrl.username=deliveryRole;
    deliveryUrl.password=deliveryPassword;
    process.env.PROJECTOS_DATABASE_URL=deliveryUrl.href;
    const {deliverNotifications}=await import('./notification-delivery.mjs');
    const sent=[];
    const delivery=await deliverNotifications(owner.workspaceId,{telegram:async job=>{sent.push(job.id);return true;}});
    assert.equal(delivery.accepted,1);
    assert.deepEqual(sent,['allowed-delivery']);
    assert.equal(await sql.one("SELECT id FROM notification_outbox WHERE id='hidden-delivery'"),undefined);
    await assert.rejects(deliverNotifications(otherWorkspace,{telegram:async()=>true}),/Unknown notification workspace/);
    await assert.rejects(sql.all('SELECT id FROM records'),{code:'42501'});
    await assert.rejects(sql.run("UPDATE notification_outbox SET reminder_id='blocked'"),{code:'42501'});
    await assert.rejects(sql.run("INSERT INTO worker_heartbeats(name,checked_at) VALUES('forbidden',?)",stamp),{code:'42501'});

    const monitorPassword=randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE "${monitorRole}" LOGIN PASSWORD '${monitorPassword}'`);
    monitorCreated=true;
    const targetAdmin=new Client({connectionString:connectionFor(ledgerRestore)});
    const monitorUrl=new URL(connectionFor(ledgerRestore));
    monitorUrl.username=monitorRole;
    monitorUrl.password=monitorPassword;
    const monitor=new Client({connectionString:monitorUrl.href});
    try {
      await targetAdmin.connect();
      const sample={id:'probe-resource',projectId:'alpha',address:'https://127.0.0.1'};
      await targetAdmin.query(`INSERT INTO records(workspace_id,kind,id,project_id,payload,updated_at)
        VALUES($1,'resources',$2,'alpha',$3,$4)`,[owner.workspaceId,sample.id,JSON.stringify(sample),stamp]);
      execFileSync(psql,['-X','-h',url.hostname,'-p',url.port||'5432','-U',decodeURIComponent(url.username),
        '-d',ledgerRestore,'-f',join(__dirname,'../schema/postgres/grant-monitor.sql'),
        '-v','monitor_role='+monitorRole,'-v','workspace_id='+owner.workspaceId],psqlOptions);
      const workerResult=()=>JSON.parse(execFileSync(process.execPath,[join(__dirname,'run-monitors.mjs')],{
        encoding:'utf8',timeout:30_000,env:{...process.env,PROJECTOS_DATABASE_URL:monitorUrl.href,
          PROJECTOS_MONITOR_WORKSPACE:owner.workspaceId,PROJECTOS_MONITOR_HOSTS:'127.0.0.1'},
      }));
      assert.equal(workerResult().tested,1);
      assert.equal(workerResult().tested,1);
      await monitor.connect();
      assert.equal((await monitor.query('SELECT id FROM workspaces WHERE id=$1',[otherWorkspace])).rowCount,0);
      assert.equal((await monitor.query("SELECT state FROM monitor_observations WHERE resource_id='probe-resource'")).rowCount,2);
      assert.equal((await monitor.query("SELECT id FROM records WHERE kind='docs'")).rowCount,0);
      await assert.rejects(monitor.query('SELECT id FROM users'),{code:'42501'});
      await assert.rejects(monitor.query('UPDATE records SET record_version=1'),{code:'42501'});
      await targetAdmin.query('DELETE FROM projectos_private.monitor_logins');
      assert.equal((await monitor.query('SELECT id FROM workspaces')).rowCount,0);
      assert.equal((await monitor.query('SELECT id FROM monitor_observations')).rowCount,0);
    } finally {
      await monitor.end();
      await targetAdmin.end();
    }
    const reminderPassword=randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE "${reminderRole}" LOGIN PASSWORD '${reminderPassword}'`);
    reminderCreated=true;
    execFileSync(psql,['-X','-h',url.hostname,'-p',url.port||'5432','-U',decodeURIComponent(url.username),
      '-d',ledgerRestore,'-f',join(__dirname,'../schema/postgres/grant-reminder.sql'),
      '-v','reminder_role='+reminderRole,'-v','workspace_id='+owner.workspaceId],psqlOptions);
    const scopedAdmin=new Client({connectionString:connectionFor(ledgerRestore)});
    try {
      await scopedAdmin.connect();
      await scopedAdmin.query(`UPDATE records SET payload=(payload::jsonb || '{"rotationDue":"2031-03-04"}')::text
        WHERE kind='secrets' AND workspace_id=$1`,[owner.workspaceId]);
    } finally { await scopedAdmin.end(); }
    await closeDatabase();
    const reminderUrl=new URL(connectionFor(ledgerRestore));
    reminderUrl.username=reminderRole;
    reminderUrl.password=reminderPassword;
    process.env.PROJECTOS_DATABASE_URL=reminderUrl.href;
    assert.equal(await sql.one('SELECT id FROM workspaces WHERE id=?',otherWorkspace),undefined);
    assert.equal(await sql.one("SELECT id FROM records WHERE kind='secrets'"),undefined);
    const rotation=await sql.one('SELECT payload FROM public.projectos_rotation_deadlines()');
    assert.deepEqual(JSON.parse(rotation.payload),{projectId:'alpha',rotationDue:'2031-03-04'});
    const reminderRun=await scan('2031-03-04T10:00:00Z');
    assert.ok(reminderRun.generated>0);
    await closeDatabase();
    assert.equal((await scan('2031-03-04T10:00:00Z')).generated,0);
    assert.equal(await sql.one("SELECT id FROM notification_outbox WHERE id='hidden-delivery'"),undefined);
    await assert.rejects(sql.run("UPDATE notification_outbox SET delivered_at=now()"),{code:'42501'});
    await assert.rejects(sql.all('SELECT id FROM users'),{code:'42501'});
    const faultAdmin=new Client({connectionString:connectionFor(ledgerRestore)});
    await faultAdmin.connect();
    try {
      const {reminderAlertId}=await import('./reminder-scheduler.mjs');
      const fixture={id:'transaction-reminder',title:'Synthetic transaction reminder',projectId:'alpha',
        kind:'یادآوری',due:'2031-03-06',zone:'UTC',noticeDays:0};
      await faultAdmin.query(`INSERT INTO records(workspace_id,kind,id,project_id,payload,updated_at)
        VALUES($1,'reminders',$2,'alpha',$3,$4)`,[owner.workspaceId,fixture.id,JSON.stringify(fixture),stamp]);
      const incident=reminderAlertId(owner.workspaceId,fixture.kind,fixture.id,fixture.due,'reminders');
      assert.match(incident,/^auto-[a-f0-9]{28}$/);
      const version=async () => (await faultAdmin.query('SELECT version FROM workspaces WHERE id=$1',[owner.workspaceId])).rows[0].version;
      const previous=await version();
      await faultAdmin.query("ALTER TABLE notification_outbox ADD CONSTRAINT test_reject_reminder CHECK (id <> '"+incident+"')");
      try {
        await assert.rejects(scan('2031-03-06T10:00:00Z'),{code:'23514'});
        assert.equal((await faultAdmin.query("SELECT id FROM records WHERE kind='incidents' AND id=$1",[incident])).rowCount,0);
        assert.equal((await faultAdmin.query('SELECT id FROM notification_outbox WHERE id=$1',[incident])).rowCount,0);
        assert.equal(await version(),previous);
      } finally { await faultAdmin.query('ALTER TABLE notification_outbox DROP CONSTRAINT test_reject_reminder'); }
      const session=await getPostgresPool().connect();
      try {
        await session.query('BEGIN');
        const {pid}=(await session.query('SELECT pg_backend_pid() AS pid')).rows[0];
        await session.query('UPDATE workspaces SET version=version+1 WHERE id=$1',[owner.workspaceId]);
        const disconnected=once(session,'error');
        const result=await faultAdmin.query('SELECT pg_terminate_backend($1) AS stopped',[pid]);
        assert.equal(result.rows[0].stopped,true);
        assert.equal((await disconnected)[0].code,'57P01');
      } finally { session.release(true); }
      assert.equal(await version(),previous);
      await closeDatabase();
      await scan('2031-03-06T10:00:00Z');
      assert.equal((await faultAdmin.query('SELECT id FROM notification_outbox WHERE id=$1',[incident])).rowCount,1);
    } finally { await faultAdmin.end(); }
  } finally {
    await closeDatabase();
    for (const db of created.reverse()) await admin.query('DROP DATABASE "' + db + '"');
    if (runtimeCreated) await admin.query('DROP ROLE "' + runtimeRole + '"');
    if (deliveryCreated) await admin.query('DROP ROLE "' + deliveryRole + '"');
    if (monitorCreated) await admin.query('DROP ROLE "' + monitorRole + '"');
    if (reminderCreated) await admin.query('DROP ROLE "' + reminderRole + '"');
    for (const role of createdRoles) await admin.query('DROP ROLE "' + role + '"');
    await admin.end();
    rmSync(area, { recursive:true, force:true, maxRetries:5 });
  }
});
