import { createHash } from 'node:crypto';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { promisify } from 'node:util';
import { localProvider, providerFixtureEnv, reply } from '../scripts/test-provider-http.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresFixture } from './postgres-fixture';
import { expect, type Page } from '@playwright/test';
import { setupToken, startTestApp, test } from './isolated-app';
import { totp } from '../src/lib/server/mfa';

const email = 'local-owner@example.test';
const password = 'synthetic-local-acceptance-password';
const workspace = 'فضای آزمایشی پذیرش';

async function startFreshPostgresApp(postgres:PostgresFixture,vault?:Parameters<typeof startTestApp>[0]['vault']) {
  const area=await mkdtemp(join(tmpdir(),'projectos-restart-'));
  const remove=() => rm(area,{recursive:true,force:true,maxRetries:5});
  try {
    const started=await startTestApp({sqlitePath:join(area,'unused.sqlite'),postgresUrl:postgres.url,postgresScopeKey:postgres.scopeKey,vault});
    return {url:started.url,async stop() { try { await started.stop(); } finally { await remove(); } }};
  } catch (error) { await remove(); throw error; }
}

async function signIn(page: Page, address: string, secret: string) {
  await page.getByLabel('ایمیل', {exact:true}).fill(address);
  await page.getByLabel('رمز عبور', {exact:true}).fill(secret);
  await page.getByRole('button', {name:'ورود امن',exact:true}).click();
}

test('credential forms fail closed before client JavaScript starts', async ({browser,appURL}) => {
  const context=await browser.newContext({
    baseURL:appURL,ignoreHTTPSErrors:appURL.startsWith('https:'),javaScriptEnabled:false,
  });
  try {
    const page=await context.newPage();
    for (const route of ['/login','/setup','/join']) {
      expect((await page.goto(route))?.status()).toBe(200);
      const form=page.locator('form');
      await expect(form).toHaveAttribute('method','post');
      await expect(form.locator('button[type=submit]')).toBeDisabled();
    }
  } finally { await context.close(); }
});

test('bootstrap, failed sign-in, session expiry, rate limit and account menu logout', async ({page,origin,postgresFixture}) => {
  if (!postgresFixture) throw new Error('This scenario requires PostgreSQL');
  const {rows:schema} = await postgresFixture.query<{id:string}>('SELECT id FROM projectos_schema_migrations ORDER BY id');
  expect(schema.slice(0,21).map(({id})=>id.slice(0,3))).toEqual(
    Array.from({length:21},(_, index)=>String(index+1).padStart(3,'0')));
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('link',{name:'راه‌اندازی مالک اولیه'}).click();
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('توکن راه‌اندازی').fill('invalid-setup-fixture');
  await page.getByLabel('نام', {exact:true}).fill("کاربر آزمایشی O'Neil");
  await page.getByLabel('ایمیل حساب').fill(email);
  await page.getByLabel('نام فضای کاری').fill(workspace);
  await page.getByLabel(/رمز قدرتمند/).fill(password);
  await page.getByRole('button',{name:'ایجاد فضای کاری امن'}).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('توکن راه‌اندازی یا اطلاعات حساب معتبر نیست');
  await page.getByLabel('توکن راه‌اندازی').fill(setupToken);
  await page.getByRole('button',{name:'ایجاد فضای کاری امن'}).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.goto('/dashboard');
  await page.reload();
  await expect(page.getByRole('heading',{name:'سلام! همه‌چیز اینجاست'})).toBeVisible();
  await page.getByRole('button',{name:'حساب کاربری',exact:true}).click();
  await page.getByRole('button',{name:'خروج امن',exact:true}).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get('/api/state')).status()).toBe(401);
  await signIn(page,email,'incorrect-synthetic-password');
  await expect(page.locator('form').getByRole('alert')).toContainText('ایمیل یا رمز معتبر نیست');
  await signIn(page,email,password);
  await expect(page).toHaveURL(/\/dashboard$/);
  const expired = Date.now() - 1;
  await postgresFixture.query('UPDATE sessions SET expires_at=$1',[expired]);
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  const now = Date.now();
  const expiresAt = Math.floor(now / 60_000) * 60_000 + 60_000;
  const bucket = createHash('sha256').update('global').digest('hex');
  await postgresFixture.query(`INSERT INTO auth_rate_limits(scope,bucket,expires_at,hits) VALUES('login:global',$1,$2,60)
    ON CONFLICT(scope,bucket) DO UPDATE SET expires_at=excluded.expires_at,hits=excluded.hits`,[bucket,expiresAt]);
  const limited = await page.request.post('/api/auth/login',{headers:origin,data:{email,password}});
  expect(limited.status()).toBe(429);
  expect(Number(limited.headers()['retry-after'])).toBeGreaterThanOrEqual(1);
  expect((await page.request.get('/api/state')).status()).toBe(401);
});

test('a viewer joins through the browser, then loses access when the owner revokes the grant', async ({page,browser,appURL,origin}) => {
  expect((await page.request.post('/api/auth/setup',{headers:origin,data:{
    setupToken,email,password,displayName:'مالک آزمایشی',workspace,
  }})).status()).toBe(200);
  const project={id:'shared-project',name:'پروژهٔ مجاز',subtitle:'',coverTitle:'پروژهٔ مجاز',description:'',
    status:'building',type:'وب‌سایت',progress:0,next:'',art:'navigation/projects'};
  expect((await page.request.post('/api/records/projects/'+project.id,{headers:origin,data:{version:0,record:project}})).status()).toBe(200);
  const viewerEmail='invited-local-viewer@example.test';
  const revokedEmail='revoked-local-viewer@example.test';
  const revokedInvite=await page.request.post('/api/team/invitations',{headers:origin,data:{
    email:revokedEmail,role:'viewer',projectIds:[project.id],
  }});
  expect(revokedInvite.status()).toBe(200);
  const revoked=await revokedInvite.json();
  const revoke=await page.request.delete('/api/team/invitations',{headers:origin,data:{id:revoked.id}});
  expect(await revoke.json()).toEqual({revoked:true});
  const invite=await page.request.post('/api/team/invitations',{headers:origin,data:{
    email:viewerEmail,role:'viewer',projectIds:[project.id],
  }});
  expect(invite.status()).toBe(200);
  const guest=await browser.newContext({baseURL:appURL,ignoreHTTPSErrors:appURL.startsWith('https:')});
  try {
    expect((await guest.request.post('/api/auth/accept-invite',{headers:origin,data:{
      token:revoked.token,email:revokedEmail,password,displayName:'دعوت لغوشده',
    }})).status()).toBe(422);
    const joined=await guest.newPage();
    await joined.goto('/join');
    await joined.getByLabel('کد دعوت',{exact:true}).fill((await invite.json()).token);
    await joined.getByLabel('ایمیل دعوت‌شده').fill(viewerEmail);
    await joined.getByLabel('نام نمایشی').fill('بیننده آزمایشی');
    await joined.getByLabel(/رمز عبور/).fill(password);
    await joined.getByRole('button',{name:'ایجاد حساب و ورود'}).click();
    await expect(joined).toHaveURL(/\/dashboard$/);
    await joined.goto('/projects');
    await expect(joined.getByText(project.name,{exact:true}).first()).toBeVisible();
    const memberState=await (await joined.request.get('/api/state')).json();
    const memberId=memberState.data.users[0].id;
    await joined.goto('/finance');
    await expect(joined.getByRole('heading',{name:'هزینه‌ها و قراردادها'})).toBeVisible();
    const financialWrites=['هزینه جدید','ثبت اشتراک دوره‌ای','ثبت قرارداد','ثبت درآمد'];
    for (const name of financialWrites) await expect(joined.getByRole('button',{name,exact:true})).toHaveCount(0);
    await joined.goto('/projects');
    expect((await joined.request.patch('/api/team/members/'+memberId,{headers:origin,data:{projectIds:null}})).status()).toBe(403);
    expect((await page.request.patch('/api/team/members/'+memberId,{headers:origin,data:{projectIds:[]}})).status()).toBe(200);
    await joined.reload();
    await expect(joined.getByText(project.name,{exact:true})).toHaveCount(0);
    expect((await joined.request.get('/api/records/projects/'+project.id)).status()).toBe(404);
    expect((await page.request.delete('/api/team/members/'+memberId,{headers:origin})).status()).toBe(200);
    await joined.reload();
    await expect(joined).toHaveURL(/\/login$/);
  } finally { await guest.close(); }
});

test('independent browser sessions preserve workspace boundaries under concurrent writes', async ({page,browser,appURL,origin,postgresFixture}) => {
  if (!postgresFixture) throw new Error('This scenario requires PostgreSQL');
  const setup = await page.request.post('/api/auth/setup', {headers:origin,data:{
    setupToken,email,password,displayName:'مالک اول',workspace,
  }});
  expect(setup.status()).toBe(200);
  const secondEmail = 'second-owner@example.test';
  await postgresFixture.query(`WITH second_user AS (
    INSERT INTO users(id,email,display_name,password_hash,salt,created_at)
      SELECT 'second-owner',$1,'مالک دوم',password_hash,salt,now() FROM users WHERE email=$2
      RETURNING id
  ), second_workspace AS (
    INSERT INTO workspaces(id,name,created_at) VALUES('workspace-two','فضای دوم',now()) RETURNING id
  )
  INSERT INTO memberships(user_id,workspace_id,role) SELECT second_user.id,second_workspace.id,'owner'
    FROM second_user CROSS JOIN second_workspace`,[secondEmail,email]);
  const secondContext = await browser.newContext({baseURL:appURL,ignoreHTTPSErrors:appURL.startsWith('https:')});
  try {
    const second = await secondContext.newPage();
    await second.goto('/login');
    await signIn(second,secondEmail,password);
    await expect(second).toHaveURL(/\/dashboard$/);
    const create = async (client:Page,id:string,name:string) => {
      const record={id,name,subtitle:'',coverTitle:name,description:'',status:'building',
        type:'وب‌سایت',progress:0,next:'',art:'navigation/projects'};
      const result=await client.request.post('/api/records/projects/'+id,{headers:origin,data:{version:0,record}});
      expect(result.status(),await result.text()).toBe(200);
    };
    await Promise.all([create(page,'first-project','پروژهٔ اول'),create(second,'second-project','پروژهٔ دوم')]);
    await Promise.all([page.goto('/projects'),second.goto('/projects')]);
    await expect(page.getByText('پروژهٔ اول',{exact:true}).first()).toBeVisible();
    await expect(page.getByText('پروژهٔ دوم',{exact:true})).toHaveCount(0);
    await expect(second.getByText('پروژهٔ دوم',{exact:true}).first()).toBeVisible();
    await expect(second.getByText('پروژهٔ اول',{exact:true})).toHaveCount(0);
    expect((await page.request.get('/api/records/projects/second-project')).status()).toBe(404);
    expect((await second.request.get('/api/records/projects/first-project')).status()).toBe(404);
  } finally { await secondContext.close(); }
});

test('contracts, subscriptions and revenue preserve minor units and support versioned changes', async ({page,origin}) => {
  expect((await page.request.post('/api/auth/setup',{headers:origin,data:{
    setupToken,email,password,displayName:'مالک آزمایشی',workspace,
  }})).status()).toBe(200);
  const project={id:'finance-project',name:'پروژهٔ مالی آزمایشی',subtitle:'',coverTitle:'پروژهٔ مالی آزمایشی',description:'',
    status:'building',type:'وب‌سایت',progress:0,next:'',art:'navigation/projects'};
  expect((await page.request.post('/api/records/projects/'+project.id,{headers:origin,data:{version:0,record:project}})).status()).toBe(200);
  await page.goto('/finance');
  const forms = [
    {kind:'contracts', button:'ثبت قرارداد', title:'قرارداد محلی', table:'قراردادها'},
    {kind:'charges', button:'ثبت اشتراک دوره‌ای', title:'اشتراک محلی', table:'اشتراک‌های واقعی ثبت‌شده'},
    {kind:'revenues', button:'ثبت درآمد', title:'درآمد محلی', table:'درآمدهای واقعی ثبت‌شده'},
  ] as const;
  for (const form of forms) {
    await page.getByRole('button',{name:form.button,exact:true}).click();
    const dialog=page.getByRole('dialog');
    await dialog.getByLabel('عنوان',{exact:true}).fill(form.title);
    await dialog.getByLabel('پروژه',{exact:true}).selectOption(project.id);
    await dialog.getByLabel('واحد ارز').selectOption('USD');
    const amount=dialog.getByLabel('مبلغ (دلار تا دو رقم اعشار)');
    await amount.fill('12.30');
    if (form.kind==='contracts') {
      await dialog.getByLabel('نام مشتری').fill('مشتری ساختگی');
      await dialog.getByLabel('شروع (میلادی)').fill('2031-02-01');
      await dialog.getByLabel('پایان (میلادی)').fill('2031-01-01');
      await dialog.getByRole('button',{name:form.button,exact:true}).click();
      await expect(dialog.getByRole('alert')).toContainText('تاریخ پایان قرارداد');
      await dialog.getByLabel('پایان (میلادی)').fill('2031-03-01');
    }
    if (form.kind==='charges') await dialog.getByLabel('ارائه‌دهنده').fill('تأمین‌کنندهٔ ساختگی');
    await dialog.getByRole('button',{name:form.button,exact:true}).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('table',{name:form.table,exact:true}).getByRole('cell',{name:form.title,exact:true})).toBeVisible();
    if (form.kind==='contracts') {
      const reconciliation=page.getByRole('table',{name:'تطبیق قرارداد و فاکتور',exact:true});
      await expect(reconciliation.getByRole('row').filter({hasText:form.title}).getByText('بدون فاکتور',{exact:true})).toBeVisible();
    }
  }
  await page.reload();
  const saved=await (await page.request.get('/api/state')).json();
  expect(saved.data.contracts[0]).toMatchObject({amount:1230,amountUnit:'minor',state:'active'});
  expect(saved.data.charges[0]).toMatchObject({amount:1230,amountUnit:'minor',status:'active'});
  expect(saved.data.revenues[0]).toMatchObject({amount:1230,amountUnit:'minor',status:'received'});
  const contract=saved.data.contracts[0];
  const endpoint='/api/records/contracts/'+contract.id;
  const edited=await page.request.put(endpoint,{headers:origin,data:{version:saved.version,record:{...contract,state:'completed'}}});
  expect(edited.status()).toBe(200);
  expect((await page.request.put(endpoint,{headers:origin,data:{version:saved.version,record:contract}})).status()).toBe(409);
  expect((await (await page.request.get(endpoint)).json()).record.state).toBe('completed');
  expect((await page.request.delete(endpoint,{headers:origin,data:{version:(await edited.json()).version}})).status()).toBe(200);
  expect((await page.request.get(endpoint)).status()).toBe(404);
  await page.goto('/reports');
  const downloading=page.waitForEvent('download');
  await page.getByRole('button',{name:'خروجی گزارش'}).click();
  const download=await downloading;
  const exported=await download.path();
  expect(download.suggestedFilename()).toBe('projectos-report.csv');
  expect(exported).not.toBeNull();
  expect(await readFile(exported!,'utf8')).toContain('پروژهٔ مالی آزمایشی');
});

test.describe('mandatory MFA in the browser', () => {
  test.use({enforceMfa:true});
  test('enrolls from the restricted setup page and uses a recovery code once', async ({page,origin}) => {
    expect((await page.request.post('/api/auth/setup',{headers:origin,data:{
      setupToken,email,password,displayName:'مالک آزمایشی',workspace,
    }})).status()).toBe(200);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/mfa-enroll$/);
    expect((await page.request.get('/api/state')).status()).toBe(401);
    await page.getByLabel('رمز فعلی برای شروع فعال‌سازی').fill(password);
    await page.getByRole('button',{name:'شروع فعال‌سازی دومرحله‌ای'}).click();
    const seed = page.locator('p.font-mono.select-text');
    await expect(seed).toHaveText(/^[A-Z2-7]{32}$/);
    await page.getByLabel('کد شش‌رقمی برنامه Authenticator').fill(totp(await seed.textContent() ?? ''));
    await page.getByRole('button',{name:'تأیید و فعال‌سازی'}).click();
    const codes = page.locator('pre.font-mono');
    await expect(codes).toBeVisible();
    const recovery = (await codes.textContent() ?? '').split('\n');
    expect(recovery).toHaveLength(10);
    await page.getByRole('button',{name:'کدها را در محل امن ذخیره کردم؛ پنهان کن'}).click();
    await page.getByRole('link',{name:'ورود به فضای کاری'}).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    expect((await page.request.post('/api/auth/logout',{headers:origin})).status()).toBe(200);
    await page.goto('/login');
    await page.getByRole('checkbox',{name:'استفاده از کد بازیابی به‌جای Authenticator'}).check();
    await page.getByLabel('کد بازیابی یک‌بارمصرف').fill(recovery[0]);
    await signIn(page,email,password);
    await expect(page).toHaveURL(/\/dashboard$/);
    expect((await page.request.post('/api/auth/login',{headers:origin,data:{email,password,recoveryCode:recovery[0]}})).status()).toBe(401);
  });
});

test('restricted PostgreSQL reminder workers retry Telegram and email, then expose persistent status in Persian', async ({
  page, browser, origin, postgresFixture, testApp,
}) => {
  test.setTimeout(75_000);
  if (!postgresFixture) throw new Error('PostgreSQL is required');
  expect((await page.request.get('/api/notifications')).status()).toBe(401);
  expect((await page.request.post('/api/auth/setup',{headers:origin,data:{
    setupToken,email,password,displayName:'مالک آزمایشی',workspace,
  }})).status()).toBe(200);
  const project={id:'notification-fixture',name:'پروژهٔ اعلان آزمایشی',subtitle:'',coverTitle:'اعلان',description:'',
    status:'building',type:'وب‌سایت',progress:0,next:'',art:'navigation/projects'};
  expect((await page.request.post('/api/records/projects/'+project.id,{headers:origin,data:{version:0,record:project}})).status()).toBe(200);
  const workspaceId=(await postgresFixture.query<{id:string}>('SELECT id FROM workspaces')).rows[0].id;

  const title='یادآوری ارسال آزمایشی';
  await page.goto('/calendar');
  await page.getByRole('button',{name:'رویداد جدید',exact:true}).click();
  const form=page.getByRole('dialog');
  await form.getByLabel('عنوان رویداد',{exact:true}).fill(title);
  await form.getByLabel('پروژه',{exact:true}).selectOption(project.id);
  await form.getByLabel('منطقهٔ زمانی',{exact:true}).selectOption('UTC');
  const due=new Date(Date.now()+86_400_000).toISOString().slice(0,10);
  await form.getByLabel('موعد (میلادی)',{exact:true}).fill(due);
  await form.getByLabel('اعلان (روز قبل از موعد)',{exact:true}).fill('2');
  await form.getByRole('button',{name:'ثبت رویداد',exact:true}).click();
  await expect(form).toHaveCount(0);
  const {rows:[record]}=await postgresFixture.query<{id:string;payload:string}>(
    "SELECT id,payload FROM records WHERE workspace_id=$1 AND kind='reminders'",[workspaceId]);
  expect(JSON.parse(record.payload)).toMatchObject({title,due,noticeDays:2});

  const calls: {channel:string;key:string | undefined;body:unknown}[] = [];
  const mock=await localProvider((request,response,body) => {
    const channel=request.url === '/emails' ? 'email' : 'telegram';
    calls.push({channel,key:request.headers['idempotency-key']?.toString(),body});
    if (calls.filter(call => call.channel===channel).length===1) {
      reply(response,429,{ok:false,error_code:429,parameters:{retry_after:35}},{'Retry-After':'35'});
    } else if (channel==='email') reply(response,200,{id:'be542d47-c48b-4765-9f0a-3ee485ce16db'});
    else reply(response,200,{ok:true,result:{message_id:57}});
  });
  try {
    const run=promisify(execFile);
    const workerEnv=(url:string) => ({
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PROJECTOS_|^PG/i.test(key))),
      ...providerFixtureEnv,NODE_ENV:'test' as const,PROJECTOS_DATABASE_URL:url,PROJECTOS_DATABASE_MODE:'postgres',PROJECTOS_NOTIFICATION_WORKSPACE:workspaceId,
    });
    const [reminderUrl,deliveryUrl]=await Promise.all([
      postgresFixture.provisionWorker('reminder',workspaceId),postgresFixture.provisionWorker('delivery',workspaceId),
    ]);
    const schedule=() => run(process.execPath,['scripts/run-reminders.mjs'],{env:workerEnv(reminderUrl),timeout:15_000});
    await Promise.all([schedule(),schedule()]);
    const outbox=() => postgresFixture.query<{id:string;state:string;channel:string;attempts:number;retry_after:string}>(
      `SELECT o.id,o.state,o.channel,COALESCE(r.attempts,0) AS attempts,r.retry_after
      FROM notification_outbox o LEFT JOIN delivery_retries r ON o.id=r.notification_id WHERE o.workspace_id=$1 ORDER BY o.channel`,[workspaceId]);
    const initial=(await outbox()).rows;
    expect(initial.map(row => [row.channel,row.state])).toEqual([['email','pending'],['in_app','available'],['telegram','pending']]);
    const alert=initial.find(job => job.channel==='in_app')!.id;
    const deliver=(advance:number) => run(process.execPath,['--input-type=module','-e',`
      import { closeDatabase, requireWorkerWorkspace } from './scripts/database.mjs';
      import { configuredChannels, deliverNotifications } from './scripts/notification-delivery.mjs';
      const workspace=process.env.PROJECTOS_NOTIFICATION_WORKSPACE;
      const origin=new URL(process.argv[1]);
      const clock=() => Date.now()+Number(process.argv[2]);
      if (origin.protocol!=='http:' || origin.hostname!=='127.0.0.1') throw new Error('Loopback fixture required');
      const send=(url,options) => {
        const target=new URL(url);
        if (!['https://api.resend.com','https://api.telegram.org'].includes(target.origin)) throw new Error('Unexpected fixture provider');
        return fetch(origin.origin + target.pathname,options);
      };
      try {
        await requireWorkerWorkspace('delivery',workspace);
        await deliverNotifications(workspace,configuredChannels(process.env,send),30,clock);
      } finally { await closeDatabase(); }
    `,mock.origin,String(advance)],{env:workerEnv(deliveryUrl),timeout:15_000});
    await Promise.all([deliver(0),deliver(0)]);
    expect(calls.map(call => call.channel).sort()).toEqual(['email','telegram']);
    const path='/api/notifications?alert='+alert;
    const retry=await page.request.get(path);
    expect(retry.status()).toBe(200);
    expect((await retry.json()).delivery).toEqual(expect.arrayContaining([
      expect.objectContaining({channel:'email',status:'retrying',retryAt:expect.any(String)}),
      expect.objectContaining({channel:'telegram',status:'retrying',retryAt:expect.any(String)}),
    ]));
    expect(retry.headers()['cache-control']).toBe('private, no-store');
    await deliver(36_000);
    expect(calls).toHaveLength(4);
    expect(calls.filter(call => call.channel==='email').map(call => call.key)).toEqual([initial[0].id,initial[0].id]);
    expect(JSON.stringify(calls.find(call => call.channel==='telegram')?.body)).toContain(project.name);
    expect(JSON.stringify(calls.find(call => call.channel==='email')?.body)).not.toContain(project.name);
    expect((await outbox()).rows.filter(row => row.channel!=='in_app').map(row => [row.state,row.attempts]))
      .toEqual([['delivered',2],['delivered',2]]);

    const supervisor=fork('scripts/local-workers.mjs',[],{stdio:['ignore','pipe','pipe','ipc'],env:{
      ...workerEnv(reminderUrl),PROJECTOS_LOCAL_REMINDER_DATABASE_URL:reminderUrl,
      PROJECTOS_TELEGRAM_NOTIFICATIONS:'disabled',PROJECTOS_EMAIL_NOTIFICATIONS:'disabled',
    }});
    const stopped=once(supervisor,'exit');
    let output='';
    supervisor.stdout?.on('data',chunk=> { output+=String(chunk); });
    supervisor.stderr?.resume();
    try { await expect.poll(() => output,{timeout:10_000}).toContain('"workerStatus":"ready"'); }
    finally {
      if (supervisor.connected) supervisor.send('stop');
      expect((await stopped)[0]).toBe(0);
    }
    const health=await (await page.request.get('/api/notifications')).json();
    expect(health.workers).toEqual(expect.arrayContaining([
      expect.objectContaining({name:'reminders',status:'recent'}),
    ]));
    const otherProject={...project,id:'notification-other-project',name:'پروژهٔ دیگر'};
    const state=await (await page.request.get('/api/state')).json();
    expect((await page.request.post('/api/records/projects/'+otherProject.id,{headers:origin,data:{
      version:state.version,record:otherProject,
    }})).status()).toBe(200);
    const viewerEmail='notification-viewer@example.test';
    const invited=await page.request.post('/api/team/invitations',{headers:origin,data:{
      email:viewerEmail,role:'viewer',projectIds:[otherProject.id],
    }});
    expect(invited.status()).toBe(200);
    const viewer=await browser.newContext({baseURL:origin.Origin,ignoreHTTPSErrors:origin.Origin.startsWith('https:')});
    try {
      expect((await viewer.request.post('/api/auth/accept-invite',{headers:origin,data:{
        email:viewerEmail,password,displayName:'بینندهٔ آزمایشی',token:(await invited.json()).token,
      }})).status()).toBe(200);
      expect((await viewer.request.get(path)).status()).toBe(404);
      expect((await viewer.request.get('/api/notifications')).status()).toBe(404);
    } finally { await viewer.close(); }
    const storageState=await page.context().storageState();
    await testApp.stop();
    const restarted=await startFreshPostgresApp(postgresFixture);
    const view=await browser.newContext({baseURL:restarted.url,ignoreHTTPSErrors:restarted.url.startsWith('https:'),storageState});
    try {
      const accepted=await view.request.get(path);
      expect(accepted.status()).toBe(200);
      const payload=await accepted.json();
      expect(payload.delivery.filter((job:{status:string}) => job.status==='accepted')).toHaveLength(2);
      expect(JSON.stringify(payload)).not.toMatch(/provider_id|lease_token|synthetic_mock|example\.test/);
      const fresh=await view.newPage();
      await fresh.goto('/alerts');
      await fresh.getByRole('button',{name:new RegExp(title)}).click();
      const dialog=fresh.getByRole('dialog');
      await expect(dialog.getByRole('list',{name:'وضعیت ارسال اعلان'}).getByText('پذیرفته‌شده توسط ارائه‌دهنده',{exact:false})).toHaveCount(2);
      await expect(fresh.locator('html')).toHaveAttribute('dir','rtl');
    } finally { await view.close(); await restarted.stop(); }
  } finally { await mock.close(); }
});

test('configured Vault metadata is verified through trusted TLS without exposing provider data', async ({page,browser,origin,postgresFixture,testApp}) => {
  test.setTimeout(60_000);
  if (!postgresFixture || !process.env.PROJECTOS_TEST_TLS_KEY || !process.env.PROJECTOS_TEST_TLS_CERT) {
    throw new Error('PostgreSQL and the generated loopback TLS fixture are required');
  }
  const key=await readFile(process.env.PROJECTOS_TEST_TLS_KEY);
  const cert=await readFile(process.env.PROJECTOS_TEST_TLS_CERT);
  expect((await page.request.post('/api/auth/setup',{headers:origin,data:{
    setupToken,email,password,displayName:'مالک آزمایشی',workspace,
  }})).status()).toBe(200);
  const project={id:'vault-fixture',name:'پروژهٔ خزانه',subtitle:'',coverTitle:'خزانه',description:'',
    status:'building',type:'وب‌سایت',progress:0,next:'',art:'navigation/projects'};
  expect((await page.request.post('/api/records/projects/'+project.id,{headers:origin,data:{version:0,record:project}})).status()).toBe(200);
  const workspaceId=(await postgresFixture.query<{id:string}>('SELECT id FROM workspaces')).rows[0].id;
  const reference={id:'fixture-vault-reference',projectId:project.id,name:'فرادادهٔ ساختگی',
    type:'SSH Key',vaultProvider:'HashiCorp Vault',vaultMount:'fixture-kv',vaultPath:'project/fixture'};
  const saved=await page.request.post('/api/records/secrets/'+reference.id,{headers:origin,data:{version:1,record:reference}});
  expect(saved.status()).toBe(200);
  const token='synthetic.vault.fixture.only';
  const ignored='SYNTHETIC_ONLY_PROVIDER_FIELD';
  const received:{path:string | undefined;method:string | undefined;authorized:boolean}[]=[];
  let code=200;
  const vault=createServer({key,cert},(request,response) => {
    received.push({path:request.url,method:request.method,authorized:request.headers['x-vault-token']===token});
    reply(response,code,{data:{current_version:5,versions:{5:{destroyed:false,deletion_time:''}},custom_metadata:{ignored}}});
  });
  vault.listen(0,'127.0.0.1');
  await once(vault,'listening');
  const address=vault.address();
  if (!address || typeof address === 'string') throw new Error('Missing Vault test endpoint');
  try {
    const storageState=await page.context().storageState();
    await testApp.stop();
    const configured=await startFreshPostgresApp(postgresFixture,
      {workspace:workspaceId,token,ca:process.env.PROJECTOS_TEST_TLS_CERT,origin:'https://127.0.0.1:'+address.port});
    const client=await browser.newContext({baseURL:configured.url,ignoreHTTPSErrors:true,storageState});
    try {
      const headers={Origin:configured.url,'Sec-Fetch-Site':'same-origin'};
      const path='/api/vault/'+reference.id;
      expect((await client.request.post(path,{headers,data:{password,value:ignored}})).status()).toBe(400);
      expect(received).toHaveLength(0);
      const checked=await client.request.post(path,{headers,data:{password}});
      expect(checked.status()).toBe(200);
      expect(await checked.json()).toEqual({status:'verified',providerVersion:5,checkedAt:expect.any(String)});
      expect(received).toEqual([{path:'/v1/fixture-kv/metadata/project/fixture',method:'GET',authorized:true}]);
      const meta=await postgresFixture.query('SELECT status,provider_version FROM vault_checks WHERE workspace_id=$1',[workspaceId]);
      expect(meta.rows).toEqual([{status:'verified',provider_version:5}]);
      const stored=await postgresFixture.query('SELECT payload FROM records WHERE workspace_id=$1',[workspaceId]);
      expect(JSON.stringify(stored.rows)).not.toContain(ignored);
      expect(await (await client.request.get(path)).text()).not.toContain(token);
      code=403;
      expect(await (await client.request.post(path,{headers,data:{password}})).json())
        .toEqual({status:'permission_denied',providerVersion:null,checkedAt:expect.any(String)});
      const editorEmail='vault-editor@example.test';
      const invited=await client.request.post('/api/team/invitations',{headers,data:{email:editorEmail,role:'editor',projectIds:[project.id]}});
      expect(invited.status()).toBe(200);
      const editor=await browser.newContext({baseURL:configured.url,ignoreHTTPSErrors:true});
      try {
        expect((await editor.request.post('/api/auth/accept-invite',{headers,data:{
          email:editorEmail,password,displayName:'ویرایشگر آزمایشی',token:(await invited.json()).token,
        }})).status()).toBe(200);
        expect((await editor.request.get(path)).status()).toBe(404);
        expect((await editor.request.post(path,{headers,data:{password}})).status()).toBe(404);
        expect(received).toHaveLength(2);
      } finally { await editor.close(); }
    } finally { await client.close(); await configured.stop(); }
  } finally {
    vault.closeAllConnections();
    await new Promise<void>(resolve=>vault.close(()=>resolve()));
  }
});

test('Gate D displays persisted contract balances, allocated cost and sampled availability', async ({page,origin,postgresFixture})=>{
  if (!postgresFixture) throw new Error('PostgreSQL is required');
  expect((await page.request.post('/api/auth/setup',{headers:origin,data:{
    setupToken,email,password,displayName:'مالک آزمایشی',workspace,
  }})).status()).toBe(200);
  const project={id:'gate-d-finance',name:'پروژهٔ مالی',subtitle:'',coverTitle:'مالی',description:'',
    status:'building',type:'وب‌سایت',progress:0,next:'',art:'navigation/projects'};
  const other={...project,id:'gate-d-other',name:'پروژهٔ دوم'};
  const resource={id:'gate-d-server',projectId:project.id,linkedProjectIds:[other.id],name:'سرور مشترک',
    type:'server',environment:'Development',status:'registered',provider:'Fixture',address:'203.0.113.19',tags:[]};
  const contract={id:'gate-d-contract',projectId:project.id,title:'قرارداد آزمایش تطبیق',client:'Fixture',
    start:'2031-01-01',end:'2031-12-31',amount:1234,currency:'USD',amountUnit:'minor',state:'active'};
  const invoice={id:'gate-d-invoice',projectId:project.id,contractId:contract.id,reference:'D-UI',title:'فاکتور آزمایشی',
    direction:'receivable',amount:1234,currency:'USD',amountUnit:'minor',issuedOn:'2031-01-01',dueOn:'2031-02-01',state:'open'};
  const create=(kind:string,record:{id:string})=>({kind,id:record.id,action:'create',record});
  expect((await page.request.patch('/api/records',{headers:origin,data:{version:0,changes:[
    create('projects',project),create('projects',other),create('resources',resource),create('contracts',contract),create('invoices',invoice),
  ]}})).status()).toBe(200);
  await page.goto('/finance');
  await expect(page.getByRole('table',{name:'تطبیق قرارداد و فاکتور'}).getByText('منطبق',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'تخصیص هزینهٔ مشترک',exact:true}).click();
  const form=page.getByRole('dialog',{name:'تخصیص هزینهٔ مشترک'});
  await form.getByLabel('منبع مشترک').selectOption(resource.id);
  await form.getByLabel('شرح هزینه').fill('سهم هزینهٔ Gate D');
  await form.getByLabel('مبلغ کل').fill('101');
  await form.getByRole('button',{name:'ثبت تخصیص'}).click();
  await expect(page.getByText('سهم هزینهٔ Gate D · سهم هزینهٔ مشترک',{exact:true})).toHaveCount(2);
  const at=new Date(Math.floor(Date.now()/900_000)*900_000-900_000).toISOString();
  await postgresFixture.query(`INSERT INTO monitor_observations(workspace_id,resource_id,checked_at,state,status_code,latency_ms,diagnostic,source)
    SELECT id,$1,$2,'healthy',200,12,'Synthetic HTTPS','https' FROM workspaces`,[resource.id,at]);
  const key=process.env.PROJECTOS_TEST_TLS_KEY, cert=process.env.PROJECTOS_TEST_TLS_CERT;
  if (!key || !cert) throw new Error('The VPN contract requires the generated loopback TLS fixture');
  let healthStatus=204;
  const vpn=createServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>{
    res.writeHead(req.method==='HEAD' && req.url==='/health'?healthStatus:405).end();
  });
  vpn.listen(0,'127.0.0.1');
  await once(vpn,'listening');
  const address=vpn.address();
  if (!address || typeof address==='string') throw new Error('Missing VPN service fixture');
  const check=async()=>{
    const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',
      "import {localTunnelService} from './scripts/vpn-evidence.mjs'; console.log(JSON.stringify(await localTunnelService(process.argv[1])));",
      `https://127.0.0.1:${address.port}/health`],{env:{...process.env,NODE_EXTRA_CA_CERTS:cert},timeout:8000});
    return JSON.parse(stdout) as {serviceState:string;latencyMs:number | null};
  };
  try {
    const probe=await check();
    expect(probe.serviceState).toBe('ok');
    expect(probe.latencyMs).toEqual(expect.any(Number));
    const checkedAt=new Date(Date.now()-1000);
    await postgresFixture.query(`INSERT INTO vpn_observations(workspace_id,resource_id,checked_at,handshake_at,wireguard_state,service_state,latency_ms)
      SELECT id,$1,$2,$3,'observed',$4,$5 FROM workspaces`,[resource.id,checkedAt,new Date(checkedAt.getTime()-1000),probe.serviceState,probe.latencyMs]);
    healthStatus=200;
    expect(await check()).toEqual({serviceState:'unexpected',latencyMs:null});
  } finally {
    vpn.closeAllConnections();
    await new Promise<void>(done=>vpn.close(()=>done()));
  }
  expect(await check()).toEqual({serviceState:'connection',latencyMs:null});
  await page.goto('/monitoring');
  await expect(page.getByText('پوشش ناکافی برای ارزیابی بودجه',{exact:false})).toBeVisible();
  await expect(page.getByText('دست‌دهی تازه و پاسخ سرویس محلی',{exact:true})).toBeVisible();
  await page.route('**/api/integrations/github?projectId='+project.id,route=>route.fulfill({json:{repositories:[{
    repository:'fixture/gate-d',state:'pending_refresh',checkedAt:null,job:{state:'backoff',stage:'commits',page:2,error:'rate_limited'},
  }]}}));
  await page.goto('/projects/'+project.id);
  await expect(page.getByText(/در انتظار تلاش مجدد.*صفحهٔ 2.*محدودیت نرخ/)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir','rtl');
});
