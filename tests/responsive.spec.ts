import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { setupToken, test } from './isolated-app';
import { routes } from './routes';

const widths = [360, 390, 768, 1024, 1440, 1920];
const mobileReferences = ['dashboard', 'projects', 'project', 'tasks', 'infrastructure'];

test.beforeEach(async ({page, origin}) => {
  const result = await page.request.post('/api/auth/setup', {headers:origin, data:{
    setupToken, email:'responsive-owner@example.test', password:'synthetic-responsive-regression-password',
    displayName:'آزمون رابط',workspace:'فضای آزمایشی رابط',
  }});
  expect(result.status()).toBe(200);
  const project = {id:'gym', name:'باشگاه شب قهرمانان', coverTitle:'باشگاه شب قهرمانان', subtitle:'آزمایشی',
    description:'', status:'building', type:'وب‌سایت', progress:0, next:'', art:'navigation/projects'};
  const server = {id:'nova-vps', name:'NovaGuard Main VPS', projectId:'gym', type:'server', address:'203.0.113.24',
    environment:'Staging', status:'registered', provider:'Synthetic provider', tags:[], linkedProjectIds:[]};
  const task = {id:'TASK-024', title:'رفع ناسازگاری رابط رزرو', projectId:'gym', status:'todo', priority:'medium',
    owner:'آزمایشی', due:'2027-03-01', description:'', checklist:[], comments:[], dependencies:[]};
  const seeded = await page.request.patch('/api/records', {headers:origin, data:{version:0, changes:[
    {action:'create', kind:'projects', id:project.id, record:project},
    {action:'create', kind:'resources', id:server.id, record:server},
    {action:'create', kind:'tasks', id:task.id, record:task},
  ]}});
  expect(seeded.status(), await seeded.text()).toBe(200);
});

for (const width of widths) {
  test(`21 RTL routes at ${width}px`, async ({ context, browserName }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    const external = new Set<string>();

    for (const [route, key, title] of routes) {
      await test.step(route, async () => {
        if (key === 'login') await context.clearCookies();
        const page = await context.newPage();
        try {
          await page.setViewportSize({ width, height: width <= 390 ? 880 : 1000 });
          page.on('pageerror', error => errors.push(error.message));
          page.on('console', message => {
            if (message.type() === 'error') errors.push(message.text());
          });
          page.on('response', response => {
            const url = new URL(response.url());
            if (url.pathname.startsWith('/api/') && response.status() >= 500) {
              errors.push(`${response.status()} ${url.pathname}`);
            }
          });
          page.on('request', request => {
            const url = new URL(request.url());
            if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== '127.0.0.1') external.add(url.origin);
          });
          const response = await page.goto(route);
          expect(response?.ok()).toBe(true);
          expect(new URL(page.url()).pathname).toBe(route);
          await expect(page.getByRole('heading', { name: title, level: 1, exact: true })).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('dir','rtl');
          await expect(page.locator('html')).toHaveAttribute('lang','fa');
          await page.evaluate(() => document.fonts.ready);
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          if (width <= 390) {
            const compactTablesFit = await page.locator('.table-compact').evaluateAll(tables =>
              tables.every(table => table.scrollWidth <= table.clientWidth + 1));
            expect(compactTablesFit).toBe(true);
          }
          if (key !== 'login') {
            await expect(page.getByRole('navigation', { name: 'مسیر صفحه' })).toBeVisible();
            await expect(page.getByRole('navigation', { name: width > 900 ? 'منوی اصلی' : 'دسترسی سریع' })).toBeVisible();
          }
          const shots = process.env.PROJECTOS_SCREENSHOTS;
          if (shots && (width === 1440 || (width === 390 && mobileReferences.includes(key)))) {
            await mkdir(shots, { recursive: true });
            await page.screenshot({ path: path.join(shots,`${width}-${key}.png`),fullPage:true,animations:'disabled' });
          }
          // WebKit can report an interrupted prefetch while tearing down the document.
          if (browserName==='webkit') await page.waitForLoadState('networkidle', {timeout:12_000});
        } finally { await page.close(); }
      });
    }
    expect(errors).toEqual([]);
    expect([...external]).toEqual([]);
  });
}
