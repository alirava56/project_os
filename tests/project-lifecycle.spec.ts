import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { setupToken, startTestApp } from './isolated-app';
import { createPostgresFixture } from './postgres-fixture';
const email = 'lifecycle-owner@example.test';
const password = 'synthetic-lifecycle-e2e-password';

const pgTest = test.extend<{ app: { url: string; restart(): Promise<string> } }>({
  ignoreHTTPSErrors: async ({app},provide) => { await provide(app.url.startsWith('https://127.0.0.1:')); },
  app: async ({playwright}, provide) => {
    const dir = await mkdtemp(join(tmpdir(), 'projectos-lifecycle-'));
    const sqlitePath = join(dir, 'must-not-exist.sqlite');
    let database: Awaited<ReturnType<typeof createPostgresFixture>> | undefined;
    let server: Awaited<ReturnType<typeof startTestApp>> | undefined;
    try {
      const fixture = await createPostgresFixture();
      database = fixture;
      async function restart() {
        await server?.stop();
        server = await startTestApp({sqlitePath, postgresUrl:fixture.url, postgresScopeKey:fixture.scopeKey});
        return server.url;
      }
      const url = await restart();
      const bootstrap = await playwright.request.newContext({baseURL:url, ignoreHTTPSErrors:url.startsWith('https://127.0.0.1:')});
      try {
        const result = await bootstrap.post('/api/auth/setup', {headers:{Origin:url,'Sec-Fetch-Site':'same-origin'},
          data:{setupToken,email,password,displayName:'مالک آزمایشی',workspace:'فضای پذیرش آزمایشی'}});
        expect(result.status()).toBe(200);
      } finally { await bootstrap.dispose(); }
      await provide({url, restart});
      await expect(access(sqlitePath)).rejects.toMatchObject({code:'ENOENT'});
    } finally {
      try {
        await server?.stop();
      } finally {
        try { await database?.dispose(); }
        finally { await rm(dir, {recursive:true, force:true, maxRetries:5}); }
      }
    }
  },
});

async function login(page: Page, url: string) {
  await page.goto(url + '/login');
  await page.getByLabel('ایمیل', {exact:true}).fill(email);
  await page.getByLabel('رمز عبور', {exact:true}).fill(password);
  await page.getByRole('button', {name:'ورود امن', exact:true}).click();
  await expect(page).toHaveURL(url + '/dashboard');
}

async function openTab(page: Page, name: string) {
  await page.getByRole('group', {name:'بخش‌های پروژه'}).getByRole('button', {name, exact:true}).click();
}

type InventoryInput = { name: string; type: 'server' | 'domain' | 'database'; address: string; parent?: string };
async function addResource(page: Page, resource: InventoryInput, projectName: string) {
  await page.getByRole('button', {name:'افزودن منبع', exact:true}).click();
  const dialog = page.getByRole('dialog', {name:'افزودن منبع'});
  await expect(dialog.getByLabel('پروژه', {exact:true}).locator('option:checked')).toHaveText(projectName);
  await dialog.getByLabel('نام منبع').fill(resource.name);
  await dialog.getByLabel('نوع منبع').selectOption(resource.type);
  await dialog.getByLabel('آدرس').fill(resource.address);
  await dialog.getByLabel('ارائه‌دهنده').fill('میزبان آزمایشی');
  await dialog.getByLabel('محیط').selectOption('Staging');
  await dialog.getByLabel('سررسید (میلادی)').fill('2027-03-01');
  await dialog.getByLabel('اعلان (روز قبل از موعد)').fill('2');
  if (resource.type === 'database') await dialog.getByLabel('پورت سرویس').fill('5432');
  if (resource.type === 'server') await dialog.getByLabel('پورت SSH').fill('2222');
  if (resource.parent) await dialog.getByLabel('منبع والد').selectOption({label:resource.parent + ' · ' + projectName});
  await dialog.getByRole('button', {name:'ثبت مشخصات', exact:true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(resource.name, {exact:true})).toBeVisible();
}

for (const [projectName, slug] of [['NovaGuard آزمایشی', 'nova'], ['باشگاه آزمایشی', 'club'], ['MOKMOK آزمایشی', 'mok']]) {
  pgTest('persists ' + slug + ' project, linked resources, tasks and Runbook after restart and new login', async ({app, browser, page}) => {
    const { url } = app;
    await login(page, url);
    await page.goto(url + '/projects');
    await page.getByRole('button', {name:'پروژه جدید', exact:true}).click();
    await page.getByLabel('نام پروژه').fill(projectName);
    await page.getByRole('button', {name:'ایجاد پروژه', exact:true}).click();
    const heading = page.getByRole('heading', {name:projectName, level:1});
    await expect(heading).toBeVisible();
    const projectPath = new URL(page.url()).pathname;
    expect(projectPath).toMatch(/^\/projects\/project-/);

    const server = 'VPS آزمایشی ' + slug;
    const runbook = 'راهنمای عملیات ' + slug;
    const resources: InventoryInput[] = [
      {name:server, type:'server', address:'203.0.113.24'},
      {name:'دامنهٔ اول ' + slug, type:'domain', address:slug + '.example.test', parent:server},
      {name:'دامنهٔ دوم ' + slug, type:'domain', address:'api.' + slug + '.example.test', parent:server},
      {name:'پایگاه دادهٔ ' + slug, type:'database', address:'db.' + slug + '.example.test', parent:server},
    ];
    await openTab(page, 'زیرساخت');
    for (const resource of resources) await addResource(page, resource, projectName);
    await openTab(page, 'مستندات');
    await page.getByRole('button', {name:'سند جدید', exact:true}).click();
    await page.getByLabel('عنوان سند').fill(runbook);
    await page.getByLabel('متن سند (بدون رمز و توکن)').fill('گام‌های ساختگی بازیابی سرویس');
    await page.getByRole('button', {name:'ذخیره سند', exact:true}).click();
    await expect(page.getByText(runbook, {exact:true})).toBeVisible();

    const tasks = ['بررسی نسخه ' + slug, 'بازبینی شبکه ' + slug];
    for (const task of tasks) {
      await page.getByRole('button', {name:'افزودن وظیفه', exact:true}).click();
      await page.getByLabel('عنوان وظیفه').fill(task);
      await page.getByRole('button', {name:'ایجاد وظیفه', exact:true}).click();
      await expect(page).toHaveURL(/\/tasks\/task-/);
      await page.goto(url + projectPath);
    }
    await page.getByRole('button', {name:'ویرایش پروژه', exact:true}).click();
    const description = 'توضیحات به‌روزشدهٔ ' + slug;
    await page.getByLabel('توضیحات', {exact:true}).fill(description);
    await page.getByRole('button', {name:'ذخیره تغییرات', exact:true}).click();
    await expect(page.getByText(description, {exact:true})).toBeVisible();

    async function verifyContents(view: Page) {
      await expect(view.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(view.getByText(description, {exact:true})).toBeVisible();
      await openTab(view, 'وظایف');
      for (const task of tasks) await expect(view.getByText(task, {exact:true})).toBeVisible();
      await openTab(view, 'مستندات');
      await expect(view.getByText(runbook, {exact:true})).toBeVisible();
      await openTab(view, 'زیرساخت');
      for (const resource of resources) await expect(view.getByText(resource.name, {exact:true})).toBeVisible();
      await view.getByText(resources[3].name, {exact:true}).click();
      const details = view.getByRole('dialog', {name:resources[3].name});
      await expect(details.getByText('5432', {exact:true})).toBeVisible();
      await expect(details.getByText('۲ روز پیش از موعد', {exact:true})).toBeVisible();
      await expect(details.getByRole('link', {name:server, exact:true})).toBeVisible();
    }
    await page.reload();
    await verifyContents(page);

    const restartedUrl = await app.restart();
    const fresh = await browser.newContext({ignoreHTTPSErrors:restartedUrl.startsWith('https://127.0.0.1:')});
    try {
      const view = await fresh.newPage();
      await login(view, restartedUrl);
      await view.goto(restartedUrl + projectPath);
      await verifyContents(view);
    } finally { await fresh.close(); }
  });
}
