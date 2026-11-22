import { expect, type APIRequestContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { totp } from '../src/lib/server/mfa';
import { test, setupToken, testRequest, type Origin } from './isolated-app';

const email='release-owner@example.test', password='synthetic-release-test-password';
const credentials={email,password};
function project(id:string) {
  return {id,name:id,subtitle:'',coverTitle:id,description:'',status:'building',type:'Website',
    progress:0,next:'',art:'navigation/projects'};
}
function task(id:string, projectId:string) {
  return {id,projectId,title:id,status:'todo',priority:'medium',owner:'Test',due:'2026-11-20',description:'',
    checklist:[],comments:[],dependencies:[]};
}
function doc(id:string,projectId:string,title:string) {
  return {id,projectId,title,type:'Runbook',body:'داشبورد و راهنمای مصنوعی',revision:1,updated:'2026-11-18'};
}
function create<T extends {id:string}>(kind:string,record:T) { return {kind,id:record.id,action:'create',record}; }

async function bootstrap(context:APIRequestContext,origin:Origin) {
  const response=await context.post('/api/auth/setup',{headers:origin,data:{
    setupToken,email,password,displayName:'QA owner',workspace:'Release QA',
  }});
  expect(response.status()).toBe(200);
}
async function seed(request:APIRequestContext,origin:Origin) {
  const changes=[create('projects',project('visible')),create('projects',project('private')),
    create('tasks',task('t-one','visible')),create('tasks',task('t-two','visible')),
    create('docs',doc('open-doc','visible','داشبورد عمومی پروژه')),create('docs',doc('closed-doc','private','داشبورد پروژهٔ محدود'))];
  expect((await request.patch('/api/records',{headers:origin,data:{version:0,changes}})).status()).toBe(200);
}

test('record concurrency preserves independent edits and rejects a partial transaction',async({request,origin})=>{
  await bootstrap(request,origin);
  await seed(request,origin);
  const version=(await (await request.get('/api/state')).json()).version;
  const edit=(id:string,description:string)=>({kind:'tasks',id,action:'replace',record:{...task(id,'visible'),description}});
  const commit=(changes:unknown[])=>request.patch('/api/records',{headers:origin,data:{version,changes}});
  const writes=await Promise.all([commit([edit('t-one','first')]),commit([edit('t-two','second')])]);
  expect(writes.map(response=>response.status())).toEqual([200,200]);
  expect((await commit([edit('t-one','stale')])).status()).toBe(409);
  const updated=(await (await request.get('/api/state')).json());
  expect(updated.data.tasks.map((row:{description:string})=>row.description).sort()).toEqual(['first','second']);
  const rejected=await request.patch('/api/records',{headers:origin,data:{version:updated.version,changes:[
    create('projects',project('rollback')),create('tasks',task('broken','unknown-project')),
  ]}});
  expect(rejected.status()).toBe(422);
  expect((await request.get('/api/records/projects/rollback')).status()).toBe(404);
  expect((await (await request.get('/api/state')).json()).version).toBe(updated.version);
});

test('project grants govern snapshots, direct record reads, document history and memory retrieval',async({request,origin,appURL})=>{
  await bootstrap(request,origin);
  await seed(request,origin);
  const memberEmail='limited-editor@example.test';
  const invite=await request.post('/api/team/invitations',{headers:origin,data:{email:memberEmail,role:'editor',projectIds:['visible']}});
  expect(invite.status()).toBe(200);
  const member=await testRequest(appURL);
  try {
    const accepted=await member.post('/api/auth/accept-invite',{headers:origin,data:{
      token:(await invite.json()).token,email:memberEmail,password,displayName:'Limited editor',
    }});
    expect(accepted.status()).toBe(200);
    const {data,version}=await (await member.get('/api/state')).json();
    expect(data.projects.map((record:{id:string})=>record.id)).toEqual(['visible']);
    expect(data.docs.map((record:{id:string})=>record.id)).toEqual(['open-doc']);
    expect(data.events.every((event:{projectId:string})=>event.projectId==='visible')).toBe(true);
    expect((await member.get('/api/records/docs/closed-doc')).status()).toBe(404);
    expect((await member.get('/api/docs/history?id=closed-doc')).status()).toBe(404);
    expect((await member.get('/api/docs/history?id=open-doc')).status()).toBe(200);
    const search=await member.post('/api/assistant',{headers:origin,data:{question:'داشبورد',allowExternal:true}});
    expect(search.status()).toBe(200);
    const memory=await search.json();
    expect(memory.externalTransmission).toBe(false);
    expect(memory.citations.map((item:{id:string})=>item.id)).toEqual(['doc:open-doc']);
    expect((await member.post('/api/assistant',{headers:origin,data:{question:'داشبورد',projectId:'private'}})).status()).toBe(404);
    expect((await member.patch('/api/records',{headers:origin,data:{version,changes:[create('tasks',task('blocked','private'))]}})).status()).toBe(403);
    expect((await member.patch('/api/records',{headers:origin,data:{version,changes:[create('tasks',task('allowed','visible'))]}})).status()).toBe(200);
    const ownerState=await (await request.get('/api/state')).json();
    const memberId=ownerState.data.users.find((item:{email:string})=>item.email===memberEmail).id;
    expect((await request.patch('/api/team/members/'+memberId,{headers:origin,data:{projectIds:[]}})).status()).toBe(200);
    expect((await member.get('/api/docs/history?id=open-doc')).status()).toBe(404);
  } finally { await member.dispose(); }
});

test('resuming work uses project evidence and refuses unauthorized event citations',async({page,origin,appURL})=>{
  await bootstrap(page.request,origin);
  const currentProject={...project('mokmok'),name:'MOKMOK',next:'بازبینی گزارش پرداخت آزمایشی'};
  const eventTitle='مرور دادهٔ آزمایشی پرداخت';
  const created=await page.request.patch('/api/records',{headers:origin,data:{version:0,changes:[
    create('projects',currentProject),create('projects',project('quiet')),create('projects',project('tasks-project')),
    create('tasks',{...task('open-task','tasks-project'),title:'بررسی رابط ورود',status:'doing'}),
    create('tasks',{...task('done-task','tasks-project'),title:'بستن درخواست قبلی',status:'done'}),
  ]}});
  expect(created.status()).toBe(200);
  const appended=await page.request.post('/api/activity',{headers:origin,data:{
    projectId:'mokmok',title:eventTitle,detail:'نمونه‌های مصنوعی در محیط محلی تأیید شدند.',
  }});
  expect(appended.status()).toBe(200);
  const resume=(projectId:string)=>page.request.post('/api/assistant',{headers:origin,data:{intent:'resume',projectId,allowExternal:true}});
  const available=await resume('mokmok');
  expect(available.status()).toBe(200);
  const summary=await available.json();
  expect(summary.externalTransmission).toBe(false);
  expect(summary.answer).toContain(currentProject.next);
  expect(summary.citations.map((citation:{kind:string})=>citation.kind)).toEqual(['activity','project']);
  expect(summary.citations[0]).toEqual(expect.objectContaining({title:eventTitle,updatedAt:expect.any(String)}));
  const quiet=await (await resume('quiet')).json();
  expect(quiet.answer).toContain('اطلاعات کافی');
  const open=await (await resume('tasks-project')).json();
  expect(open.answer).toContain('بررسی رابط ورود');
  expect(open.answer).not.toContain('کار قابل پیگیری «بستن درخواست قبلی»');
  expect(open.citations.some((citation:{id:string})=>citation.id==='task:open-task')).toBe(true);

  await page.goto('/assistant');
  await page.getByLabel('پروژهٔ جست‌وجو').selectOption('mokmok');
  await page.getByRole('button',{name:'ادامهٔ کار این پروژه'}).click();
  const citation=page.getByRole('link',{name:new RegExp(eventTitle)});
  await expect(citation.locator('time')).toHaveAttribute('datetime',summary.citations[0].updatedAt);
  await citation.click();
  await expect(page).toHaveURL(/\/activity\?event=/);
  await expect(page.getByRole('heading',{name:'رویداد ارجاع‌شده'})).toBeVisible();
  await expect(page.getByText('نمونه‌های مصنوعی در محیط محلی تأیید شدند.',{exact:true})).toHaveCount(2);
  const eventApi='/api'+summary.citations[0].href;
  const readable=await page.request.get(eventApi);
  expect(readable.status()).toBe(200);
  expect((await readable.json()).activity.title).toBe(eventTitle);

  const memberEmail='resume-restricted@example.test';
  const invitation=await page.request.post('/api/team/invitations',{headers:origin,data:{
    email:memberEmail,role:'viewer',projectIds:['quiet'],
  }});
  expect(invitation.status()).toBe(200);
  const member=await testRequest(appURL);
  try {
    const accepted=await member.post('/api/auth/accept-invite',{headers:origin,data:{
      token:(await invitation.json()).token,email:memberEmail,password,displayName:'Restricted viewer',
    }});
    expect(accepted.status()).toBe(200);
    expect((await member.post('/api/assistant',{headers:origin,data:{intent:'resume',projectId:'mokmok'}})).status()).toBe(404);
    expect((await member.get(eventApi)).status()).toBe(404);
    const hiddenPage=await (await member.get(summary.citations[0].href)).text();
    expect(hiddenPage).toContain('صفحه پیدا نشد');
    expect(hiddenPage).not.toContain(eventTitle);
    expect(hiddenPage).not.toContain('نمونه‌های مصنوعی در محیط محلی تأیید شدند.');
    expect((await member.post('/api/assistant',{headers:origin,data:{intent:'resume',projectId:'quiet'}})).status()).toBe(200);
  } finally { await member.dispose(); }
});

test.describe('required second factor',()=>{
  test.use({enforceMfa:true});
  test('enrollment binds to a session and one-time recovery revokes all older sessions',async({request,origin,appURL})=>{
    await bootstrap(request,origin);
    expect((await request.get('/api/state')).status()).toBe(401);
    expect((await (await request.get('/api/auth/me')).json()).enrollmentRequired).toBe(true);
    const start=await request.post('/api/auth/mfa',{headers:origin,data:{action:'start',password}});
    expect(start.status()).toBe(200);
    const {secret}=await start.json();
    const factor=totp(secret);
    const other=await testRequest(appURL);
    try {
      expect((await other.post('/api/auth/login',{headers:origin,data:credentials})).status()).toBe(200);
      expect((await other.post('/api/auth/mfa',{headers:origin,data:{action:'confirm',code:factor}})).status()).toBe(422);
      const confirm=await request.post('/api/auth/mfa',{headers:origin,data:{action:'confirm',code:factor}});
      expect(confirm.status()).toBe(200);
      const {recoveryCodes}=await confirm.json();
      expect(recoveryCodes).toHaveLength(10);
      expect((await request.get('/api/state')).status()).toBe(200);
      expect((await other.get('/api/state')).status()).toBe(401);
      const recovery={...credentials,recoveryCode:recoveryCodes[0]};
      expect((await other.post('/api/auth/login',{headers:origin,data:recovery})).status()).toBe(200);
      expect((await request.get('/api/state')).status()).toBe(401);
      expect((await request.post('/api/auth/login',{headers:origin,data:recovery})).status()).toBe(401);
      expect((await other.post('/api/auth/logout',{headers:origin})).status()).toBe(200);
      expect((await other.get('/api/state')).status()).toBe(401);
    } finally { await other.dispose(); }
  });
});

test('login and authenticated dashboard pass automated WCAG A/AA checks',async({page,origin})=>{
  const login=await page.goto('/login');
  expect(await login?.headerValue('content-security-policy')).toMatch(/script-src[^;]*'nonce-/);
  await expect(page.locator('html')).toHaveAttribute('lang','fa');
  async function violations() {
    const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
    return result.violations.map(({id,nodes})=>({id,targets:nodes.map(node=>node.target)}));
  }
  expect(await violations()).toEqual([]);
  await bootstrap(page.request,origin);
  await page.goto('/dashboard');
  await expect(page.locator('html')).toHaveAttribute('dir','rtl');
  expect(await violations()).toEqual([]);
});

test('authenticated read performance on a controlled synthetic workspace',async({request,origin},testInfo)=>{
  await bootstrap(request,origin);
  expect((await request.patch('/api/records',{headers:origin,data:{
    version:0,changes:[create('projects',project('perf')), ...Array.from({length:60},(_,i)=>create('tasks',task('perf-'+i,'perf')))],
  }})).status()).toBe(200);
  expect((await request.get('/api/state')).ok()).toBe(true);
  const durations:number[]=[];
  for(let batch=0;batch<10;batch++){
    await Promise.all(Array.from({length:5},async()=>{
      const before=performance.now();
      const result=await request.get('/api/state');
      expect(result.status()).toBe(200);
      expect((await result.json()).data.tasks).toHaveLength(60);
      durations.push(performance.now()-before);
    }));
  }
  durations.sort((a,b)=>a-b);
  const p95=durations[Math.ceil(durations.length*0.95)-1];
  await testInfo.attach('api-p95',{contentType:'application/json',body:JSON.stringify({requests:50,concurrency:5,records:61,p95Ms:p95})});
  console.log(JSON.stringify({requests:50,concurrency:5,records:61,p95Ms:Math.round(p95)}));
  expect(p95).toBeLessThan(2000);
});

test('project form waits for the server commit before navigation and persists after reload',async({page,origin})=>{
  await bootstrap(page.request,origin);
  await page.goto('/projects');
  await page.getByRole('button',{name:'پروژه جدید',exact:true}).click();
  const name='پروژهٔ آزمایشی از فرم';
  await page.getByLabel('نام پروژه').fill(name);
  let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/records',async route=>{await pending;await route.continue();});
  const submit=page.getByRole('button',{name:'ایجاد پروژه',exact:true});
  try {
    await submit.click();
    await expect(submit).toBeDisabled();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByText('پروژه ایجاد شد.',{exact:true})).toHaveCount(0);
  } finally { release(); }
  await expect(page).toHaveURL(/\/projects\/project-/);
  await expect(page.getByRole('heading',{name,exact:true,level:1})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading',{name,exact:true,level:1})).toBeVisible();
});

test('finance records installments and payments, preserves voided invoices, and scopes exported data', async ({page,origin,appURL}) => {
  await bootstrap(page.request,origin);
  const seeded=await page.request.patch('/api/records',{headers:origin,data:{version:0,changes:[
    create('projects',project('finance-project')),create('projects',project('other-project')),
  ]}});
  expect(seeded.status()).toBe(200);
  await page.goto('/finance');
  async function issue(title:string,reference:string,withInstallments:boolean) {
    await page.getByRole('button',{name:'فاکتور جدید',exact:true}).click();
    const form=page.getByRole('dialog',{name:'فاکتور جدید'});
    await form.getByLabel('عنوان فاکتور').fill(title);
    await form.getByLabel('شمارهٔ فاکتور').fill(reference);
    await form.getByLabel('پروژه',{exact:true}).selectOption('finance-project');
    await form.getByLabel('ارز فاکتور').selectOption('USD');
    await form.getByLabel('مبلغ فاکتور').fill('۱۰۰٫۰۰');
    await form.getByLabel('تاریخ صدور (میلادی)').fill('2031-03-01');
    await form.getByLabel('موعد فاکتور (میلادی)').fill('2031-04-01');
    if (withInstallments) {
      const installments=[['2031-03-15','۵۰٫۲۵'],['2031-04-01','۴۹٫۷۵']];
      for (const [index,[date,amount]] of installments.entries()) {
        await form.getByRole('button',{name:'افزودن قسط'}).click();
        await form.getByLabel('موعد قسط '+(index+1)+' (میلادی)').fill(date);
        await form.getByLabel('مبلغ قسط '+(index+1)).fill(amount);
      }
    }
    await form.getByRole('button',{name:'ثبت فاکتور',exact:true}).click();
    const entry=page.getByRole('button',{name:title,exact:true});
    await expect(entry).toBeVisible();
    await entry.click();
    return page.getByRole('dialog',{name:title,exact:true});
  }
  const detail=await issue('فاکتور آزمایشی اقساط','FIX-100',true);
  async function pay(reference:string,amount:string) {
    await detail.getByRole('button',{name:'ثبت پرداخت',exact:true}).click();
    const form=page.getByRole('dialog',{name:'ثبت پرداخت فاکتور'});
    await form.getByLabel('شناسهٔ پرداخت').fill(reference);
    await form.getByLabel('مبلغ پرداخت').fill(amount);
    await form.getByLabel('تاریخ پرداخت (میلادی)').fill('2031-03-20');
    await form.getByRole('button',{name:'ثبت پرداخت',exact:true}).click();
    return form;
  }
  await pay('FIX-P۱','۶۰٫۰۰');
  await expect(detail.getByRole('listitem').nth(0)).toContainText('۰٫۰۰ دلار');
  await expect(detail.getByRole('listitem').nth(1)).toContainText('۴۰٫۰۰ دلار');
  await expect(detail.getByRole('button',{name:'ابطال فاکتور'})).toHaveCount(0);
  const duplicate=await pay('fix-p1','۱٫۰۰');
  await expect(duplicate.getByRole('alert')).toContainText('شناسهٔ تکراری');
  const {data,version}=await (await page.request.get('/api/state')).json();
  expect(data.payments).toEqual([expect.objectContaining({reference:'FIX-P۱',amount:6000})]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const unpaid=await issue('فاکتور قابل ابطال','FIX-VOID',false);
  await unpaid.getByRole('button',{name:'ابطال فاکتور'}).click();
  await page.getByRole('dialog',{name:'ابطال فاکتور'}).getByRole('button',{name:'تأیید ابطال'}).click();
  await expect(unpaid).toContainText('باطل');
  await expect(unpaid.getByRole('button',{name:'ثبت پرداخت'})).toHaveCount(0);
  await page.keyboard.press('Escape');
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'خروجی فاکتورها'}).click();
  const exported=await pending;
  expect(exported.suggestedFilename()).toBe('projectos-invoices.csv');
  expect(await readFile(await exported.path(),'utf8')).toContain('"USD","100.00","4000"');

  const memberEmail='finance-restricted@example.test';
  const invitation=await page.request.post('/api/team/invitations',{headers:origin,data:{
    email:memberEmail,role:'editor',projectIds:['other-project'],
  }});
  expect(invitation.status()).toBe(200);
  const member=await testRequest(appURL);
  try {
    const accepted=await member.post('/api/auth/accept-invite',{headers:origin,data:{
      token:(await invitation.json()).token,email:memberEmail,password,displayName:'Restricted editor',
    }});
    expect(accepted.status()).toBe(200);
    const {data:visible}=await (await member.get('/api/state')).json();
    expect(visible.invoices).toEqual([]);
    expect(visible.payments).toEqual([]);
    expect((await member.get('/api/records/invoices/'+data.invoices[0].id)).status()).toBe(404);
    expect((await member.patch('/api/records',{headers:origin,data:{version,changes:[
      create('invoices',{...data.invoices[0],id:'editor-invoice',reference:'EDITOR',projectId:'other-project'}),
    ]}})).status()).toBe(403);
  } finally { await member.dispose(); }
});

test('a dated exchange rate stays attributed and converts precise values without changing the ledger',async({page,origin})=>{
  await bootstrap(page.request,origin);
  expect((await page.request.patch('/api/records',{headers:origin,data:{version:0,changes:[
    create('projects',project('fx-project')),
  ]}})).status()).toBe(200);
  await page.goto('/finance');
  await page.getByRole('button',{name:'ثبت نرخ تبدیل',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'ثبت نرخ تبدیل'});
  await dialog.getByLabel('پروژه',{exact:true}).selectOption('fx-project');
  await dialog.getByLabel('نرخ برای یک واحد ارز مبدأ').fill('۱۲۳٫۵');
  await dialog.getByLabel('زمان مشاهده (میلادی، UTC)').fill('2026-01-15T14:30');
  await dialog.getByLabel('نام منبع و شناسهٔ مرجع').fill('گزارش آزمایشی نرخ ۷');
  await dialog.getByRole('button',{name:'ذخیرهٔ نرخ'}).click();
  await expect(dialog).toHaveCount(0);
  await page.getByLabel('مبلغ برای تبدیل (USD)').fill('۱٫۰۱');
  await expect(page.getByText('برآورد با نرخ انتخاب‌شده · ۱۲۵ تومان')).toBeVisible();
  await expect(page.locator('time[datetime="2026-01-15T14:30:00.000Z"]')).toBeVisible();
  await page.reload();
  // Open the panel in the viewport before checking the source after navigation.
  await page.getByRole('heading',{name:'تبدیل ارز با نرخ ثبت‌شده'}).scrollIntoViewIfNeeded();
  const source=page.getByText('گزارش آزمایشی نرخ ۷',{exact:true});
  await expect(source).toBeVisible();
  await expect(source).toBeInViewport();
  const snapshot=(await (await page.request.get('/api/state')).json()).data;
  expect(snapshot.exchangeRates).toEqual([expect.objectContaining({rate:'123.5',from:'USD',to:'TOMAN'})]);
  expect(snapshot.expenses).toEqual([]);
  expect(snapshot.payments).toEqual([]);
});

test('only an empty archived project can be deleted from its page', async ({page, origin}) => {
  await bootstrap(page.request, origin);
  const shared = {id:'shared-vps', name:'Shared VPS', projectId:'hosting', linkedProjectIds:['protected'],
    type:'server', address:'203.0.113.24', environment:'Staging', status:'registered', provider:'Fixture host', tags:[]};
  const setup = await page.request.patch('/api/records', {headers:origin, data:{version:0, changes:[
    create('projects', project('hosting')), create('projects', project('protected')), create('projects', project('empty')),
    create('resources', shared),
  ]}});
  expect(setup.status()).toBe(200);

  for (const id of ['protected', 'empty']) {
    await page.goto('/projects/' + id);
    const remove = page.getByRole('button', {name:'حذف پروژه', exact:true});
    await expect(remove).toHaveCount(0);
    await page.getByRole('button', {name:'بایگانی پروژه', exact:true}).click();
    await page.getByRole('button', {name:'تأیید بایگانی', exact:true}).click();
    await expect(remove).toBeVisible();
    await remove.click();
    const dialog = page.getByRole('dialog', {name:'حذف پروژه'});
    await dialog.getByRole('button', {name:'تأیید حذف پروژه', exact:true}).click();
    if (id === 'protected') {
      await expect(dialog.getByRole('alert')).toContainText('حذف تأیید نشد');
      expect((await page.request.get('/api/records/projects/protected')).status()).toBe(200);
      expect((await page.request.get('/api/records/resources/shared-vps')).status()).toBe(200);
      await dialog.getByRole('button', {name:'انصراف', exact:true}).click();
    } else {
      await expect(page).toHaveURL(/\/projects$/);
      expect((await page.request.get('/api/records/projects/empty')).status()).toBe(404);
    }
  }
});

test('a resource renewal charge retains its currency and links after a rejected write and retry', async ({page, origin}) => {
  await bootstrap(page.request, origin);
  const domain = {id:'domain', name:'Domain renewal fixture', projectId:'hosting', linkedProjectIds:['billing'],
    type:'domain', address:'domain.example.test', environment:'Staging', status:'registered', provider:'Fixture host',
    expires:'2027-04-01', tags:[]};
  const setup = await page.request.patch('/api/records', {headers:origin, data:{version:0, changes:[
    create('projects', project('hosting')), create('projects', project('billing')),
    create('resources', domain), create('resources', {...domain, id:'late', name:'Later renewal', linkedProjectIds:[], expires:'2027-05-01'}),
  ]}});
  expect(setup.status()).toBe(200);
  expect((await page.request.get('/api/records/resources/domain')).status()).toBe(200);

  await page.goto('/finance');
  await page.getByRole('button', {name:'ثبت اشتراک دوره‌ای', exact:true}).click();
  const form = page.getByRole('dialog', {name:'ثبت اشتراک دوره‌ای'});
  await form.getByLabel('پروژه', {exact:true}).selectOption('billing');
  await expect(form.getByLabel('منبع مرتبط').getByRole('option', {name:'Later renewal', exact:true})).toHaveCount(0);
  await form.getByLabel('منبع مرتبط').selectOption('domain');
  await form.getByLabel('عنوان', {exact:true}).fill('آزمون هزینه دامنه');
  await form.getByLabel('ارائه‌دهنده').fill('Fixture host');
  await form.getByLabel('واحد ارز').selectOption('USD');
  const amount = form.getByLabel('مبلغ (دلار تا دو رقم اعشار)', {exact:true});
  await amount.fill('12.50');
  await form.getByLabel('موعد بعدی (میلادی)').fill('2027-04-01');
  await page.route('**/api/records', route => route.fulfill({status:422, json:{error:'Synthetic validation rejection'}}), {times:1});
  const submit = form.getByRole('button', {name:'ثبت اشتراک دوره‌ای', exact:true});
  await submit.click();
  await expect(form.getByRole('alert')).toContainText('ثبت اطلاعات مالی تأیید نشد');
  await expect(amount).toHaveValue('12.50');
  await submit.click();
  await expect(form).toHaveCount(0);

  const result = await page.request.get('/api/state');
  expect(result.status()).toBe(200);
  const snapshot = await result.json();
  expect(snapshot.data.charges).toEqual([expect.objectContaining({
    amount:1250, amountUnit:'minor', currency:'USD', projectId:'billing', linkedResourceId:'domain', nextDue:'2027-04-01',
  })]);
  const unrelated = await page.request.patch('/api/records', {headers:origin, data:{version:snapshot.version, changes:[
    create('charges', {...snapshot.data.charges[0], id:'unrelated-resource', linkedResourceId:'late'}),
  ]}});
  expect(unrelated.status()).toBe(422);
  const legacyPayload = {...snapshot.data, charges:[...snapshot.data.charges,
    {...snapshot.data.charges[0], id:'unrelated-resource', linkedResourceId:'late'}]};
  expect((await page.request.put('/api/state', {headers:origin, data:{version:snapshot.version, data:legacyPayload}})).status()).toBe(422);
  expect((await page.request.get('/api/records/charges/unrelated-resource')).status()).toBe(404);
  await page.goto('/infrastructure');
  await page.getByLabel('مرتب‌سازی منابع').selectOption('renewal');
  const first = page.getByRole('table', {name:'منابع زیرساخت'}).locator('tbody tr').first();
  await expect(first.getByText('Domain renewal fixture', {exact:true})).toBeVisible();
  await first.getByText('Domain renewal fixture', {exact:true}).click();
  const metadata = page.getByRole('dialog', {name:'Domain renewal fixture'});
  await expect(metadata.getByText(/آزمون هزینه دامنه.*۱۲٫۵۰ دلار/)).toBeVisible();
});

test('a viewer keeps access to the charge after resource sharing is revoked without seeing the resource reference', async ({request, origin, appURL}) => {
  await bootstrap(request, origin);
  const domain = {id:'domain', name:'Domain fixture', projectId:'hosting', linkedProjectIds:['billing'],
    type:'domain', address:'domain.example.test', environment:'Staging', status:'registered', provider:'Fixture host', tags:[]};
  const charge = {id:'charge', projectId:'billing', title:'Fixture charge', provider:'Fixture host',
    amount:1250, amountUnit:'minor', currency:'USD', nextDue:'2027-04-01', period:'yearly', status:'active', linkedResourceId:'domain'};
  const seed = await request.patch('/api/records', {headers:origin, data:{version:0, changes:[
    create('projects', project('hosting')), create('projects', project('billing')),
    create('resources', domain), create('charges', charge),
  ]}});
  expect(seed.status()).toBe(200);
  const memberEmail = 'billing-viewer@example.test';
  const invitation = await request.post('/api/team/invitations', {headers:origin,
    data:{email:memberEmail, role:'viewer', projectIds:['billing']}});
  expect(invitation.status()).toBe(200);
  const viewer = await testRequest(appURL);
  try {
    const accepted = await viewer.post('/api/auth/accept-invite', {headers:origin,
      data:{token:(await invitation.json()).token, email:memberEmail, password, displayName:'Billing viewer'}});
    expect(accepted.status()).toBe(200);
    const readCharge = () => viewer.get('/api/records/charges/charge');
    const first = await readCharge();
    expect(first.status()).toBe(200);
    expect((await first.json()).record.linkedResourceId).toBe('domain');
    const changed = await request.patch('/api/records', {headers:origin, data:{version:(await seed.json()).version,
      changes:[{kind:'resources', id:'domain', action:'replace', record:{...domain, linkedProjectIds:[]}}]}});
    expect(changed.status()).toBe(200);
    const remaining = await readCharge();
    expect(remaining.status()).toBe(200);
    expect((await remaining.json()).record).toEqual(expect.objectContaining({amount:1250, currency:'USD'}));
    expect((await remaining.json()).record).not.toHaveProperty('linkedResourceId');
    expect((await viewer.get('/api/records/resources/domain')).status()).toBe(404);
    const owner = await request.get('/api/records/charges/charge');
    expect((await owner.json()).record.linkedResourceId).toBe('domain');
  } finally { await viewer.dispose(); }
});

test('secure login and the three-step onboarding save a real workspace and its optional starter task', async ({page, origin, appURL}) => {
  const setup = await testRequest(appURL);
  try { await bootstrap(setup, origin); }
  finally { await setup.dispose(); }
  await page.goto('/login');
  await page.getByLabel('ایمیل', {exact:true}).fill(email);
  const passwordField = page.getByLabel('رمز عبور', {exact:true});
  await passwordField.fill('synthetic-invalid-onboarding-credential');
  const login = page.getByRole('button', {name:'ورود امن', exact:true});
  await login.click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('ایمیل یا رمز معتبر نیست');
  await expect(page).toHaveURL('/login');
  await passwordField.fill(password);
  await login.click();
  await expect(page).toHaveURL('/dashboard');
  expect(await page.evaluate(() => JSON.stringify({...localStorage,...sessionStorage}))).not.toContain(password);
  await page.getByRole('button', {name:'حساب کاربری'}).click();
  await page.getByRole('link', {name:'راه‌اندازی فضای کاری'}).click();
  const workspace = 'فضای شروع آزمایشی';
  const firstProject = 'پروژهٔ آغاز آزمایشی';
  await page.getByLabel('نام فضای کاری').fill(workspace);
  await page.getByRole('button', {name:'ادامه و افزودن پروژه'}).click();
  await page.getByLabel('نام پروژه').fill(firstProject);
  const starter = page.getByRole('checkbox', {name:'افزودن یک وظیفهٔ نمونه'});
  await expect(starter).not.toBeChecked();
  await starter.check();
  await page.getByRole('button', {name:'مرور اطلاعات'}).click();
  await expect(page.getByRole('heading', {name:'بازبینی و ساخت فضای کاری'})).toBeVisible();
  await page.getByRole('button', {name:'ایجاد پروژه', exact:true}).click();
  await expect(page.getByRole('heading', {level:1, name:firstProject})).toBeVisible();
  await expect(page.getByRole('link', {name:/مرور برنامه تحویل/})).toBeVisible();
  const snapshot = await page.request.get('/api/state');
  expect(snapshot.status()).toBe(200);
  const {data} = await snapshot.json();
  expect(data.preferences.workspace).toBe(workspace);
  expect(data.tasks).toEqual([expect.objectContaining({title:'مرور برنامه تحویل', owner:data.users[0].id})]);
});

test('owners can attach Vault metadata to a VPS and other roles cannot retrieve it', async ({page, origin, appURL}) => {
  await bootstrap(page.request, origin);
  const vps = {id:'nas-vps', name:'Synthetic VPS', projectId:'primary', linkedProjectIds:[], type:'server',
    address:'203.0.113.5', environment:'Development', status:'registered', provider:'Fixture host', tags:[]};
  const seed = await page.request.patch('/api/records', {headers:origin, data:{version:0, changes:[
    create('projects', project('primary')), create('projects', project('unrelated')), create('resources', vps),
  ]}});
  expect(seed.status()).toBe(200);
  await page.goto('/infrastructure/servers/nas-vps');
  await page.getByRole('link', {name:'ارجاع‌های خزانهٔ این سرور'}).click();
  await expect(page).toHaveURL('/vault?resource=nas-vps');
  await page.getByRole('button', {name:'افزودن ارجاع', exact:true}).click();
  const dialog = page.getByRole('dialog', {name:'افزودن ارجاع'});
  await expect(dialog.getByLabel('منبع مرتبط')).toHaveValue('nas-vps');
  await dialog.getByLabel('عنوان ارجاع').fill('کلید آزمون VPS');
  await dialog.getByLabel('محل خزانه').fill('HashiCorp Vault');
  await dialog.getByLabel('Mount فراداده برای HashiCorp Vault').fill('synthetic-kv');
  const save = dialog.getByRole('button', {name:'ثبت ارجاع', exact:true});
  await save.click();
  await expect(dialog.getByRole('alert')).toContainText('مسیر فراداده');
  await dialog.getByLabel('مسیر فراداده برای HashiCorp Vault').fill('test/ssh');
  await save.click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', {name:'کلید آزمون VPS', exact:true}).click();
  const details = page.getByRole('dialog', {name:'جزئیات ارجاع'});
  await expect(details.getByText('test/ssh', {exact:true})).toBeVisible();
  await expect(details.getByRole('status')).toHaveText('اتصال تنظیم نشده');

  const data = await (await page.request.get('/api/state')).json();
  const [reference] = data.data.secrets;
  expect(reference).toEqual(expect.objectContaining({resourceId:'nas-vps', vaultMount:'synthetic-kv', vaultPath:'test/ssh'}));
  const check = '/api/vault/' + reference.id;
  expect((await page.request.post(check, {headers:origin, data:{password:'invalid-fixture-password'}})).status()).toBe(403);
  const confirmed = await page.request.post(check, {headers:origin, data:{password}});
  expect(confirmed.status()).toBe(200);
  expect(await confirmed.json()).toEqual({status:'not_configured', checkedAt:null, providerVersion:null});
  const saveChanges = (changes:unknown[]) => page.request.patch('/api/records', {headers:origin, data:{version:data.version, changes}});
  expect((await saveChanges([create('secrets', {...reference, id:'unrelated-ref', projectId:'unrelated'})])).status()).toBe(422);
  expect((await saveChanges([create('secrets', {...reference, id:'raw-ref', rawValue:'synthetic-fixture-only'})])).status()).toBe(422);
  expect((await saveChanges([{kind:'resources', id:vps.id, action:'delete'}])).status()).toBe(422);

  const memberEmail = 'vault-viewer@example.test';
  const member = await testRequest(appURL);
  try {
    const invitation = await page.request.post('/api/team/invitations', {headers:origin,
      data:{email:memberEmail, role:'viewer', projectIds:['primary']}});
    expect(invitation.status()).toBe(200);
    const accepted = await member.post('/api/auth/accept-invite', {headers:origin,
      data:{token:(await invitation.json()).token, email:memberEmail, password, displayName:'Scoped viewer'}});
    expect(accepted.status()).toBe(200);
    expect((await member.get('/api/records/resources/nas-vps')).status()).toBe(200);
    expect((await member.get(check)).status()).toBe(404);
    expect((await member.get('/api/records/secrets/' + reference.id)).status()).toBe(404);
    expect((await (await member.get('/api/state')).json()).data.secrets).toEqual([]);
  } finally { await member.dispose(); }
});

test('workspace overlay triggers become available when browser scripts are ready', async ({page, origin}) => {
  await bootstrap(page.request, origin);
  let releaseScripts!: () => void;
  const ready = new Promise<void>(resolve => { releaseScripts = resolve; });
  await page.route(/\/_next\/static\/.*\.js(?:\?.*)?$/, async route => {
    await ready;
    await route.continue();
  });
  const account = page.getByRole('button', {name:'حساب کاربری', exact:true});
  try {
    await page.goto('/dashboard', {waitUntil:'commit'});
    await expect(account).toBeDisabled();
  } finally { releaseScripts(); }
  await expect(account).toBeEnabled();
  await account.click();
  await expect(page.getByRole('dialog', {name:'حساب کاربری'})).toBeVisible();
});

test('alerts preserve independent snoozed, dismissed and resolved states after saving', async ({page, origin}) => {
  await bootstrap(page.request, origin);
  const incident={id:'lifecycle-alert',projectId:'alert-project',title:'هشدار آزمایشی چرخه',priority:'medium',
    date:'2031-03-04',source:'آزمایش رابط',state:'open'};
  const seed=await page.request.patch('/api/records',{headers:origin,data:{version:0,changes:[
    create('projects',project(incident.projectId)),create('incidents',incident),
  ]}});
  expect(seed.status()).toBe(200);
  await page.goto('/alerts');
  const alert=page.getByRole('button',{name:/هشدار آزمایشی چرخه/});
  const dialog=page.getByRole('dialog',{name:'بررسی هشدار'});
  const filter=page.getByLabel('وضعیت هشدار');
  const read=async ()=>(await (await page.request.get('/api/records/incidents/lifecycle-alert')).json()).record;
  await alert.click();
  await dialog.getByRole('button',{name:'تعویق ۲۴ ساعته'}).click();
  await expect(dialog).toHaveCount(0);
  expect(await read()).toEqual(expect.objectContaining({state:'snoozed',snoozedUntil:expect.any(String)}));
  await filter.selectOption('snoozed');
  await alert.click();
  await page.route('**/api/records',route=>route.fulfill({status:422,json:{error:'Synthetic rejection'}}),{times:1});
  const dismiss=dialog.getByRole('button',{name:'کنار گذاشتن هشدار'});
  await dismiss.click();
  await expect(dialog.getByRole('alert')).toContainText('ذخیرهٔ وضعیت هشدار تأیید نشد');
  expect((await read()).state).toBe('snoozed');
  await dismiss.click();
  await expect(dialog).toHaveCount(0);
  expect(await read()).toEqual(expect.objectContaining({state:'dismissed'}));
  expect(await read()).not.toHaveProperty('snoozedUntil');
  await filter.selectOption('dismissed');
  await alert.click();
  await dialog.getByRole('button',{name:'بازگشایی هشدار'}).click();
  await expect(dialog).toHaveCount(0);
  await filter.selectOption('open');
  await alert.click();
  await dialog.getByRole('button',{name:'حل هشدار'}).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await filter.selectOption('resolved');
  await expect(alert).toBeVisible();
  expect((await read()).state).toBe('resolved');
});

test('server details expose real-source measurements and hide stale percentages', async ({page, origin}) => {
  await bootstrap(page.request,origin);
  const id='agent-fixture-server';
  const resource={id,projectId:'agent-fixture',name:'سرور آزمون عامل',linkedProjectIds:[],type:'server',
    address:'203.0.113.85',environment:'Development',status:'registered',provider:'Fixture host',tags:[]};
  const seed=await page.request.patch('/api/records',{headers:origin,data:{version:0,changes:[
    create('projects',project(resource.projectId)),create('resources',resource),
  ]}});
  expect(seed.status()).toBe(200);
  let checkedAt=new Date().toISOString();
  await page.route(/\/api\/monitoring\?resourceId=agent-fixture-server$/,route=>route.fulfill({json:{
    observations:[],machineObservations:[{resourceId:id,checkedAt,cpuPercent:25,usedBytes:512,totalBytes:1024,
      diskUsedBytes:6144,diskTotalBytes:8192,source:'machine-agent',state:'observed'}],
  }}));
  await page.goto('/infrastructure/servers/'+id);
  const metric=(label:string)=>page.locator('.metric').filter({has:page.getByText(label,{exact:true})});
  await expect(metric('CPU')).toContainText('۲۵٪');
  await expect(metric('RAM')).toContainText('۵۰٪');
  await expect(metric('Disk')).toContainText('۷۵٪');
  await expect(metric('Disk')).toContainText('عامل میزبان');
  checkedAt=new Date(Date.now()-16*60_000).toISOString();
  await page.reload();
  await expect(metric('Disk')).toContainText('مشاهدهٔ قدیمی');
  await expect(metric('Disk')).toContainText('نامشخص');
  await expect(metric('Disk')).not.toContainText('۷۵٪');
});

test('the project page renders GitHub commits branches and pull requests with snapshot status', async ({page, origin}) => {
  await bootstrap(page.request,origin);
  const target=project('repository-fixture');
  const seed=await page.request.patch('/api/records',{headers:origin,data:{version:0,changes:[create('projects',target)]}});
  expect(seed.status()).toBe(200);
  const checkedAt='2026-11-20T08:30:00.000Z';
  let state='connected';
  await page.route(/\/api\/integrations\/github\?projectId=repository-fixture$/,route=>route.fulfill({json:{
    status:'configured',repositories:[{repository:'fixture/sample',state,checkedAt,
      commits:[{sha:'a'.repeat(40),subject:'Synthetic commit title',committedAt:checkedAt}],
      branches:[{name:'fixture-branch',sha:'a'.repeat(40)}],
      pullRequests:[{number:3,title:'Synthetic pull title',status:'merged',updatedAt:checkedAt}],
      issues:[{number:7,title:'Synthetic issue title'}]}],
  }}));
  await page.goto('/projects/'+target.id);
  await expect(page.getByRole('link',{name:'fixture/sample'})).toHaveAttribute('href','https://github.com/fixture/sample');
  await expect(page.getByText('دریافت موفق',{exact:true})).toBeVisible();
  for(const [label,title] of [
    ['Commitها','Synthetic commit title'],['شاخه‌ها','fixture-branch'],
    ['درخواست‌های ادغام','Synthetic pull title'],['Issueهای باز','Synthetic issue title'],
  ]) {
    await page.getByText(label,{exact:true}).click();
    await expect(page.getByText(title,{exact:true})).toBeVisible();
  }
  state='stale';
  await page.reload();
  await expect(page.getByText('دادهٔ قدیمی',{exact:true})).toBeVisible();
  await expect(page.getByText('دریافت موفق',{exact:true})).toHaveCount(0);
});
