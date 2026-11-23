import { fork } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request, test as playwright } from '@playwright/test';
import { createPostgresFixture, type PostgresFixture } from './postgres-fixture';

export const setupToken = 'this-is-a-public-test-only-token-not-a-secret';
export type Origin = { Origin: string; 'Sec-Fetch-Site': 'same-origin' };
const testTls = (appURL: string) => appURL.startsWith('https://127.0.0.1:');
export function testRequest(appURL: string) {
  return request.newContext({baseURL:appURL,ignoreHTTPSErrors:testTls(appURL)});
}

export async function startTestApp({ sqlitePath, postgresUrl, postgresScopeKey, enforceMfa = false, vault }: {
  sqlitePath: string; postgresUrl?: string; postgresScopeKey?: string; enforceMfa?: boolean;
  vault?: {origin:string;workspace:string;token:string;ca:string};
}) {
  const server = fork(resolve('scripts/prepare-e2e.mjs'), [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PROJECTOS_/i.test(name))),
      NODE_ENV: 'production',
      PROJECTOS_DB_PATH: sqlitePath,
      PROJECTOS_DATABASE_URL: postgresUrl ?? '',
      PROJECTOS_DATABASE_MODE: postgresUrl ? 'postgres' : '',
      PROJECTOS_DB_SCOPE_KEY: postgresScopeKey ?? '',
      PROJECTOS_REQUIRE_MFA: enforceMfa ? 'enabled' : 'disabled',
      PROJECTOS_SETUP_TOKEN: setupToken,
      PROJECTOS_MFA_ENCRYPTION_KEY: '35'.repeat(32),
      PROJECTOS_TEST_TLS_KEY: process.env.PROJECTOS_TEST_TLS_KEY ?? '',
      PROJECTOS_TEST_TLS_CERT: process.env.PROJECTOS_TEST_TLS_CERT ?? '',
      PROJECTOS_GITHUB_TOKEN: '',
      PROJECTOS_AI_ENABLED: 'disabled',
      PROJECTOS_TELEGRAM_NOTIFICATIONS: 'disabled',
      ...(vault ? {
        PROJECTOS_VAULT_ORIGIN:vault.origin,PROJECTOS_VAULT_WORKSPACE:vault.workspace,
        PROJECTOS_VAULT_TOKEN:vault.token,PROJECTOS_VAULT_MOUNTS:'fixture-kv',NODE_EXTRA_CA_CERTS:vault.ca,
      } : {}),
    },
  });
  let logs = '';
  const append = (data: Buffer) => { logs = (logs + data.toString()).slice(-4000); };
  server.stdout?.on('data', append);
  server.stderr?.on('data', append);
  const exited = new Promise<void>(done => server.once('close', () => done()));
  async function stop() {
    if (server.exitCode === null && server.signalCode === null) server.kill();
    await exited;
  }
  try {
    const url = await new Promise<string>((ready, fail) => {
      const timer = setTimeout(() => fail(new Error(`Test server startup timed out\n${logs}`)), 35_000);
      server.once('message', (message: { url?: unknown }) => {
        clearTimeout(timer);
        if (typeof message.url !== 'string' || !/^https?:\/\/127\.0\.0\.1:\d+$/.test(message.url)) {
          fail(new Error('Invalid test server endpoint'));
          return;
        }
        ready(message.url);
      });
      server.once('error', error => { clearTimeout(timer); fail(error); });
      server.once('exit', code => { clearTimeout(timer); fail(new Error(`Test server exited (${code})\n${logs}`)); });
    });
    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export type BackendOptions = {backend: 'sqlite' | 'postgres'};

export const test = playwright.extend<BackendOptions & {
  appURL: string; origin: Origin; enforceMfa: boolean; postgresFixture: PostgresFixture | undefined;
  testApp: Awaited<ReturnType<typeof startTestApp>>;
}>({
  backend: ['sqlite', { option:true }],
  enforceMfa: [false, { option:true }],
  postgresFixture: async ({backend}, provide) => {
    if (backend === 'sqlite') return provide(undefined);
    const database = await createPostgresFixture();
    try { await provide(database); }
    finally { await database.dispose(); }
  },
  testApp: async ({enforceMfa,postgresFixture}, provide) => {
    const dir = await mkdtemp(join(tmpdir(), 'projectos-smoke-'));
    const sqlitePath = join(dir, 'smoke.sqlite');
    try {
      const server = await startTestApp({
        sqlitePath, enforceMfa, postgresUrl:postgresFixture?.url, postgresScopeKey:postgresFixture?.scopeKey,
      });
      try {
        if (postgresFixture) {
          const probe = await testRequest(server.url);
          try {
            if (!(await probe.get('/api/health')).ok()) throw new Error('Limited PostgreSQL browser fixture is unavailable');
          } finally { await probe.dispose(); }
        }
        await provide(server);
        if (postgresFixture) await access(sqlitePath).then(
          () => { throw new Error('Unexpected SQLite file during PostgreSQL browser fixture'); },
          (error:NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; },
        );
      }
      finally { await server.stop(); }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  },
  appURL: async ({testApp}, provide) => provide(testApp.url),
  baseURL: async ({ appURL }, provide) => { await provide(appURL); },
  ignoreHTTPSErrors: async ({ appURL }, provide) => { await provide(testTls(appURL)); },
  origin: async ({ appURL }, provide) => { await provide({ Origin: appURL, 'Sec-Fetch-Site': 'same-origin' }); },
});
