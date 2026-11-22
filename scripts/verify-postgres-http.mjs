import { fork, execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import pg from 'pg';

const adminUrl = new URL(process.env.PROJECTOS_TEST_POSTGRES_URL ?? 'file:/');
if (!['postgres:', 'postgresql:'].includes(adminUrl.protocol) || !['127.0.0.1','localhost'].includes(adminUrl.hostname)
  || adminUrl.pathname !== '/postgres') throw new Error('A loopback PostgreSQL test admin database is required');

const database = 'projectos_test_' + randomBytes(6).toString('hex');
const runtime = new URL('/' + database, adminUrl);
const runtimeRole = database.replace('projectos_test_', 'projectos_app_');
const runtimePassword = randomBytes(24).toString('hex');
const scratch = await mkdtemp(join(tmpdir(),'projectos-pg-http-'));
const admin = new pg.Client({connectionString:adminUrl.href});
const setupToken = 'synthetic-runtime-test-bootstrap-token';
let server, existed = false, roleCreated = false;

async function startServer(env) {
  server = fork(resolve('scripts/prepare-e2e.mjs'),[],{env,stdio:['ignore','ignore','pipe','ipc']});
  server.stderr?.resume();
  return new Promise((ok,fail)=>{
    const timeout = setTimeout(()=>fail(new Error('PostgreSQL production build test server not ready')),30_000);
    server.once('exit',()=>{clearTimeout(timeout);fail(new Error('PostgreSQL production build test server exited'));});
    server.once('error',error=>{clearTimeout(timeout);fail(error);});
    server.once('message',message=>{clearTimeout(timeout);ok(message.url);});
  });
}

async function stopServer(signal) {
  if (server && server.exitCode===null && server.signalCode===null) {
    const exited=once(server,'exit');
    server.kill(signal);
    await exited;
  }
}

function totp(seed) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...seed].map(letter => alphabet.indexOf(letter).toString(2).padStart(5,'0')).join('');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(byte => parseInt(byte,2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30_000)));
  const digest = createHmac('sha1',key).update(counter).digest();
  const offset = digest[19] & 15;
  return ((digest.readUInt32BE(offset)&0x7fffffff)%1_000_000).toString().padStart(6,'0');
}

try {
  await admin.connect();
  await admin.query('CREATE DATABASE "' + database + '"');
  existed = true;
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^PROJECTOS_/i.test(name))),
    NODE_ENV:'production', PROJECTOS_DATABASE_URL:runtime.href, PROJECTOS_DB_PATH:join(scratch,'must-not-exist.sqlite'),
    PROJECTOS_DATABASE_MODE:'postgres', PROJECTOS_MFA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),
    PROJECTOS_SETUP_TOKEN:setupToken, PROJECTOS_AI_ENABLED:'disabled', PROJECTOS_GITHUB_TOKEN:'',
  };
  execFileSync(process.execPath,[resolve('scripts/migrate-postgres.mjs')],{env,stdio:['ignore','ignore','pipe'],timeout:30_000});
  await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${runtimePassword}'`);
  roleCreated = true;
  const psql = process.env.PROJECTOS_PG_BIN ? join(process.env.PROJECTOS_PG_BIN, 'psql') : 'psql';
  execFileSync(psql,['-X','-h',adminUrl.hostname,'-p',adminUrl.port||'5432','-U',decodeURIComponent(adminUrl.username),
    '-d',database,'-v','runtime_role='+runtimeRole,'-f',resolve('schema/postgres/grant-runtime.sql')],{
    env:{...env, PGPASSWORD:decodeURIComponent(adminUrl.password)},stdio:['ignore','ignore','pipe'],timeout:30_000,
  });
  const appDatabase = new URL(runtime);
  const signingKey=randomBytes(32);
  const installer=new pg.Client({connectionString:runtime.href});
  await installer.connect();
  try { await installer.query('INSERT INTO projectos_private.scope_key VALUES(true,$1)',[signingKey]); }
  finally { await installer.end(); }
  env.PROJECTOS_DB_SCOPE_KEY=signingKey.toString('hex');
  appDatabase.username = runtimeRole;
  appDatabase.password = runtimePassword;
  env.PROJECTOS_DATABASE_URL = appDatabase.href;
  let appUrl = await startServer(env);
  const ready = await fetch(appUrl+'/api/health');
  assert.equal(ready.status,200);
  const headers={'Content-Type':'application/json',Origin:appUrl,'Sec-Fetch-Site':'same-origin'};
  const account={email:'runtime@example.test',password:'synthetic-test-only-password',displayName:'Local runtime',workspace:'Local runtime'};
  const created=await fetch(appUrl+'/api/auth/setup',{
    headers,method:'POST',body:JSON.stringify({setupToken,...account}),signal:AbortSignal.timeout(10_000),
  });
  assert.equal(created.status,200);
  const cookie = created.headers.get('set-cookie');
  assert.match(cookie,/__Host-projectos_session=/);
  assert.match(cookie,/HttpOnly/i);
  assert.match(cookie,/Secure/i);
  headers.Cookie=cookie.split(';',1)[0];
  const project={id:'http-project',name:'HTTP project',subtitle:'',coverTitle:'HTTP project',description:'',status:'building',
    type:'Website',progress:0,next:'Verify synthetic acceptance data',art:'navigation/projects'};
  const otherProject={...project,id:'other-project',name:'Other project',next:''};
  const resource={id:'http-server',name:'Synthetic server',projectId:project.id,linkedProjectIds:[],type:'server',
    address:'203.0.113.81',environment:'Development',status:'registered',provider:'Fixture host',tags:[]};
  const shared = {...resource,id:'shared-resource',name:'Shared resource',parentId:resource.id,linkedProjectIds:[otherProject.id]};
  const change=await fetch(appUrl+'/api/records',{headers,method:'PATCH',body:JSON.stringify({
    version:0,changes:[{kind:'projects',id:project.id,action:'create',record:project},
      {kind:'projects',id:otherProject.id,action:'create',record:otherProject},
      {kind:'resources',id:resource.id,action:'create',record:resource},
      {kind:'resources',id:shared.id,action:'create',record:shared}],
  })});
  assert.equal(change.status,200);
  const response=await fetch(appUrl+'/api/records/projects/'+project.id,{headers});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).record,project);
  assert.equal((await fetch(appUrl+'/api/state')).status,401);
  const pgClient = new pg.Client({connectionString:runtime.href});
  let workspace;
  const repositories=[[project.id,'fixture/first'],[otherProject.id,'fixture/second']];
  try {
    await pgClient.connect();
    assert.equal((await pgClient.query("SELECT COUNT(*) FROM records WHERE kind='projects'")).rows[0].count,'2');
    workspace=(await pgClient.query('SELECT id FROM workspaces')).rows[0].id;
    const checkedAt=new Date().toISOString();
    for(const [projectId,repository] of repositories) {
      const sample={repository,checkedAt,state:'connected',
        commits:[{sha:'a'.repeat(40),subject:'Verified scoped sample',committedAt:checkedAt}]};
      await pgClient.query('INSERT INTO github_snapshots(workspace_id,project_id,repo,checked_at,status,payload) VALUES($1,$2,$3,$4,$5,$6)',
        [workspace,projectId,repository,checkedAt,'connected',JSON.stringify(sample)]);
    }
  } finally { await pgClient.end(); }
  await stopServer();
  const agentToken='synthetic-runtime-monitor-agent-fixture-only';
  const webhookSecret=randomBytes(32).toString('hex');
  appUrl=await startServer({...env, PROJECTOS_MONITOR_WORKSPACE:workspace,
    PROJECTOS_MONITOR_AGENT_TOKEN:agentToken, PROJECTOS_MONITOR_AGENT_RESOURCES:resource.id,
    PROJECTOS_GITHUB_PROJECTS:JSON.stringify(repositories.map(([projectId,repository])=>({workspaceId:workspace,projectId,repository}))),
    PROJECTOS_GITHUB_TOKEN:'synthetic-binding-fixture',PROJECTOS_GITHUB_WEBHOOK_SECRET:webhookSecret});
  headers.Origin=appUrl;
  const observe=(body, token=agentToken)=>fetch(appUrl+'/api/monitoring/observations',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify(body),signal:AbortSignal.timeout(10_000),
  });
  const reading={resourceId:resource.id,cpuPercent:25,usedBytes:512,totalBytes:1024,
    diskUsedBytes:6144,diskTotalBytes:8192,observedAt:new Date().toISOString()};
  assert.equal((await observe(reading,'invalid-fixture')).status,401);
  assert.equal((await observe({...reading,diskTotalBytes:undefined})).status,422);
  assert.equal((await observe({...reading,diskUsedBytes:9999})).status,422);
  assert.equal((await observe({...reading,resourceId:'other-resource'})).status,404);
  assert.deepEqual(await (await observe(reading)).json(),{accepted:true});
  assert.deepEqual(await (await observe(reading)).json(),{accepted:false});
  assert.deepEqual(await (await observe({...reading,observedAt:new Date(Date.parse(reading.observedAt)-1000).toISOString(),
    diskUsedBytes:undefined,diskTotalBytes:undefined})).json(),{accepted:true});
  const endpoint=appUrl+'/api/monitoring?resourceId='+resource.id;
  assert.equal((await fetch(endpoint)).status,401);
  const monitored=await fetch(endpoint,{headers});
  assert.equal(monitored.status,200);
  const {machineObservations}=await monitored.json();
  assert.equal(machineObservations.length,2);
  assert.deepEqual(machineObservations[0],{resourceId:resource.id,checkedAt:reading.observedAt,source:'machine-agent',
    state:'observed',cpuPercent:25,usedBytes:512,totalBytes:1024,diskUsedBytes:6144,diskTotalBytes:8192});
  assert.equal(machineObservations[1].diskUsedBytes,null);
  assert.equal(machineObservations[1].diskTotalBytes,null);
  assert.equal((await fetch(appUrl+'/api/monitoring?resourceId=other-resource',{headers})).status,404);
  const viewer='runtime-viewer@example.test';
  const invitation=await fetch(appUrl+'/api/team/invitations',{method:'POST',headers,
    body:JSON.stringify({email:viewer,role:'viewer',projectIds:[otherProject.id]})});
  assert.equal(invitation.status,200);
  const inviteBody={token:(await invitation.json()).token,email:viewer,password:account.password,displayName:'Fixture viewer'};
  const accept=body=>fetch(appUrl+'/api/auth/accept-invite',{method:'POST',
    headers:{'Content-Type':'application/json',Origin:appUrl,'Sec-Fetch-Site':'same-origin'},
    body:JSON.stringify(body)});
  assert.equal((await accept({...inviteBody,email:'different@example.test'})).status,422);
  const joined=await accept(inviteBody);
  assert.equal(joined.status,200);
  assert.equal((await accept(inviteBody)).status,422);
  const viewerHeaders={Cookie:joined.headers.get('set-cookie').split(';',1)[0]};
  const version=(await (await fetch(appUrl+'/api/state',{headers})).json()).version;
  const revisions=[project,otherProject].map(({id})=>({kind:'docs',id:'doc-'+id,action:'create',
    record:{id:'doc-'+id,projectId:id,title:'Synthetic runbook',type:'Runbook',body:'Synthetic history evidence',
      revision:1,updated:'2026-11-20'}}));
  assert.equal((await fetch(appUrl+'/api/records',{headers,method:'PATCH',body:JSON.stringify({version,changes:revisions})})).status,200);
  const history=(id,session)=>fetch(appUrl+'/api/docs/history?id=doc-'+id,{headers:session});
  const [ownerHistory,visibleHistory,hiddenHistory]=await Promise.all([
    history(project.id,headers),history(otherProject.id,viewerHeaders),history(project.id,viewerHeaders),
  ]);
  assert.equal(ownerHistory.status,200);
  assert.equal((await ownerHistory.json()).versions.length,1);
  assert.equal(visibleHistory.status,200);
  assert.equal((await visibleHistory.json()).versions.length,1);
  assert.equal(hiddenHistory.status,404);
  const memberEmail='runtime-editor@example.test';
  const editorInvite=await fetch(appUrl+'/api/team/invitations',{method:'POST',headers,
    body:JSON.stringify({email:memberEmail,role:'editor',projectIds:[otherProject.id]})});
  assert.equal(editorInvite.status,200);
  const editorJoin=await fetch(appUrl+'/api/auth/accept-invite',{method:'POST',
    headers:{'Content-Type':'application/json',Origin:appUrl,'Sec-Fetch-Site':'same-origin'},
    body:JSON.stringify({token:(await editorInvite.json()).token,email:memberEmail,password:account.password,displayName:'Fixture editor'})});
  assert.equal(editorJoin.status,200);
  const editorHeaders={...headers,Cookie:editorJoin.headers.get('set-cookie').split(';',1)[0]};
  const ownDirectoryEntry = async session => (await (await fetch(appUrl+'/api/state',{headers:session})).json()).data.users[0];
  const viewerAccount = await ownDirectoryEntry(viewerHeaders);
  const editorAccount = await ownDirectoryEntry(editorHeaders);
  const ownerAccount = await ownDirectoryEntry(headers);
  const scopedHttpHeaders = session => ({...headers,...session,Origin:appUrl});
  const authAction = (route,method,session,body)=>fetch(appUrl+'/api/auth/'+route,{
    method,headers:scopedHttpHeaders(session),body:body ? JSON.stringify(body) : undefined,
  });
  const login = email => authAction('login','POST',{}, {email,password:account.password});
  const extraLogin = await login(memberEmail);
  assert.equal(extraLogin.status,200);
  const otherEditorSession = {Cookie:extraLogin.headers.get('set-cookie').split(';',1)[0]};
  const accountSessions = await (await authAction('sessions','GET',editorHeaders)).json();
  assert.equal(accountSessions.count,2);
  assert.equal(accountSessions.sessions.filter(session=>session.current).length,1);
  const rawDigest = createHash('sha256').update(otherEditorSession.Cookie.split('=')[1]).digest('hex');
  assert.ok(!JSON.stringify(accountSessions).includes(rawDigest));
  const target = accountSessions.sessions.find(session=>!session.current);
  const revoke = await authAction('sessions','POST',editorHeaders,{action:'revokeOne',password:account.password,sessionId:target.id});
  assert.equal(revoke.status,200);
  assert.deepEqual(await revoke.json(),{ok:true,revoked:1,signedOut:false});
  assert.equal((await fetch(appUrl+'/api/state',{headers:otherEditorSession})).status,401);
  const enrollment = await authAction('mfa','POST',viewerHeaders,{action:'start',password:account.password});
  assert.equal(enrollment.status,200);
  const confirmation = await authAction('mfa','POST',viewerHeaders,{action:'confirm',code:totp((await enrollment.json()).secret)});
  assert.equal(confirmation.status,200);
  const recovery = (await confirmation.json()).recoveryCodes[0];
  const enrolledViewer = {Cookie:confirmation.headers.get('set-cookie').split(';',1)[0]};
  assert.equal((await fetch(appUrl+'/api/state',{headers:viewerHeaders})).status,401);
  assert.deepEqual(await (await authAction('mfa','GET',enrolledViewer)).json(),{enabled:true,recoveryCodesRemaining:10});
  assert.equal((await login(viewer)).status,401);
  const recover=()=>authAction('login','POST',{}, {email:viewer,password:account.password,recoveryCode:recovery});
  const recovered=await recover();
  assert.equal(recovered.status,200);
  assert.equal((await recover()).status,401);
  viewerHeaders.Cookie=recovered.headers.get('set-cookie').split(';',1)[0];
  assert.deepEqual(await (await authAction('mfa','GET',viewerHeaders)).json(),{enabled:true,recoveryCodesRemaining:9});
  for (const session of [viewerHeaders,editorHeaders]) {
    const state=await (await fetch(appUrl+'/api/state',{headers:session})).json();
    assert.equal(state.data.users.length,1);
    assert.notEqual(state.data.users[0].id,ownerAccount.id);
    const result=await fetch(appUrl+'/api/records/resources/'+shared.id,{headers:session});
    assert.equal(result.status,200);
    assert.deepEqual((await result.json()).record,{
      ...Object.fromEntries(Object.entries(shared).filter(([name])=>name!=='parentId')),
      projectId:otherProject.id,linkedProjectIds:[],
    });
  }
  assert.deepEqual((await (await fetch(appUrl+'/api/records/resources/'+shared.id,{headers})).json()).record,shared);
  const commit=async (changes,session=headers)=>{
    const state=await (await fetch(appUrl+'/api/state',{headers:session})).json();
    return fetch(appUrl+'/api/records',{headers:scopedHttpHeaders(session),method:'PATCH',body:JSON.stringify({version:state.version,changes})});
  };
  const makeTask=(id,projectId,dependencies=[])=>({id,projectId,title:id,status:'todo',priority:'medium',
    owner:'',due:'2031-03-01',description:'',checklist:[],comments:[],dependencies});
  const taskChange=(record,action='create')=>({kind:'tasks',id:record.id,record,action});
  const privateTask=makeTask('legacy-private-task',project.id);
  const editorTask=makeTask('legacy-editor-task',otherProject.id,[privateTask.id]);
  assert.equal((await commit([taskChange(privateTask),taskChange(editorTask)])).status,200);
  assert.equal((await fetch(appUrl+'/api/records/tasks/'+privateTask.id,{headers:editorHeaders})).status,404);
  const updatedTask={...editorTask,title:'Updated editor task',dependencies:[]};
  assert.equal((await commit([taskChange(updatedTask,'replace')],editorHeaders)).status,200);
  const ownerTask=await (await fetch(appUrl+'/api/records/tasks/'+editorTask.id,{headers})).json();
  assert.deepEqual(ownerTask.record.dependencies,[privateTask.id]);
  assert.equal((await commit([taskChange({...updatedTask,dependencies:[privateTask.id]},'replace')],editorHeaders)).status,422);
  const timedTask={...makeTask('timed-editor-task',otherProject.id),noticeDays:3};
  assert.equal((await commit([taskChange(timedTask)],editorHeaders)).status,200);
  const alertId='auto-'+createHash('sha256').update([workspace,'یادآوری',timedTask.id,timedTask.due,'tasks'].join('|')).digest('hex').slice(0,28);
  const noticeDatabase=new pg.Client({connectionString:runtime.href});
  await noticeDatabase.connect();
  try {
    const alert={id:alertId,projectId:otherProject.id,source:'زمان‌بند داخلی · ثبت خودکار',state:'open'};
    await noticeDatabase.query(`INSERT INTO records(workspace_id,kind,id,project_id,payload,updated_at)
      VALUES($1,'incidents',$2,$3,$4,now())`,[workspace,alertId,otherProject.id,JSON.stringify(alert)]);
    await noticeDatabase.query(`INSERT INTO notification_outbox(id,workspace_id,reminder_id,scheduled_for,channel,state,created_at)
      VALUES($1,$2,$3,$4,'telegram','pending',now())`,['tg-'+alertId,workspace,'tasks:'+timedTask.id,timedTask.due]);
    assert.equal((await commit([taskChange({...timedTask,due:'2031-03-09'},'replace')],editorHeaders)).status,200);
    assert.equal((await noticeDatabase.query('SELECT id FROM records WHERE id=$1',[alertId])).rowCount,0);
    assert.equal((await noticeDatabase.query('SELECT state FROM notification_outbox WHERE id=$1',['tg-'+alertId])).rows[0].state,'cancelled');
  } finally { await noticeDatabase.end(); }
  const first=makeTask('cycle-first',otherProject.id,['cycle-second']);
  const second=makeTask('cycle-second',otherProject.id,['cycle-first']);
  assert.equal((await commit([taskChange(first),taskChange(second)],editorHeaders)).status,422);
  assert.equal((await fetch(appUrl+'/api/records/tasks/'+first.id,{headers})).status,404);
  assert.equal((await fetch(endpoint,{headers:viewerHeaders})).status,404);
  const github=appUrl+'/api/integrations/github';
  assert.equal((await fetch(github,{headers:viewerHeaders})).status,403);
  assert.equal((await fetch(github+'?projectId='+project.id,{headers:viewerHeaders})).status,404);
  const visible=await fetch(github+'?projectId='+otherProject.id,{headers:viewerHeaders});
  assert.equal(visible.status,200);
  assert.deepEqual((await visible.json()).repositories.map(({repository})=>repository),['fixture/second']);
  const denied=await fetch(github,{method:'POST',headers:{...headers,...viewerHeaders},
    body:JSON.stringify({projectId:otherProject.id,repository:'fixture/second',backfill:true})});
  assert.equal(denied.status,403);
  const mismatched=await fetch(github,{method:'POST',headers,
    body:JSON.stringify({projectId:project.id,repository:'fixture/second',backfill:true})});
  assert.equal(mismatched.status,404);
  const githubPayload=JSON.stringify({repository:{full_name:'fixture/second'}});
  const deliveryHeaders={'Content-Type':'application/json','X-GitHub-Event':'push','X-GitHub-Delivery':randomUUID(),
    'X-Hub-Signature-256':'sha256='+createHmac('sha256',webhookSecret).update(githubPayload).digest('hex')};
  const webhook=()=>fetch(github+'/webhook',{method:'POST',headers:deliveryHeaders,body:githubPayload});
  assert.deepEqual(await (await webhook()).json(),{accepted:1});
  assert.deepEqual(await (await webhook()).json(),{accepted:0});
  const refreshed=await (await fetch(github+'?projectId='+otherProject.id,{headers:viewerHeaders})).json();
  assert.equal(refreshed.repositories[0].state,'pending_refresh');
  const disposable={...otherProject,id:'disposable-project',status:'archived'};
  assert.equal((await commit([{kind:'projects',id:disposable.id,action:'create',record:disposable}])).status,200);
  assert.equal((await commit([{kind:'projects',id:disposable.id,action:'delete'}])).status,200);
  const published=await fetch(appUrl+'/api/activity',{method:'POST',headers,
    body:JSON.stringify({projectId:project.id,title:'Verified synthetic activity',detail:'Fixture evidence from the PostgreSQL HTTP run.'})});
  assert.equal(published.status,200);
  const resume=(scope,cookies=headers)=>fetch(appUrl+'/api/assistant',{method:'POST',headers:{...headers,...cookies},
    body:JSON.stringify({intent:'resume',projectId:scope,allowExternal:true})});
  const resumed=await resume(project.id);
  assert.equal(resumed.status,200);
  const memory=await resumed.json();
  assert.equal(memory.mode,'resume');
  assert.equal(memory.externalTransmission,false);
  assert.ok(memory.answer.includes(project.next));
  assert.ok(memory.answer.includes('Verified synthetic activity'));
  const activity=memory.citations.find(item=>item.kind==='activity').href;
  assert.equal((await fetch(appUrl+activity,{headers})).status,200);
  const readEvent=await fetch(appUrl+'/api'+activity,{headers});
  assert.equal(readEvent.status,200);
  assert.equal((await readEvent.json()).activity.title,'Verified synthetic activity');
  assert.equal((await fetch(appUrl+'/api'+activity,{headers:viewerHeaders})).status,404);
  const hiddenPage=await (await fetch(appUrl+activity,{headers:viewerHeaders})).text();
  assert.ok(hiddenPage.includes('صفحه پیدا نشد'));
  assert.ok(!hiddenPage.includes('Verified synthetic activity'));
  assert.equal((await resume(project.id,viewerHeaders)).status,404);
  assert.equal((await resume(otherProject.id,viewerHeaders)).status,200);
  const writeActivity=body=>fetch(appUrl+'/api/activity',{method:'POST',headers,body:JSON.stringify(body)});
  const checkpoint={projectId:project.id,title:'Synthetic recorded follow-up',detail:'A local PostgreSQL task fixture.'};
  assert.equal((await writeActivity({...checkpoint,createTask:'true'})).status,422);
  assert.equal((await writeActivity({...checkpoint,createTask:true})).status,200);
  const {data:withFollowUp}=await (await fetch(appUrl+'/api/state',{headers})).json();
  const task=withFollowUp.tasks.find(item=>item.title===checkpoint.title);
  assert.ok(task?.id);
  assert.equal(task.projectId,project.id);
  assert.equal(withFollowUp.events.filter(item=>item.source==='ثبت دستی'&&item.title===checkpoint.title).length,1);
  assert.equal((await fetch(appUrl+'/api/records/tasks/'+task.id,{headers:viewerHeaders})).status,404);
  const changeGrant=(memberId,projects,session=headers)=>fetch(appUrl+'/api/team/members/'+memberId,{
    method:'PATCH',headers:scopedHttpHeaders(session),body:JSON.stringify({projectIds:projects}),
  });
  assert.equal((await changeGrant(editorAccount.id,[project.id],editorHeaders)).status,403);
  assert.equal((await changeGrant(viewerAccount.id,[project.id],viewerHeaders)).status,403);
  assert.equal((await changeGrant(editorAccount.id,[project.id])).status,200);
  assert.equal((await fetch(appUrl+'/api/records/tasks/'+editorTask.id,{headers:editorHeaders})).status,404);
  assert.equal((await fetch(appUrl+'/api/records/tasks/'+privateTask.id,{headers:editorHeaders})).status,200);
  assert.equal((await fetch(appUrl+'/api/team/members/'+editorAccount.id,{method:'DELETE',headers})).status,200);
  assert.equal((await fetch(appUrl+'/api/state',{headers:editorHeaders})).status,401);
  await stopServer('SIGKILL');
  const migrated = execFileSync(process.execPath,[resolve('scripts/migrate-postgres.mjs')],{
    env:{...env,PROJECTOS_DATABASE_URL:runtime.href},encoding:'utf8',timeout:30_000,
  });
  assert.doesNotMatch(migrated,/Applied/);
  appUrl=await startServer(env);
  const restarted=await fetch(appUrl+'/api/records/tasks/'+task.id,{headers});
  assert.equal(restarted.status,200);
  assert.equal((await restarted.json()).record.title,checkpoint.title);
  assert.equal((await fetch(appUrl+'/api/state',{headers:editorHeaders})).status,401);
  await stopServer();
  appUrl=await startServer({...env,PROJECTOS_DATABASE_URL:''});
  assert.equal((await fetch(appUrl+'/api/health')).status,503);
  await stopServer();
  appUrl=await startServer({...env,PROJECTOS_DATABASE_URL:runtime.href});
  assert.equal((await fetch(appUrl+'/api/health')).status,503);
  await stopServer();
  appUrl=await startServer({...env,PROJECTOS_DB_SCOPE_KEY:randomBytes(32).toString('hex')});
  assert.equal((await fetch(appUrl+'/api/health')).status,503);
  console.log(JSON.stringify({ok:true,mode:'production-build-http-postgresql',machineObservation:'scoped-with-disk',
    github:'project-scoped',memory:'scoped-project-and-activity-citations',identity:'mfa-and-session-revocation-verified',
    sharedResources:'projected',cutover:'acknowledged-commit-and-no-sqlite-fallback'}));
} finally {
  await stopServer();
  if (existed) await admin.query('DROP DATABASE "' + database + '"');
  if (roleCreated) await admin.query('DROP ROLE "' + runtimeRole + '"');
  await admin.end();
  await rm(scratch,{recursive:true,force:true,maxRetries:4});
}
