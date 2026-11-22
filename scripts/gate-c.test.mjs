import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configuredChannels } from './notification-providers.mjs';
import { localProvider, providerFixtureEnv, reply } from './test-provider-http.mjs';
import { vaultSettings, verifyVaultReference } from '../src/lib/server/vault.ts';
import { localInstant,wallClock } from '../src/lib/reminder-time.ts';

test('Vault contract accepts active KV v2 metadata and reports authorization, missing references and outages', async t => {
  const requests = [];
  let serve = (_request,response) => reply(response,200,{data:{
    current_version:4,versions:{4:{destroyed:false,deletion_time:''}},custom_metadata:{fixture:'ignored'},
  }});
  const mock = await localProvider((request,response) => {
    requests.push({method:request.method,url:request.url,token:request.headers['x-vault-token']});
    serve(request,response);
  });
  t.after(() => mock.close());
  const workspace = 'synthetic-fixture';
  const env = {
    PROJECTOS_VAULT_WORKSPACE:workspace,PROJECTOS_VAULT_ORIGIN:'https://vault.example.test',
    PROJECTOS_VAULT_MOUNTS:'kv',PROJECTOS_VAULT_TOKEN:'fixture.vault.token',PROJECTOS_VAULT_PREFIXES:'kv/project',
  };
  const settings = vaultSettings(workspace,env);
  assert.ok(settings);
  assert.equal(vaultSettings('other-workspace',env),undefined);
  assert.equal(vaultSettings(workspace,{...env,PROJECTOS_VAULT_ORIGIN:'http://vault.example.test'}),undefined);
  assert.equal(vaultSettings(workspace,{...env,PROJECTOS_VAULT_MOUNTS:'kv,wrong/mount'}),undefined);
  const ref = {vaultProvider:'HashiCorp Vault',vaultMount:'kv',vaultPath:'project/synthetic'};
  const verify = (pointer=ref) => verifyVaultReference(pointer,settings,mock.request);
  assert.deepEqual(await verify(),{status:'verified',providerVersion:4});
  assert.deepEqual(requests,[{method:'GET',url:'/v1/kv/metadata/project/synthetic',token:env.PROJECTOS_VAULT_TOKEN}]);
  assert.equal((await verify({...ref,vaultMount:'unapproved'})).status,'not_configured');
  assert.equal((await verify({...ref,vaultPath:'invalid reference'})).status,'not_configured');
  assert.equal((await verify({...ref,vaultPath:'unapproved/synthetic'})).status,'not_configured');
  assert.equal(requests.length,1);
  for (const [code,expected] of [[401,'permission_denied'],[403,'permission_denied'],[404,'not_found'],
    [429,'unavailable'],[503,'unavailable']]) {
    serve = (_request,response) => reply(response,code,{errors:['fixture-only provider error']});
    assert.deepEqual(await verify(),{status:expected,providerVersion:null});
  }
  serve = (_request,response) => reply(response,200,{data:{current_version:4,versions:{4:{destroyed:false}}}});
  assert.equal((await verify()).status,'unavailable');
  serve = (_request,response) => reply(response,200,{data:{current_version:4,versions:{4:{destroyed:true,deletion_time:''}}}});
  assert.equal((await verify()).status,'not_found');
  serve = (_request,response) => reply(response,200,{data:'x'.repeat(300_000)});
  assert.equal((await verify()).status,'unavailable');
  serve = (_request,response) => response.destroy();
  assert.equal((await verify()).status,'unavailable');
  serve = () => {};
  const timeout = await verifyVaultReference(ref,settings,(url,options) => mock.request(url,{
    ...options,signal:AbortSignal.any([options.signal,AbortSignal.timeout(100)]),
  }));
  assert.equal(timeout.status,'unavailable');
});

test('Telegram and Resend speak their HTTP contracts and classify failures without retaining responses', async t => {
  const seen = [];
  let serve = (request,response) => request.url === '/emails'
    ? reply(response,200,{id:'e12ac673-7518-4d29-8f67-d53d2d55edee',extra:'ignored'})
    : reply(response,200,{ok:true,result:{message_id:12,extra:'ignored'}});
  const mock = await localProvider((request,response,body) => {
    seen.push({route:request.url,method:request.method,headers:request.headers,body});
    serve(request,response);
  });
  t.after(() => mock.close());
  const channels = configuredChannels(providerFixtureEnv,mock.request,500);
  const job = {id:'fixture-notification',scheduled_for:'2031-05-12',
    telegram_title:'عنوان <em>آزمایشی</em>',telegram_project:'پروژهٔ ساختگی'};
  assert.deepEqual(await channels.telegram(job),{kind:'accepted',id:'12'});
  assert.deepEqual(await channels.email(job),{kind:'accepted',id:'e12ac673-7518-4d29-8f67-d53d2d55edee'});
  assert.match(seen[0].route,/\/sendMessage$/);
  assert.equal(seen[0].method,'POST');
  assert.match(seen[0].body.text,/عنوان <em>آزمایشی<\/em>/);
  assert.match(seen[0].body.text,/پروژهٔ ساختگی/);
  assert.equal(seen[0].body.parse_mode,undefined);
  assert.equal(seen[1].headers['idempotency-key'],job.id);
  assert.match(seen[1].body.html,/lang="fa" dir="rtl"/);
  assert.match(seen[1].body.text,/یادآوری/);
  assert.doesNotMatch(JSON.stringify(seen[1].body),/ساختگی|<em>/);
  assert.equal(configuredChannels({...providerFixtureEnv,PROJECTOS_EMAIL_TO:'invalid'},mock.request).email,undefined);
  const privateChannels = configuredChannels({...providerFixtureEnv,PROJECTOS_TELEGRAM_PROJECT_DETAILS:'disabled'},mock.request);
  await privateChannels.telegram(job);
  assert.doesNotMatch(seen.at(-1).body.text,/ساختگی|آزمایشی/);
  await channels.telegram({...job,telegram_title:'password=synthetic-fixture-only'});
  assert.doesNotMatch(seen.at(-1).body.text,/synthetic-fixture-only/);
  for (const [status,kind,reason] of [[401,'failed','provider_permission'],[403,'failed','provider_permission'],
    [400,'failed','provider_rejected'],[429,'retry','rate_limited'],[500,'retry','provider_unavailable']]) {
    serve = (_request,response) => reply(response,status,{parameters:{retry_after:60},description:'private fixture error'},{'Retry-After':'45'});
    for (const [channel,send] of Object.entries(channels)) {
      const result = await send(job);
      assert.equal(result.kind,kind);
      assert.equal(result.reason,reason);
      if (status === 429) assert.equal(result.retryMs,channel === 'telegram' ? 60_000 : 45_000);
      assert.doesNotMatch(JSON.stringify(result),/private fixture/);
    }
  }
  for (const disconnected of [true,false]) {
    serve = (_request,response) => { if (disconnected) response.destroy(); };
    for (const send of Object.values(channels)) assert.deepEqual(await send(job),{kind:'unknown',reason:'outcome_unknown'});
  }
});

test('reminder wall clock conversion preserves zone dates and handles DST gaps and overlaps', () => {
  assert.equal(new Date(localInstant('2031-01-02T00:15:00','Asia/Tehran')).toISOString(),'2031-01-01T20:45:00.000Z');
  assert.equal(wallClock('Asia/Tehran',new Date('2031-01-01T20:45:00Z')),'2031-01-02T00:15:00');
  assert.equal(wallClock('Europe/Berlin',new Date(localInstant('2027-03-28T02:30:00','Europe/Berlin'))),'2027-03-28T03:30:00');
  assert.equal(new Date(localInstant('2027-10-31T02:30:00','Europe/Berlin')).toISOString(),'2027-10-31T00:30:00.000Z');
});
