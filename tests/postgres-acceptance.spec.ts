import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { setupToken, test } from './isolated-app';
import { totp } from '../src/lib/server/mfa';

const email = 'local-owner@example.test';
const password = 'synthetic-local-acceptance-password';
const workspace = 'فضای آزمایشی پذیرش';

async function signIn(page: Page, address: string, secret: string) {
  await page.getByLabel('ایمیل', {exact:true}).fill(address);
  await page.getByLabel('رمز عبور', {exact:true}).fill(secret);
  await page.getByRole('button', {name:'ورود امن',exact:true}).click();
}

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
  await expect(page.getByRole('alert')).toBeVisible();
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
  await expect(page.getByRole('alert')).toBeVisible();
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
    {kind:'contracts', button:'ثبت قرارداد', title:'قرارداد محلی'},
    {kind:'charges', button:'ثبت اشتراک دوره‌ای', title:'اشتراک محلی'},
    {kind:'revenues', button:'ثبت درآمد', title:'درآمد محلی'},
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
    await expect(page.getByRole('cell',{name:form.title,exact:true})).toBeVisible();
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
