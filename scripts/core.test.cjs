/* eslint-disable @typescript-eslint/no-require-imports -- Node CJS hook for testing TS in offline environment */
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const ts=require('typescript');
// Exercise TypeScript domain modules without introducing an extra runtime dependency in the offline audit environment.
require.extensions['.ts']=(mod,file)=>{
  const source=fs.readFileSync(file,'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  mod._compile(compiled,file);
};
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'projectos-verify-'));
process.env.PROJECTOS_DATABASE_URL='';
process.env.PROJECTOS_DB_PATH=path.join(temp,'test.sqlite');
process.env.PROJECTOS_SETUP_TOKEN='t'.repeat(40);
process.env.PROJECTOS_MFA_ENCRYPTION_KEY='a'.repeat(64);
process.env.PROJECTOS_ALLOW_PLAINTEXT_BACKUP='test-only';
const {getDb,loadState,saveState,VersionConflictError,userCount}=require('../src/lib/server/db.ts');
const {parseState,ValidationError}=require('../src/lib/server/validation.ts');
const {setupOwner,authenticate,newSession}=require('../src/lib/server/auth.ts');
const {beginMfa,confirmMfa,verifyMfa,mfaEnabled,totp}=require('../src/lib/server/mfa.ts');
const {mutateRecord}=require('../src/lib/server/record-service.ts');
let owner;
const project=(id)=>({id,name:id,subtitle:'',coverTitle:id,description:'',status:'building',type:'وب‌سایت',progress:0,next:'',art:'navigation/projects'});
const task=(id,pid)=>({id,title:id,projectId:pid,status:'todo',priority:'medium',owner:'test',due:'2026-11-20',description:'',checklist:[],comments:[],dependencies:[]});

test('first account requires one-time server-side setup token and hashed password',async ()=>{
  assert.equal((await userCount()),0);
  await assert.rejects(async ()=>(await setupOwner({setupToken:'bad',email:'one@example.com',password:'a'.repeat(16),displayName:'Owner',workspace:'Private'})));
  const uid=(await setupOwner({setupToken:'t'.repeat(40),email:'one@example.com',password:'verystrong-password-2026',displayName:'Owner',workspace:'Private'}));
  assert.equal((await userCount()),1);
  await assert.rejects(async ()=>(await setupOwner({setupToken:'t'.repeat(40),email:'two@example.com',password:'verystrong-password-2026',displayName:'Other',workspace:'Other'})));
  assert.equal((await authenticate('one@example.com','verystrong-password-2026')),uid);
  assert.equal((await authenticate('one@example.com','incorrect-password')),null);
  const row=getDb().prepare('SELECT password_hash,salt FROM users WHERE id=?').get(uid);
  assert.ok(row.password_hash.length>=64);
  assert.ok(!JSON.stringify(row).includes('verystrong-password'));
  assert.equal((await newSession(uid)).length>20,true);
  owner=getDb().prepare("SELECT u.id,u.email,u.display_name AS displayName,m.workspace_id AS workspaceId,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=?").get(uid);
});

test('persistent project, resource, task and docs survive DB reload with cross-collection integrity',async ()=>{
  const initial=(await loadState(owner));
  assert.equal(initial.version,0);
  const value=structuredClone(initial.data);
  value.projects=[project('a'),project('b')];
  value.tasks=[task('t1','a')];
  value.resources=[{id:'srv',name:'Server',projectId:'a',linkedProjectIds:['b'],type:'server',address:'203.0.113.23',environment:'Production',status:'registered',provider:'Provider',port:22,tags:[]}];
  value.docs=[{id:'doc',title:'Runbook',projectId:'a',type:'Runbook',body:'No actual credentials.',revision:1,updated:'2026-11-18'}];
  const clean=parseState(value);
  const version=(await saveState(owner,0,clean));
  assert.equal(version,1);
  const loaded=(await loadState(owner));
  assert.equal(loaded.data.projects.length,2);
  assert.equal(loaded.data.resources[0].linkedProjectIds[0],'b');
  assert.equal(loaded.data.docs[0].body,'No actual credentials.');
  assert.equal(loaded.data.events.length,5);
  await assert.rejects(async ()=>(await saveState(owner,0,clean)),VersionConflictError);
});

test('server rejects extra secret values, cross-project relations, invalid dates and dependency cycles',async ()=>{
  const state=(await loadState(owner)).data;
  const copy=structuredClone(state);
  copy.secrets=[{id:'s',name:'SSH',projectId:'a',type:'SSH Key',vaultProvider:'Infisical',privateKey:'DO_NOT_STORE'}];
  assert.throws(()=>parseState(copy),ValidationError);
  copy.secrets=[];
  copy.tasks[0].projectId='not-owned-by-workspace';
  assert.throws(()=>parseState(copy),ValidationError);
  copy.tasks[0].projectId='a';
  copy.tasks.push(task('t2','a'));
  copy.tasks[0].dependencies=['t2'];copy.tasks[1].dependencies=['t1'];
  assert.throws(()=>parseState(copy),ValidationError);
  copy.tasks[0].dependencies=[];copy.tasks[1].dependencies=[];
  copy.resources[0].address='https://admin:password@example.com';
  assert.throws(()=>parseState(copy),ValidationError);
});

test('workspace reads and writes are isolated by owner workspace membership',async ()=>{
  const db=getDb();
  const uid=crypto.randomUUID(),ws=crypto.randomUUID();
  db.prepare('INSERT INTO users(id,email,display_name,password_hash,salt,created_at) VALUES(?,?,?,?,?,?)').run(uid,'two@example.com','Second','x'.repeat(128),'s',new Date().toISOString());
  db.prepare('INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)').run(ws,'Second',new Date().toISOString());
  db.prepare('INSERT INTO memberships(user_id,workspace_id,role) VALUES(?,?,?)').run(uid,ws,'owner');
  const secondary={id:uid,email:'two@example.com',displayName:'Second',workspaceId:ws,role:'owner'};
  assert.equal((await loadState(secondary)).data.projects.length,0);
  const updated=structuredClone((await loadState(secondary)).data);updated.projects=[project('z')];
  (await saveState(secondary,0,parseState(updated)));
  assert.equal((await loadState(owner)).data.projects.length,2);
  assert.equal((await loadState(secondary)).data.projects[0].name,'z');
  await assert.rejects(async ()=>(await saveState({...owner,role:'viewer'},1,parseState((await loadState(owner)).data))));
});

test('local reminder worker deduplicates delivery and backup passes integrity check',async ()=>{
  const current=(await loadState(owner));
  const value=structuredClone(current.data);
  const due=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  value.reminders=[{id:'renewal-1',title:'Renew VPS',projectId:'a',kind:'تمدید',due}];
  (await saveState(owner,current.version,parseState(value)));
  const exec=(script,args=[])=>execFileSync(process.execPath,[path.join(__dirname,script),...args],{env:{...process.env},encoding:'utf8'});
  const first=JSON.parse(exec('run-reminders.mjs'));assert.equal(first.generated,1);
  const second=JSON.parse(exec('run-reminders.mjs'));assert.equal(second.generated,0);
  assert.equal((await loadState(owner)).data.incidents.length,1);
  const backupPath=path.join(temp,'backup.sqlite');
  exec('backup.mjs',[backupPath]);
  const report=exec('verify-backup.mjs',[backupPath]);assert.match(report,/"integrity": "ok"/);
  assert.match(exec('restore-dry-run.mjs',[backupPath]),/"ok":true/);
});

test('rejects impossible calendar dates and resource parent cycles',async ()=>{
  const original=(await loadState(owner)).data;
  const invalid=structuredClone(original);
  invalid.tasks[0].due='2026-02-30';
  assert.throws(()=>parseState(invalid),ValidationError);
  invalid.tasks[0].due='2026-11-20';
  invalid.resources=[
    {id:'ra',name:'A',projectId:'a',type:'server',address:'203.0.113.4',environment:'Production',status:'registered',provider:'P',tags:[],parentId:'rb'},
    {id:'rb',name:'B',projectId:'a',type:'server',address:'203.0.113.5',environment:'Production',status:'registered',provider:'P',tags:[],parentId:'ra'}
  ];
  assert.throws(()=>parseState(invalid),ValidationError);
});

test('rescheduled reminders retire old alerts and keep unrelated reminders when renewals disabled',async ()=>{
  const exec=(script,args=[])=>JSON.parse(execFileSync(process.execPath,[path.join(__dirname,script),...args],{env:{...process.env},encoding:'utf8'}));
  const current=(await loadState(owner));
  const value=structuredClone(current.data);
  // Replace due date for the previously triggered reminder.
  value.reminders=[{id:'renewal-1',title:'Renew VPS',projectId:'a',kind:'تمدید',due:'2099-10-20'}];
  (await saveState(owner,current.version,parseState(value)));
  const result=exec('run-reminders.mjs');
  assert.equal(result.retired,1);
  assert.equal((await loadState(owner)).data.incidents.filter(i=>i.id.startsWith('auto-')).length,0);
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const latest=(await loadState(owner));
  const followup=structuredClone(latest.data);
  followup.preferences.renewal=false;
  followup.reminders=[{id:'general-1',title:'Check project',projectId:'a',kind:'یادآوری',due:today}];
  (await saveState(owner,latest.version,parseState(followup)));
  assert.equal(exec('run-reminders.mjs').generated,1);
  assert.equal((await loadState(owner)).data.incidents.filter(i=>i.id.startsWith('auto-')).length,1);
});

test('audit preserves the actor name at time of edit and incremental writes preserve unrelated records',async ()=>{
  const before=(await loadState(owner));
  const next=structuredClone(before.data);
  next.preferences.displayName='Renamed Owner';
  next.tasks[0].description='Edited via safe incremental update';
  (await saveState(owner,before.version,parseState(next)));
  const result=(await loadState(owner));
  assert.equal(result.data.events.find(e=>e.title==='t1').actor,'Owner');
  assert.equal(result.data.tasks[0].description,'Edited via safe incremental update');
});

test('MFA seed is encrypted, enrollment requires valid code, and accepted TOTP cannot be replayed',async ()=>{
  const started=(await beginMfa(owner.id,owner.email));
  assert.equal(started.secret.length,32);
  const row=getDb().prepare('SELECT mfa_pending FROM users WHERE id=?').get(owner.id);
  assert.ok(!row.mfa_pending.includes(started.secret));
  assert.equal((await confirmMfa(owner.id,'000000')),false);
  assert.equal((await confirmMfa(owner.id,totp(started.secret))),true);
  assert.equal((await mfaEnabled(owner.id)),true);
  // Confirm consumed current time step; replaying same code must be rejected.
  assert.equal((await verifyMfa(owner.id,totp(started.secret))),false);
  assert.equal((await verifyMfa(owner.id,'nope')),false);
});

test('single-record writes enforce version, ownership, project foreign keys, and integer finance values',async ()=>{
  const state=(await loadState(owner));
  const charge={id:'hosting-charge',projectId:'a',title:'Monthly hosting',provider:'Provider',amount:245000,currency:'TOMAN',period:'monthly',nextDue:'2026-12-01',status:'active'};
  await assert.rejects(async ()=>(await mutateRecord({...owner,role:'viewer'},state.version,'charges',charge.id,'create',charge)));
  await assert.rejects(async ()=>(await mutateRecord(owner,state.version,'charges',charge.id,'create',{...charge,amount:123.5})),ValidationError);
  const version=(await mutateRecord(owner,state.version,'charges',charge.id,'create',charge));
  assert.equal((await loadState(owner)).data.charges[0].amount,245000);
  await assert.rejects(async ()=>(await mutateRecord(owner,state.version,'charges','other','create',{...charge,id:'other'})),VersionConflictError);
  const revenue={id:'rev-1',projectId:'a',title:'Contract payment',amount:1000000,currency:'TOMAN',date:'2026-11-18',status:'received'};
  (await mutateRecord(owner,version,'revenues',revenue.id,'create',revenue));
  assert.equal((await loadState(owner)).data.revenues.length,1);
});

test('encrypted backup verifies with correct key and refuses incorrect key without overwriting database',async ()=>{
  const pathTo=path.join(temp,'encrypted.posbak');
  const env={...process.env,PROJECTOS_BACKUP_PASSPHRASE:'test-passphrase-long-enough-for-validation-2026'};
  const run=(script,environment)=>execFileSync(process.execPath,[path.join(__dirname,script),pathTo],{env:environment,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.match(run('encrypted-backup.mjs',env),/"encrypted":true/);
  assert.match(run('verify-encrypted-backup.mjs',env),/"ok":true/);
  assert.throws(()=>run('verify-encrypted-backup.mjs',{...env,PROJECTOS_BACKUP_PASSPHRASE:'incorrect-test-passphrase-with-enough-length'}));
  assert.equal((await loadState(owner)).data.projects.length,2);
});

after(()=>{
  try {getDb().close();}catch{}
  try{fs.rmSync(temp,{recursive:true,force:true});}catch{}
});

test('credential guard rejects apparent secrets in free-text documents and comments without disclosing values',async ()=>{
  const {suspiciousCredential,redactCredentials}=require('../src/lib/server/credential-guard.ts');
  assert.equal(suspiciousCredential('password: high-entropy-test-password'),true);
  assert.equal(suspiciousCredential('API_KEY=abcd1234567890'),true);
  assert.equal(suspiciousCredential('No actual credentials.'),false);
  const current=(await loadState(owner)).data;
  const value=structuredClone(current);
  value.docs[0].body='server password: highlySecretValue123!';
  assert.throws(()=>parseState(value),ValidationError);
  value.docs[0].body='Safe runbook with no credentials';
  value.tasks[0].comments.push({text:'token: do_not_share_this_token',date:'2026-11-18'});
  assert.throws(()=>parseState(value),ValidationError);
  assert.ok(!redactCredentials('token: do_not_share_this_token').includes('do_not_share_this_token'));
});

test('expense amounts reject decimals and non-finite values before persistence',async ()=>{
  const current=(await loadState(owner)).data;
  const value=structuredClone(current);
  const expense={id:'ex-test',title:'Hosting',projectId:'a',category:'زیرساخت',amount:123.45,date:'2026-11-18',status:'paid'};
  value.expenses=[expense];
  assert.throws(()=>parseState(value),ValidationError);
  expense.amount=123;
  assert.equal(parseState(value).expenses[0].amount,123);
});

test('MFA recovery codes are random, stored as hashes, single-use and revoke existing sessions',async ()=>{
  const {issueRecoveryCodes,verifyRecoveryCode,remainingRecoveryCodes}=require('../src/lib/server/mfa.ts');
  const codes=(await issueRecoveryCodes(owner.id));
  assert.equal(codes.length,10);
  assert.equal(new Set(codes).size,10);
  assert.equal((await remainingRecoveryCodes(owner.id)),10);
  const row=getDb().prepare('SELECT code_hash FROM mfa_recovery_codes WHERE user_id=?').get(owner.id);
  assert.ok(!codes.includes(row.code_hash));
  const token=(await newSession(owner.id));
  assert.ok(token.length>10);
  assert.equal((await verifyRecoveryCode(owner.id,codes[0])),true);
  assert.equal((await verifyRecoveryCode(owner.id,codes[0])),false);
  assert.equal((await remainingRecoveryCodes(owner.id)),9);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(owner.id).n,0);
});

test('plaintext backup requires test-only explicit opt-in to avoid accidental database export',()=>{
  const out=path.join(temp,'refused.sqlite');
  const result=require('node:child_process').spawnSync(process.execPath,[path.join(__dirname,'backup.mjs'),out],{
    encoding:'utf8',env:{...process.env,PROJECTOS_ALLOW_PLAINTEXT_BACKUP:''}
  });
  assert.equal(result.status,2);
  assert.equal(fs.existsSync(out),false);
});

test('workspace invitation is one-time, email-bound, short-lived and grants editor only assigned record kinds',async ()=>{
  const {createInvitation,acceptInvitation,listInvitations,removeMember}=require('../src/lib/server/invitations.ts');
  const invite=(await createInvitation(owner,'editor@example.test','editor'));
  assert.equal(invite.token.length,43);
  assert.equal((await listInvitations(owner)).some(i=>i.id===invite.id&&i.active),true);
  await assert.rejects(async ()=>(await acceptInvitation({token:invite.token,email:'attacker@example.test',displayName:'Intruder',password:'valid-password-123456'})));
  const memberId=(await acceptInvitation({token:invite.token,email:'editor@example.test',displayName:'Editor',password:'valid-password-123456'}));
  await assert.rejects(async ()=>(await acceptInvitation({token:invite.token,email:'editor@example.test',displayName:'Editor',password:'valid-password-123456'})));
  const {accountByUser, ForbiddenError}=require('../src/lib/server/db.ts');
  const editor=(await accountByUser(memberId));
  assert.equal(editor.role,'editor');
  assert.equal((await loadState(editor)).data.users[0].name,'Editor');
  await assert.rejects(async ()=>(await saveState(editor,(await loadState(editor)).version,parseState((await loadState(editor)).data))),ForbiddenError);
  const current=(await loadState(editor));
  await assert.rejects(async ()=>(await mutateRecord(editor,current.version,'projects','a','delete')),ForbiddenError);
  const newTask=task('edited-task','a');
  const updated=(await mutateRecord(editor,current.version,'tasks',newTask.id,'create',newTask));
  assert.equal(updated,current.version+1);
  assert.equal((await loadState(owner)).data.tasks.some(t=>t.id==='edited-task'),true);
  const session=(await newSession(memberId));
  assert.equal((await removeMember(owner,memberId)),true);
  assert.equal((await accountByUser(memberId)),null);
  assert.equal(getDb().prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(memberId).n,0);
  assert.ok(session.length>20);
});

test('revoked invitations and forbidden non-owner invitations fail closed',async ()=>{
  const {createInvitation,revokeInvitation,acceptInvitation,InvitationError}=require('../src/lib/server/invitations.ts');
  const invite=(await createInvitation(owner,'viewer@example.test','viewer'));
  assert.equal((await revokeInvitation(owner,invite.id)),true);
  assert.equal((await revokeInvitation(owner,invite.id)),false);
  await assert.rejects(async ()=>(await acceptInvitation({token:invite.token,email:'viewer@example.test',displayName:'Viewer',password:'valid-password-123456'})),InvitationError);
  await assert.rejects(async ()=>(await createInvitation({...owner,role:'editor'},'third@example.test','viewer')));
  await assert.rejects(async ()=>(await createInvitation(owner,'owner@example.test','owner')),InvitationError);
});

test('previously removed member can rejoin only with fresh invitation and correct prior password',async ()=>{
  const {createInvitation,acceptInvitation}=require('../src/lib/server/invitations.ts');
  const invite=(await createInvitation(owner,'editor@example.test','viewer'));
  const beforeFailures=getDb().prepare('SELECT failed_logins AS fails FROM users WHERE email=?').get('editor@example.test').fails;
  await assert.rejects(async ()=>(await acceptInvitation({token:invite.token,email:'editor@example.test',displayName:'Editor',password:'incorrect-new-pass'})));
  const afterFailures=getDb().prepare('SELECT failed_logins AS fails FROM users WHERE email=?').get('editor@example.test').fails;
  assert.equal(afterFailures,beforeFailures+1,'Invalid invitation-password attempts must not bypass lockout accounting');
  const rejoined=(await acceptInvitation({token:invite.token,email:'editor@example.test',displayName:'Editor',password:'valid-password-123456'}));
  assert.equal((await require('../src/lib/server/db.ts').accountByUser(rejoined)).role,'viewer');
});

test('vault references accept only known HTTPS provider hosts and never arbitrary credentials URLs',async ()=>{
  const {vaultLink}=require('../src/lib/vault-link.ts');
  assert.ok(vaultLink('https://start.1password.com/open/i?i=test'));
  assert.equal(vaultLink('https://evil.example/steal'),null);
  assert.equal(vaultLink('http://start.1password.com/item'),null);
  assert.equal(vaultLink('https://admin:password@start.1password.com/item'),null);
  const value=structuredClone((await loadState(owner)).data);
  value.secrets=[{id:'vault-ref',name:'SSH',projectId:'a',type:'SSH Key',vaultProvider:'1Password',externalRef:'https://evil.example/steal'}];
  assert.throws(()=>parseState(value),ValidationError);
  value.secrets[0].externalRef='https://start.1password.com/open/i?i=test';
  assert.equal(parseState(value).secrets.length,1);
});

test('legacy credential-like values are redacted before any workspace state is returned',async ()=>{
  const db=getDb(),doc=db.prepare("SELECT payload FROM records WHERE workspace_id=? AND kind='docs' AND id='doc'").get(owner.workspaceId);
  const value=JSON.parse(doc.payload);value.body='password: very-real-test-sample';
  db.prepare("UPDATE records SET payload=? WHERE workspace_id=? AND kind='docs' AND id='doc'").run(JSON.stringify(value),owner.workspaceId);
  const loaded=(await loadState(owner));
  assert.ok(!loaded.data.docs.find(d=>d.id==='doc').body.includes('very-real-test-sample'));
  db.prepare("UPDATE records SET payload=? WHERE workspace_id=? AND kind='docs' AND id='doc'").run(doc.payload,owner.workspaceId);
});

test('legacy secret remediation scans without revealing values and only applies after verified encrypted backup',()=>{
  const db=getDb();const original=db.prepare("SELECT payload FROM records WHERE workspace_id=? AND kind='docs' AND id='doc'").get(owner.workspaceId);
  const legacy=JSON.parse(original.payload);legacy.body='password: prior-sensitive-value';
  db.prepare("UPDATE records SET payload=? WHERE workspace_id=? AND kind='docs' AND id='doc'").run(JSON.stringify(legacy),owner.workspaceId);
  const script=path.join(__dirname,'sanitize-legacy-secrets.cjs');
  const env={...process.env,PROJECTOS_BACKUP_PASSPHRASE:'strong-backup-phrase-for-test-2026'};
  const dry=require('node:child_process').spawnSync(process.execPath,[script],{env,cwd:temp,encoding:'utf8'});
  assert.equal(dry.status,0,dry.stderr);
  const preview=JSON.parse(dry.stdout);
  assert.ok(preview.potentiallySensitiveRecords>=1);
  assert.ok(!dry.stdout.includes('prior-sensitive-value'));
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM records WHERE workspace_id=? AND kind='docs' AND id='doc'").get(owner.workspaceId).payload).body,legacy.body);
  const apply=require('node:child_process').spawnSync(process.execPath,[script,'--apply'],{env,cwd:temp,encoding:'utf8'});
  assert.equal(apply.status,0,apply.stderr);
  assert.equal(JSON.parse(apply.stdout).encryptedBackupCreated,true);
  const restored=JSON.parse(db.prepare("SELECT payload FROM records WHERE workspace_id=? AND kind='docs' AND id='doc'").get(owner.workspaceId).payload);
  assert.equal(restored.body.includes('prior-sensitive-value'),false);
  assert.ok(fs.readdirSync(path.join(temp,'backups')).some(x=>x.endsWith('.posbak')));
});

test('bounded JSON reader refuses oversized streaming bodies before buffering the whole request',async()=>{
  const {readLimitedJson,RequestBodyTooLargeError}=require('../src/lib/server/auth.ts');
  const make=(chunks,headers={})=>({
    headers:new Headers({'content-type':'application/json',...headers}),
    body:new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(Buffer.from(chunk));controller.close();}})
  });
  assert.deepEqual(await readLimitedJson(make(['{"ok":true}']),64),{ok:true});
  await assert.rejects(readLimitedJson(make(['{"x":"','x'.repeat(65),'"}']),32),RequestBodyTooLargeError);
  await assert.rejects(readLimitedJson(make(['{"a":1}'],{'content-length':'1000'}),64),RequestBodyTooLargeError);
  await assert.rejects(readLimitedJson(make(['{"a":1}'],{'content-type':'text/plain'}),64));
  await assert.rejects(readLimitedJson(make(['{"invalid":']),64));
});

test('free-text credential detection checks EVERY occurrence, not only an initial placeholder',()=>{
  const {suspiciousCredential,redactCredentials}=require('../src/lib/server/credential-guard.ts');
  const mixed='password: placeholder; password: another-real-credential-sample';
  assert.equal(suspiciousCredential(mixed),true);
  assert.ok(!redactCredentials(mixed).includes('another-real-credential-sample'));
  assert.equal(suspiciousCredential('password: placeholder and token: example'),false);
});

test('manual activity validates secrets, workspace ownership, historical actor and hourly quota',async ()=>{
  const {appendManualActivity,ActivityValidationError,ActivityRateLimitError}=require('../src/lib/server/manual-activity.ts');
  await assert.rejects(async ()=>(await appendManualActivity(owner,{projectId:'a',title:'Unsafe',detail:'password: test-not-share'})),ActivityValidationError);
  await assert.rejects(async ()=>(await appendManualActivity({...owner,role:'editor'},{projectId:'a',title:'Editor',detail:'Note'})));
  await assert.rejects(async ()=>(await appendManualActivity(owner,{projectId:'another-workspace-project',title:'Invalid',detail:'Note'})),ActivityValidationError);
  const id=(await appendManualActivity(owner,{projectId:'a',title:'Safe checkpoint',detail:'No credentials',createTask:true}));
  const row=getDb().prepare('SELECT actor_snapshot,action FROM audit_events WHERE id=?').get(id);
  assert.equal(row.actor_snapshot,owner.displayName);
  assert.equal(row.action,'No credentials');
  const checkpoint=(await loadState(owner)).data.tasks.find(task=>task.title==='Safe checkpoint');
  assert.equal(checkpoint.projectId,'a');
  assert.equal(checkpoint.description,'No credentials');
  await assert.rejects(appendManualActivity(owner,{projectId:'a',title:'Invalid flag',detail:'No credentials',
    createTask:'true'}),ActivityValidationError);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM audit_events WHERE title='Invalid flag'").get().n,0);
  for(let n=1;n<30;n++)(await appendManualActivity(owner,{projectId:'a',title:'Checkpoint '+n,detail:'Safe note'}));
  await assert.rejects(async ()=>(await appendManualActivity(owner,{projectId:'a',title:'Excess',detail:'Safe note'})),ActivityRateLimitError);
});

test('existing MFA-protected members cannot bypass second factor via invitation reactivation',async ()=>{
  const {createInvitation,acceptInvitation,removeMember}=require('../src/lib/server/invitations.ts');
  const fresh=(await createInvitation(owner,'mfa-member@example.test','editor'));
  const member=(await acceptInvitation({token:fresh.token,email:'mfa-member@example.test',displayName:'MFA member',password:'valid-password-2026'}));
  const started=(await beginMfa(member,'mfa-member@example.test'));
  assert.equal((await confirmMfa(member,totp(started.secret))),true);
  assert.equal((await removeMember(owner,member)),true);
  const invite=(await createInvitation(owner,'mfa-member@example.test','viewer'));
  const wrong={token:invite.token,email:'mfa-member@example.test',displayName:'MFA member',password:'valid-password-2026'};
  await assert.rejects(async ()=>(await acceptInvitation(wrong)));
  await assert.rejects(async ()=>(await acceptInvitation({...wrong,totp:'000000'})));
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM memberships WHERE user_id=?').get(member).n,0);
  // An invalid invitation must not trigger password lockout accounting for a victim user.
  const failures=getDb().prepare('SELECT failed_logins AS fails FROM users WHERE id=?').get(member).fails;
  await assert.rejects(async ()=>(await acceptInvitation({...wrong,token:'z'.repeat(43),password:'bad-password-2026'})));
  assert.equal(getDb().prepare('SELECT failed_logins AS fails FROM users WHERE id=?').get(member).fails,failures);
  const nextStep=Math.floor(Date.now()/30000)+1;
  assert.equal((await acceptInvitation({...wrong,totp:totp(started.secret,nextStep)})),member);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM memberships WHERE user_id=?').get(member).n,1);
});

test('reminder worker disambiguates same-id sources and reconciles Telegram opt-in after an existing alert',async ()=>{
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const now=(await loadState(owner)),modified=structuredClone(now.data);
  modified.preferences.renewal=true;
  modified.reminders=[{id:'duplicate-id',title:'Direct reminder',projectId:'a',kind:'تمدید',due:today},
    {id:'iso-due-reminder',title:'UTC due date',projectId:'a',kind:'یادآوری',due:new Date().toISOString()}];
  modified.resources.push({id:'duplicate-id',name:'Shared server',projectId:'a',linkedProjectIds:[],type:'server',address:'203.0.113.6',environment:'Production',status:'registered',provider:'Test',tags:[],expires:today});
  modified.charges.push({id:'duplicate-id',projectId:'a',title:'Same-id subscription',provider:'Test',amount:100,currency:'TOMAN',period:'monthly',nextDue:today,status:'active'});
  (await saveState(owner,now.version,parseState(modified)));
  const exec=(env)=>JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'run-reminders.mjs')],{
    env:{...process.env,PROJECTOS_NOTIFICATION_WORKSPACE:owner.workspaceId,PROJECTOS_TELEGRAM_NOTIFICATIONS:env?'enabled':'disabled',
      PROJECTOS_TELEGRAM_BOT_TOKEN:env?'12345:test-token-is-not-real-1234567890':'',PROJECTOS_TELEGRAM_CHAT_ID:env?'1234567':''},encoding:'utf8'}));
  const initial=exec(false);
  assert.ok(initial.generated>=4);
  const incidents=(await loadState(owner)).data.incidents;
  const matching=incidents.filter(i=>i.title.includes('Direct reminder')||i.title.includes('Shared server')||i.title.includes('Same-id subscription'));
  assert.equal(matching.length,3,'Each source must have its own alert even with matching IDs and dates');
  assert.ok(incidents.some(i=>i.title.includes('UTC due date')),'ISO due dates must not be silently skipped');
  assert.equal(exec(true).generated,0,'Enabling Telegram must not create duplicate in-app alerts');
  const queue=getDb().prepare("SELECT count(*) AS n FROM notification_outbox WHERE workspace_id=? AND channel='telegram' AND state='pending'").get(owner.workspaceId).n;
  assert.ok(queue>=4,'Telegram opt-in queues already-existing alerts');
  assert.ok(exec(false).cancelledTelegram>=4,'Disabling Telegram cancels pending delivery');
  assert.equal(getDb().prepare("SELECT count(*) AS n FROM notification_outbox WHERE workspace_id=? AND channel='telegram' AND state='pending'").get(owner.workspaceId).n,0);
  assert.ok(exec(true).queuedTelegram>=4,'Re-enabling Telegram queues previously cancelled notifications');
  assert.equal((await loadState(owner)).data.incidents.filter(i=>i.id.startsWith('auto-')).length,incidents.filter(i=>i.id.startsWith('auto-')).length);
});

test('reminder identity and delivery history survive removal of colliding sources',async ()=>{
  const worker=()=>execFileSync(process.execPath,[path.join(__dirname,'run-reminders.mjs')],{
    env:{...process.env,PROJECTOS_NOTIFICATION_WORKSPACE:owner.workspaceId,PROJECTOS_TELEGRAM_NOTIFICATIONS:'enabled',
      PROJECTOS_TELEGRAM_BOT_TOKEN:'12345:synthetic-test-only-longer',PROJECTOS_TELEGRAM_CHAT_ID:'1234567'},
    encoding:'utf8',
  });
  const db=getDb();
  const state=(await loadState(owner));
  const survivor=state.data.incidents.find(incident=>incident.title.includes('Direct reminder'));
  assert.ok(survivor);
  const update=db.prepare("UPDATE notification_outbox SET state='delivered',delivered_at=? WHERE workspace_id=? AND id=?");
  assert.equal(update.run(new Date().toISOString(),owner.workspaceId,'tg-'+survivor.id).changes,1);
  (await saveState(owner,state.version,parseState({...state.data,
    resources:state.data.resources.filter(item=>item.id!=='duplicate-id'),
    charges:state.data.charges.filter(item=>item.id!=='duplicate-id'),
  })));
  worker();
  const after=(await loadState(owner)).data.incidents.filter(incident=>incident.title.includes('Direct reminder'));
  assert.deepEqual(after.map(incident=>incident.id),[survivor.id]);
  const entries=db.prepare("SELECT id,state FROM notification_outbox WHERE workspace_id=? AND channel='telegram' AND reminder_id='reminders:duplicate-id'").all(owner.workspaceId);
  assert.deepEqual(entries.map(row=>[row.id,row.state]),[['tg-'+survivor.id,'delivered']]);
});

test('SQLite refuses publicly served paths and symlinked database files',()=>{
  const root=path.resolve(__dirname,'..');
  const bootstrap=`const ts=require('typescript'),fs=require('fs');require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);require('./src/lib/server/db.ts').getDb()`;
  const publicPath=path.join(root,'public','projectos-disallowed-security-test.sqlite');
  const publicAttempt=require('node:child_process').spawnSync(process.execPath,['-e',bootstrap],{
    cwd:root,env:{...process.env,PROJECTOS_DB_PATH:publicPath},encoding:'utf8'});
  assert.notEqual(publicAttempt.status,0,'A DB path inside public/ must fail');
  assert.equal(fs.existsSync(publicPath),false);
  const actual=path.join(temp,'target.sqlite'),linked=path.join(temp,'db-symlink.sqlite');
  fs.writeFileSync(actual,'not-a-database');
  try{
    fs.symlinkSync(actual,linked);
    const linkedAttempt=require('node:child_process').spawnSync(process.execPath,['-e',bootstrap],{
      cwd:root,env:{...process.env,PROJECTOS_DB_PATH:linked},encoding:'utf8'});
    assert.notEqual(linkedAttempt.status,0,'Symlink DB targets must fail closed');
  }finally{try{fs.unlinkSync(linked);}catch{}}
});

test('origin protection rejects cross-site mutations and fails closed when production origin is missing',()=>{
  const {checkOrigin}=require('../src/lib/server/auth.ts');
  const pretend=(origin,site='same-origin')=>({headers:new Headers({'Origin':origin,'Sec-Fetch-Site':site}),nextUrl:{origin:'http://127.0.0.1:3000'}});
  const oldEnv=process.env.NODE_ENV,oldOrigin=process.env.PROJECTOS_PUBLIC_ORIGIN;
  try{
    process.env.NODE_ENV='production';delete process.env.PROJECTOS_PUBLIC_ORIGIN;
    assert.equal(checkOrigin(pretend('http://127.0.0.1:3000')),false);
    process.env.PROJECTOS_PUBLIC_ORIGIN='https://projectos.example.com';
    assert.equal(checkOrigin(pretend('http://127.0.0.1:3000')),false);
    assert.equal(checkOrigin(pretend('https://projectos.example.com','cross-site')),false);
    assert.equal(checkOrigin(pretend('https://projectos.example.com')),true);
  }finally{
    if(oldEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldEnv;
    if(oldOrigin===undefined)delete process.env.PROJECTOS_PUBLIC_ORIGIN;else process.env.PROJECTOS_PUBLIC_ORIGIN=oldOrigin;
  }
});

test('user changes cannot forge, delete or rewrite worker-owned auto-reminder provenance',async ()=>{
  const before=(await loadState(owner)),automatic=before.data.incidents.find(i=>i.id.startsWith('auto-'));
  assert.ok(automatic,'Test setup should have a worker-generated incident');
  const forged=structuredClone(before.data);
  forged.incidents.push({...automatic,id:'auto-'+crypto.randomBytes(14).toString('hex')});
  await assert.rejects(async ()=>(await saveState(owner,before.version,parseState(forged))));
  const rewritten=structuredClone(before.data);
  rewritten.incidents.find(i=>i.id===automatic.id).title='Misleading renewal';
  await assert.rejects(async ()=>(await saveState(owner,before.version,parseState(rewritten))));
  const deleted=structuredClone(before.data);
  deleted.incidents=deleted.incidents.filter(i=>i.id!==automatic.id);
  await assert.rejects(async ()=>(await saveState(owner,before.version,parseState(deleted))));
  const acknowledged=structuredClone(before.data);
  acknowledged.incidents.find(i=>i.id===automatic.id).state='acknowledged';
  assert.equal((await saveState(owner,before.version,parseState(acknowledged))),before.version+1);
});

test('authenticated sessions expire after inactivity as well as absolute lifetime',async ()=>{
  const {lookupSessionUserId}=require('../src/lib/server/auth.ts');
  const token=(await newSession(owner.id));
  assert.equal((await lookupSessionUserId(token)),owner.id);
  const hash=crypto.createHash('sha256').update(token).digest('hex');
  getDb().prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?')
    .run(Date.now()-25*60*60*1000,hash);
  assert.equal((await lookupSessionUserId(token)),null);
  const fresh=(await newSession(owner.id)),freshHash=crypto.createHash('sha256').update(fresh).digest('hex');
  getDb().prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?')
    .run(Date.now()-1000,freshHash);
  assert.equal((await lookupSessionUserId(fresh)),null);
});

test('streaming restore preserves compatibility with historical v1 backups and rejects tampering',async()=>{
  const {backup}=require('node:sqlite');
  const snapshot=path.join(temp,'legacy-snapshot.sqlite'),archive=path.join(temp,'legacy-v1.posbak');
  await backup(getDb(),snapshot);
  const phrase='test-strong-password-for-backup-compatibility-2026';
  const salt=crypto.randomBytes(24),iv=crypto.randomBytes(12);
  const key=crypto.scryptSync(phrase,salt,32,{N:32768,r:8,p:1,maxmem:128*1024*1024});
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv),header=Buffer.from('PROJECTOS-BACKUP-v1\n');
  cipher.setAAD(header);
  const encrypted=Buffer.concat([cipher.update(fs.readFileSync(snapshot)),cipher.final()]);
  fs.writeFileSync(archive,Buffer.concat([header,salt,iv,cipher.getAuthTag(),encrypted]));
  const run=()=>require('node:child_process').spawnSync(process.execPath,[path.join(__dirname,'verify-encrypted-backup.mjs'),archive],{
    env:{...process.env,PROJECTOS_BACKUP_PASSPHRASE:phrase},encoding:'utf8'});
  const result=run();assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/"streaming":true/);
  const original=fs.readFileSync(archive);original[original.length-4]^=0xff;
  fs.writeFileSync(archive,original);
  assert.notEqual(run().status,0,'Ciphertext modifications must fail authenticated decryption');
  assert.ok((await loadState(owner)).data.projects.length>0,'Verification never mutates active database');
});

test('unrelated record and snapshot writes preserve masked legacy documents and their history',async ()=>{
  const db=getDb();
  const read=db.prepare("SELECT payload,updated_at FROM records WHERE workspace_id=? AND kind='docs' AND id='doc'");
  const write=db.prepare("UPDATE records SET payload=? WHERE workspace_id=? AND kind='docs' AND id='doc'");
  const original=read.get(owner.workspaceId);
  const legacy=JSON.stringify({...JSON.parse(original.payload),body:'password: synthetic-legacy-sample'});
  write.run(legacy,owner.workspaceId);
  try{
    const stored=read.get(owner.workspaceId);
    const before=(await loadState(owner));
    assert.equal(before.data.docs.find(doc=>doc.id==='doc').body,'[REDACTED CREDENTIAL]');
    (await mutateRecord(owner,before.version,'tasks','legacy-roundtrip','create',task('legacy-roundtrip','a')));
    const next=(await loadState(owner));
    assert.ok(next.data.tasks.some(item=>item.id==='legacy-roundtrip'));
    (await saveState(owner,next.version,parseState({...next.data,tasks:next.data.tasks.filter(item=>item.id!=='legacy-roundtrip')})));
    assert.deepEqual(read.get(owner.workspaceId),stored);
    assert.equal(getDb().prepare("SELECT count(*) AS n FROM audit_events WHERE workspace_id=? AND kind='docs' AND title LIKE '%synthetic-legacy-sample%'").get(owner.workspaceId).n,0);
  }finally{
    write.run(original.payload,owner.workspaceId);
  }
});

test('contract ranges compare UTC instants across accepted ISO precisions',async ()=>{
  const state=(await loadState(owner)).data;
  const contract={id:'contract-precision',projectId:'a',title:'Annual plan',client:'Client',currency:'USD',amount:1200,state:'draft'};
  state.contracts=[{...contract,start:'2026-11-18T13:30Z',end:'2026-11-18T13:30:01.000Z'}];
  assert.equal(parseState(state).contracts.length,1);
  state.contracts=[{...contract,start:'2026-11-18T13:30:01.000Z',end:'2026-11-18T13:30Z'}];
  assert.throws(()=>parseState(state),/Contract end before start/);
});

test('task comment timestamps must be valid calendar dates and UTC times',async ()=>{
  const state=(await loadState(owner)).data;
  const item=task('comment-calendar','a');
  state.tasks=[{...item,comments:[{text:'Invalid day',date:'2026-02-30T14:00Z'}]}];
  assert.throws(()=>parseState(state),/Invalid calendar date/);
  state.tasks=[{...item,comments:[{text:'Valid leap day',date:'2028-02-29T14:00Z'}]}];
  assert.equal(parseState(state).tasks.length,1);
});

test('calendar recurrence clamps month end and keeps wall-calendar dates over DST',async ()=>{
  const {occurrences}=await import('./reminder-scheduler.mjs');
  assert.deepEqual(occurrences('2026-01-31','monthly','UTC','2026-02-01','2026-04-30'),
    ['2026-02-28','2026-03-31','2026-04-30']);
  assert.deepEqual(occurrences('2026-03-28T23:30Z','daily','Europe/Berlin','2026-03-28','2026-03-31'),
    ['2026-03-29','2026-03-30','2026-03-31']);
});

test('expired notification lease can be reclaimed and a stale worker cannot finalize it',async ()=>{
  const {claimDelivery,beginDelivery,finishDelivery}=await import('./notification-delivery.mjs');
  const now=Date.now();
  const id='synthetic-email-lease';
  getDb().prepare(`INSERT INTO notification_outbox(id,workspace_id,reminder_id,scheduled_for,channel,state,created_at)
    VALUES(?,?,?,?,?,'pending',?)`).run(id,owner.workspaceId,'synthetic-lease-source','2026-11-19','email',new Date(now).toISOString());
  const acquired=await claimDelivery(owner.workspaceId,'email',now);
  assert.equal(acquired.id,id);
  assert.equal(await claimDelivery(owner.workspaceId,'email',now+1000),undefined);
  const recovered=await claimDelivery(owner.workspaceId,'email',now+120001);
  assert.equal(recovered.id,id);
  assert.equal(recovered.attempts,2);
  assert.notEqual(recovered.lease,acquired.lease);
  assert.equal(await finishDelivery(acquired,true,now+120002),false);
  assert.equal(await beginDelivery(recovered,now+120002),true);
  assert.equal(await finishDelivery(recovered,true,now+120002),true);
  assert.equal(getDb().prepare('SELECT state FROM notification_outbox WHERE id=?').get(id).state,'delivered');
});

test('a VPS renewal retires its queued alert after a worker crash and delivers only the new deadline', async () => {
  const {commitRecordChanges}=require('../src/lib/server/record-service.ts');
  const {reconcileReminders,reminderAlertId}=await import('./reminder-scheduler.mjs');
  const {claimDelivery,finishDelivery,deliverNotifications}=await import('./notification-delivery.mjs');
  const {closeDatabase}=await import('./database.mjs');
  const {accountByUser}=require('../src/lib/server/db.ts');
  const original=process.env.PROJECTOS_DB_PATH;
  await closeDatabase();
  process.env.PROJECTOS_DB_PATH=path.join(temp,'renewal-workflow.sqlite');
  try {
    const user=await setupOwner({setupToken:process.env.PROJECTOS_SETUP_TOKEN,email:'renewal@example.test',
      password:'synthetic-renewal-owner-password',displayName:'Renewal fixture',workspace:'Renewal fixture'});
    const owner=await accountByUser(user);
    assert.ok(owner);
    const current=await loadState(owner);
    const projectId='renewal-workflow-project',
      resource={id:'renewal-workflow-vps',name:'Synthetic VPS',projectId,linkedProjectIds:[],type:'server',
        address:'203.0.113.80',environment:'Development',status:'registered',provider:'Fixture host',tags:[],
        expires:'2031-03-04',noticeDays:2};
    const create=(kind,record)=>({kind,id:record.id,action:'create',record});
    await commitRecordChanges(owner,current.version,[create('projects',project(projectId)),create('resources',resource)],
      {...current.data.preferences,zone:'UTC',renewal:true,digest:false});
    const scan=day=>reconcileReminders({clock:new Date(day+'T10:00:00Z'),channels:['email'],
      notificationWorkspace:owner.workspaceId,offsets:[14,7,3,1,0]});
    const alertId=(item)=>reminderAlertId(owner.workspaceId,'تمدید',item.id,item.expires,'resources');
    const outbox=id=>getDb().prepare('SELECT state,scheduled_for FROM notification_outbox WHERE id=? AND workspace_id=?')
      .get(id,owner.workspaceId);
    const expired=alertId(resource), expiredEmail='email-'+expired;
    await scan('2031-03-01');
    assert.equal(outbox(expiredEmail),undefined,'Third day before due is earlier than the selected two-day notice');
    await scan('2031-03-02');
    assert.equal(outbox(expiredEmail).state,'pending');
    assert.equal(outbox(expired).state,'available');

    const now=Date.parse('2031-03-02T10:01:00Z');
    const entry=pathToFileURL(path.join(__dirname,'notification-delivery.mjs')).href;
    const crashed=spawnSync(process.execPath,['--input-type=module','-e',`
      const {claimDelivery}=await import(process.argv[1]);
      const job=await claimDelivery(process.argv[2],'email',Number(process.argv[3]));
      process.stdout.write(JSON.stringify(job),()=>process.exit(27));
    `,entry,owner.workspaceId,String(now)],{env:process.env,encoding:'utf8',timeout:15_000});
    assert.equal(crashed.status,27);
    const stale=JSON.parse(crashed.stdout);
    assert.equal(stale.id,expiredEmail);
    assert.equal(outbox(expiredEmail).state,'sending');
    assert.equal(await claimDelivery(owner.workspaceId,'email',now+1000),undefined);

    const moved={...resource,expires:'2031-03-05'};
    const latest=await loadState(owner);
    for (const invalid of [1.25,61,-1,'2']) {
      await assert.rejects(commitRecordChanges(owner,latest.version,[{
        kind:'resources',id:resource.id,action:'replace',record:{...moved,noticeDays:invalid},
      }]),ValidationError);
    }
    await commitRecordChanges(owner,latest.version,[{kind:'resources',id:resource.id,action:'replace',record:moved}]);
    assert.equal(outbox(expiredEmail).state,'cancelled','Date change must retire the old job before the scheduler reruns');
    assert.equal(outbox(expired).state,'cancelled');
    assert.equal((await loadState(owner)).data.incidents.some(item=>item.id===expired),false);
    assert.equal(await claimDelivery(owner.workspaceId,'email',now+120001),undefined);
    assert.equal(await finishDelivery(stale,true,now+120002),false);

    const newAlert=alertId(moved),newEmail='email-'+newAlert;
    await scan('2031-03-02');
    assert.equal(outbox(newEmail),undefined);
    await scan('2031-03-03');
    assert.equal(outbox(newEmail).state,'pending');
    const providerCalls=[];
    const mock={email:async job=>{providerCalls.push([job.id,job.scheduled_for]);return true;}};
    assert.equal((await deliverNotifications(owner.workspaceId,mock)).accepted,1);
    await scan('2031-03-03');
    assert.equal((await deliverNotifications(owner.workspaceId,mock)).accepted,0);
    assert.deepEqual(providerCalls,[[newEmail,moved.expires]]);
    assert.equal(outbox(newEmail).state,'delivered');

    const deadline={...task('explicit-task-deadline',projectId),due:'2031-03-05',noticeDays:2};
    const unconfigured={...task('unconfigured-task-deadline',projectId),due:deadline.due};
    await commitRecordChanges(owner,(await loadState(owner)).version,[create('tasks',deadline),create('tasks',unconfigured)]);
    await scan('2031-03-03');
    const taskAlert=reminderAlertId(owner.workspaceId,'یادآوری',deadline.id,deadline.due,'tasks');
    const implicit=reminderAlertId(owner.workspaceId,'یادآوری',unconfigured.id,unconfigured.due,'tasks');
    assert.equal(outbox(taskAlert).state,'available');
    assert.equal(outbox(implicit),undefined);
    await commitRecordChanges(owner,(await loadState(owner)).version,[{
      kind:'tasks',id:deadline.id,action:'replace',record:{...deadline,status:'done'},
    }]);
    assert.equal(outbox('email-'+taskAlert).state,'cancelled');
    assert.equal(outbox(taskAlert).state,'cancelled');
  } finally {
    await closeDatabase();
    process.env.PROJECTOS_DB_PATH=original;
  }
});

test('Vault metadata probe uses the approved metadata path and discards provider data',async ()=>{
  const {verifyVaultReference}=require('../src/lib/server/vault.ts');
  const pointer={vaultProvider:'HashiCorp Vault',vaultMount:'kv',vaultPath:'project/reference'};
  const settings={origin:'https://vault.example.test',token:'synthetic-fixture-token',mounts:new Set(['kv'])};
  let calls=0;
  const stub=async (url,options)=>{
    calls++;
    assert.equal(url.href,'https://vault.example.test/v1/kv/metadata/project/reference');
    assert.equal(options.redirect,'error');
    assert.equal(options.method,'GET');
    return Response.json({data:{current_version:3,versions:{3:{destroyed:false,deletion_time:''}},unrelated:'discard'}});
  };
  assert.deepEqual(await verifyVaultReference(pointer,settings,stub),{status:'verified',providerVersion:3});
  assert.deepEqual(await verifyVaultReference({...pointer,vaultMount:'other'},settings,stub),{status:'not_configured',providerVersion:null});
  assert.equal(calls,1);
  assert.equal((await verifyVaultReference(pointer,settings,async()=>new Response(null,{status:403}))).status,'permission_denied');
  assert.equal((await verifyVaultReference(pointer,settings,async()=>{throw Error('simulated outage');})).status,'unavailable');
});

test('GitHub quota is reported with a retry timestamp and signed data is validated',async ()=>{
  const {syncRepository,signedDelivery}=require('../src/lib/server/github.ts');
  const clock=new Date('2026-11-19T00:00:00.000Z');
  let attempts=0;
  const result=await syncRepository('synthetic/example','synthetic-token',async()=>{
    attempts++;
    return new Response(null,{status:429,headers:{'Retry-After':'90'}});
  },clock);
  assert.equal(attempts,1);
  assert.equal(result.state,'rate_limited');
  assert.equal(result.retryAt,'2026-11-19T00:01:30.000Z');
  const raw=Buffer.from('{"repository":{"full_name":"synthetic/example"}}');
  const key='synthetic-webhook-test-fixture-only';
  const signature='sha256='+crypto.createHmac('sha256',key).update(raw).digest('hex');
  assert.equal(signedDelivery(raw,signature,key),true);
  assert.equal(signedDelivery(Buffer.from('changed fixture'),signature,key),false);
  assert.equal(signedDelivery(raw,null,key),false);
});

test('GitHub activity backfill is bounded and keeps only sanitized repository metadata',async ()=>{
  const {syncRepository}=require('../src/lib/server/github.ts');
  const checkedAt='2026-11-20T11:00:00.000Z';
  const calls=[];
  const fakeToken='fixture-github-read-only-value';
  const sha='a'.repeat(40);
  const request=async (input,options)=>{
    const url=new URL(input);
    assert.equal(url.hostname,'api.github.com');
    assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,'Bearer '+fakeToken);
    const path=url.pathname.slice('/repos/fixture/repository'.length);
    const page=Number(url.searchParams.get('page'));
    calls.push([path,page]);
    if(!path) return Response.json({pushed_at:checkedAt,open_issues_count:2});
    if(path==='/branches') return Response.json(Array.from({length:10},(_,i)=>({
      name:i===0?'branch-shared':`branch-${page}-${i}`,commit:{sha},protection_url:'not-exported',
    })));
    if(path==='/commits') return Response.json([{sha,commit:{
      message:'token=synthetic-unpublished-value\nprivate body',committer:{date:checkedAt,email:'discard@example.test'},
    }}]);
    if(path==='/pulls') return Response.json([{number:3,title:'Reviewed fixture',state:'closed',merged_at:checkedAt,updated_at:checkedAt,
      body:'unexported content'}]);
    if(path==='/issues') return Response.json([{number:7,title:'Fixture issue'},{number:3,title:'Pull',pull_request:{}}]);
    return Response.json([]);
  };
  const snapshot=await syncRepository('fixture/repository',fakeToken,request,new Date(checkedAt),true);
  assert.equal(snapshot.state,'connected');
  assert.deepEqual(calls.filter(([name])=>name==='/branches').map(([,page])=>page),[1,2,3]);
  assert.equal(snapshot.branches.length,28);
  assert.deepEqual(snapshot.commits,[{sha,subject:'[REDACTED CREDENTIAL]',committedAt:checkedAt}]);
  assert.deepEqual(snapshot.pullRequests,[{number:3,title:'Reviewed fixture',status:'merged',updatedAt:checkedAt}]);
  assert.deepEqual(snapshot.issues,[{number:7,title:'Fixture issue'}]);
  const serialized=JSON.stringify(snapshot);
  for(const text of [fakeToken,'private body','discard@example.test','unexported content','synthetic-unpublished-value']) {
    assert.equal(serialized.includes(text),false);
  }
});

test('HTTPS monitor declines private DNS answers before opening a connection',async ()=>{
  const {probeHttps}=await import('./monitor-probe.mjs');
  const allow=new Set(['probe.projectos-sandbox.net']);
  let attempted=false;
  await assert.rejects(probeHttps('https://probe.projectos-sandbox.net',allow,{
    resolve:async()=>[{address:'127.0.0.1',family:4}],
    connect:()=>{attempted=true;throw Error('no socket should open');},
  }),/Public DNS verification failed/);
  assert.equal(attempted,false);
});

test('machine agent samples an opted-in filesystem and sends only byte counters to its HTTPS endpoint', () => {
  const agent=pathToFileURL(path.join(__dirname,'report-monitor-agent.mjs')).href;
  const env={...process.env,PROJECTOS_AGENT_TARGET:'https://agent.example.test/api/monitoring/observations',
    PROJECTOS_MONITOR_AGENT_TOKEN:'synthetic-monitor-only-fixture',PROJECTOS_AGENT_RESOURCE_ID:'fixture-server',
    PROJECTOS_AGENT_DISK_PATH:temp};
  const output=execFileSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    globalThis.fetch=async (url,options)=>{
      assert.equal(url.href,process.env.PROJECTOS_AGENT_TARGET);
      assert.equal(options.redirect,'error');
      const body=JSON.parse(options.body);
      assert.equal(body.resourceId,'fixture-server');
      assert.ok(Number.isSafeInteger(body.diskUsedBytes) && body.diskUsedBytes>=0);
      assert.ok(Number.isSafeInteger(body.diskTotalBytes) && body.diskTotalBytes>0 && body.diskUsedBytes<=body.diskTotalBytes);
      assert.equal(options.body.includes(process.env.PROJECTOS_AGENT_DISK_PATH),false);
      return Response.json({accepted:true});
    };
    await import(process.argv[1]);
  `,agent],{env,encoding:'utf8',timeout:12_000});
  assert.match(output,/Authenticated machine observation submitted/);
});

test('multi-currency totals have exact minor units and CSV neutralizes spreadsheet formulas',()=>{
  const {parseAmount,totalsByCurrency}=require('../src/lib/money.ts');
  const {csv}=require('../src/lib/format.ts');
  assert.equal(parseAmount('23.50','USD'),2350);
  assert.equal(parseAmount('23.50','TOMAN'),undefined);
  assert.equal(parseAmount('999999999999999999','USD'),undefined);
  const totals=totalsByCurrency([{amount:100,currency:'USD'},{amount:2350,currency:'USD',amountUnit:'minor'},
    {amount:10,currency:'IRR'},...Array.from({length:10_000},()=>({amount:1e12}))]);
  assert.equal(totals.get('TOMAN'),BigInt('10000000000000000'));
  assert.equal(totals.get('IRR'),BigInt(10));
  assert.equal(totals.get('USD'),BigInt(12350));
  const sheet=csv([['＝1+1','مرحله',123]]);
  assert.ok(sheet.includes('"\'＝1+1"'));
});

test('invoice installments use exact remaining balances and legacy snapshots preserve the ledger', async () => {
  const {commitRecordChanges}=require('../src/lib/server/record-service.ts');
  const {parseRecord}=require('../src/lib/server/validation.ts');
  const {invoiceBalance,installmentBalances}=require('../src/lib/invoice-ledger.ts');
  const invoice={id:'compat-invoice',projectId:'compat-ledger',reference:'fixture-invoice',title:'Fixture invoice',
    direction:'receivable',amountUnit:'minor',amount:1250,currency:'USD',
    issuedOn:'2031-03-01',dueOn:'2031-04-01',state:'open',
    installments:[{dueOn:'2031-03-15',amount:499},{dueOn:'2031-04-01',amount:751}]};
  assert.throws(()=>parseRecord('invoices',{...invoice,installments:[{dueOn:'2031-03-15',amount:1249}]}),/sum/);
  assert.throws(()=>parseRecord('invoices',{...invoice,currency:'JPY'}),ValidationError);
  const payment={id:'compat-payment',projectId:invoice.projectId,invoiceId:invoice.id,reference:'fixture-payment',
    amountUnit:'minor',currency:'USD',amount:500,paidOn:'2031-03-11'};
  const created=(kind,record)=>({kind,id:record.id,action:'create',record});
  await commitRecordChanges(owner,(await loadState(owner)).version,[
    created('projects',project(invoice.projectId)),created('invoices',invoice),created('payments',payment),
  ]);
  const initial=await loadState(owner);
  assert.deepEqual(invoiceBalance(invoice,initial.data.payments),{paid:BigInt(500),remaining:BigInt(750)});
  assert.deepEqual(installmentBalances(invoice,BigInt(500)).map(item=>item.remaining),[BigInt(0),BigInt(750)]);
  const legacy=structuredClone(initial.data);
  delete legacy.invoices;
  delete legacy.payments;
  await saveState(owner,initial.version,parseState(legacy));
  const after=await loadState(owner);
  assert.deepEqual(after.data.invoices,[invoice]);
  assert.deepEqual(after.data.payments,[payment]);
  legacy.projects=legacy.projects.filter(item=>item.id!==invoice.projectId);
  await assert.rejects(saveState(owner,after.version,parseState(legacy)),/Invoice project must exist/);
});

test('exchange conversion preserves minor units and rejects rates without valid attribution',()=>{
  const {convertAtRate}=require('../src/lib/exchange-rate.ts');
  const {parseRecord}=require('../src/lib/server/validation.ts');
  const quote={id:'synthetic-quote',projectId:'a',from:'USD',to:'TOMAN',rate:'۱۲۳٫۵',source:' Fixture statement 7 ',
    observedAt:'2026-01-15T14:30Z'};
  const valid=parseRecord('exchangeRates',quote);
  assert.equal(valid.source,'Fixture statement 7');
  assert.equal(valid.observedAt,'2026-01-15T14:30:00.000Z');
  assert.equal(convertAtRate(101n,valid),125n);
  assert.equal(convertAtRate(-100n,{...valid,rate:'123.5'}),-124n);
  assert.equal(convertAtRate(100n,{from:'IRR',to:'USD',rate:'0.00005'}),1n);
  for (const override of [{rate:'0'},{rate:'1e5'},{to:'USD'},{to:'JPY'},{source:'  '},{observedAt:'2026-01-15'},
    {observedAt:'2199-01-15T14:30Z'}]) {
    assert.throws(()=>parseRecord('exchangeRates',{...quote,...override}),/Invalid enum|Exchange rates require/);
  }
});

test('model citations accept literal permitted text and reject unsupported or wrong-source output',()=>{
  const {verifyQuotes}=require('../src/lib/server/project-memory.ts');
  const sources=[{id:'doc:test',excerpt:'Synthetic support sentence.'}];
  assert.equal(verifyQuotes(JSON.stringify({quotes:[{id:'doc:test',quote:'support sentence.'}]}),sources).length,1);
  assert.deepEqual(verifyQuotes(JSON.stringify({quotes:[{id:'doc:test',quote:'unverified text'}]}),sources),[]);
  assert.deepEqual(verifyQuotes(JSON.stringify({quotes:[{id:'doc:outside',quote:'support sentence.'}]}),sources),[]);
});

test('notification claim cannot send after cancellation and an interrupted dispatch is never reclaimed', async () => {
  const {claimDelivery,beginDelivery,finishDelivery}=await import('./notification-delivery.mjs');
  const {closeDatabase}=await import('./database.mjs');
  const original=process.env.PROJECTOS_DB_PATH;
  await closeDatabase();
  process.env.PROJECTOS_DB_PATH=path.join(temp,'dispatch-lifecycle.sqlite');
  try {
    const user=await setupOwner({setupToken:process.env.PROJECTOS_SETUP_TOKEN,email:'queue-fixture@example.test',
      password:'synthetic-queue-fixture-test-only',displayName:'Queue fixture',workspace:'Local queue fixture'});
    const {accountByUser}=require('../src/lib/server/db.ts');
    const account=await accountByUser(user);
    const now=Date.now();
    function insert(id,expiresAt) {
      getDb().prepare(`INSERT INTO notification_outbox(id,workspace_id,reminder_id,scheduled_for,channel,state,created_at,expires_at)
        VALUES(?,?,?,'2031-03-05','email','pending',?,?)`)
        .run(id,account.workspaceId,id,new Date(now).toISOString(),expiresAt);
    }
    function state(id) { return getDb().prepare('SELECT state FROM notification_outbox WHERE id=?').get(id).state; }
    function cancel(id) { getDb().prepare("UPDATE notification_outbox SET state='cancelled' WHERE id=?").run(id); }
    insert('expired',now);
    insert('cancel-before',now+600_000);
    const before=await claimDelivery(account.workspaceId,'email',now);
    assert.equal(before.id,'cancel-before');
    assert.equal(state('expired'),'failed');
    cancel(before.id);
    assert.equal(await beginDelivery(before,now),false);
    assert.equal(state(before.id),'cancelled');

    insert('cancel-during',now+600_000);
    const during=await claimDelivery(account.workspaceId,'email',now);
    assert.equal(await beginDelivery(during,now),true);
    cancel(during.id);
    assert.equal(state(during.id),'unknown');
    assert.equal(await finishDelivery(during,{kind:'accepted',id:'57'},now+1),false);

    insert('interrupted',now+600_000);
    const interrupted=await claimDelivery(account.workspaceId,'email',now);
    assert.equal(await beginDelivery(interrupted,now),true);
    await closeDatabase();
    assert.equal(await claimDelivery(account.workspaceId,'email',now+120_001),undefined);
    assert.equal(state(interrupted.id),'unknown');
    assert.equal(await finishDelivery(interrupted,{kind:'accepted',id:'57'},now+120_002),false);
  } finally {
    await closeDatabase();
    process.env.PROJECTOS_DB_PATH=original;
  }
});
