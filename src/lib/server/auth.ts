import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { lockBootstrap, requireWebRuntime } from '../../../scripts/database.mjs';
import { accountByUser, ForbiddenError, readTransaction, sql, transaction, userCount, type Account, type SqlExecutor } from './db';
import { mfaEnabled } from './mfa';
import { redactCredentials, suspiciousCredential } from './credential-guard';

export const COOKIE = process.env.NODE_ENV === 'production' ? '__Host-projectos_session' : 'projectos_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
export const hash = (token: string) => createHash('sha256').update(token).digest('hex');

function canonicalOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.origin !== value) return null;
    if (url.protocol === 'https:' || (url.protocol === 'http:' && local(url.hostname))) return value;
  } catch { /* malformed operator configuration */ }
  return null;
}

function local(hostname: string) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

export function requireMfa() {
  const configured = process.env.PROJECTOS_PUBLIC_ORIGIN;
  if (process.env.PROJECTOS_REQUIRE_MFA === 'enabled') return true;
  if (process.env.NODE_ENV !== 'production') return false;
  const origin = canonicalOrigin(configured);
  return !origin || !local(new URL(origin).hostname);
}

export function checkOrigin(request: NextRequest) {
  const configured = process.env.PROJECTOS_PUBLIC_ORIGIN;
  const expected = configured || process.env.NODE_ENV === 'production'
    ? canonicalOrigin(configured)
    : request.nextUrl.origin;
  return expected !== null && request.headers.get('origin') === expected
    && ['same-origin', 'none', null].includes(request.headers.get('sec-fetch-site'));
}

export function passwordHash(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString('hex'));
    });
  });
}

export function validatePassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 12 && password.length <= 128 && !/[\u0000-\u001f]/.test(password);
}

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const value = email.trim().toLowerCase();
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !suspiciousCredential(value) ? value : null;
}

export function safeDisplayLabel(label: unknown): string | undefined {
  if (typeof label !== 'string') return;
  const value = label.trim();
  if (!value || value.length > 80 || /[\u0000-\u001f]/.test(value) || suspiciousCredential(value)) return;
  return value;
}

export async function setupOwner(input: {setupToken: unknown; email: unknown; password: unknown; displayName: unknown; workspace: unknown}) {
  const setup = process.env.PROJECTOS_SETUP_TOKEN;
  if (!setup || setup.length < 24 || typeof input.setupToken !== 'string' || input.setupToken.length > 1024
    || !timingSafeEqual(Buffer.from(hash(setup), 'hex'), Buffer.from(hash(input.setupToken), 'hex'))) {
    throw new Error('SETUP_FORBIDDEN');
  }
  const email = normalizeEmail(input.email);
  const { password } = input;
  const displayName = safeDisplayLabel(input.displayName);
  const workspace = safeDisplayLabel(input.workspace);
  if (!email || !validatePassword(password) || !displayName || !workspace) throw new Error('INVALID_INPUT');
  await requireWebRuntime();
  const salt = randomBytes(24).toString('hex');
  const digest = await passwordHash(password, salt);
  return transaction(async db => {
    await lockBootstrap(db);
    const exists = db.dialect === 'postgres'
      ? !(await db.one<{open:boolean}>('SELECT public.projectos_setup_open() AS open'))?.open
      : await db.one('SELECT id FROM users LIMIT 1');
    if (exists) throw new Error('SETUP_CLOSED');
    const id = randomUUID(), workspaceId = randomUUID(), now = new Date().toISOString();
    await db.scopeIdentity?.({purpose:'bootstrap',userId:id,workspaceId});
    await db.run('INSERT INTO users(id,email,display_name,password_hash,salt,created_at) VALUES(?,?,?,?,?,?)',
      id, email, displayName, digest, salt, now);
    await db.run('INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)', workspaceId, workspace, now);
    await db.run('INSERT INTO memberships(user_id,workspace_id,role) VALUES(?,?,?)', id, workspaceId, 'owner');
    return id;
  });
}

export async function authenticate(email: unknown, password: unknown) {
  if (typeof password !== 'string' || password.length > 128) return null;
  const normalized = normalizeEmail(email);
  const row = await readTransaction(async db => {
    await db.scopeIdentity?.({purpose:'login',email:normalized ?? ''});
    type Credentials = {id: string; password_hash: string; salt: string};
    return db.scopeIdentity
      ? db.one<Credentials>('SELECT id,password_hash,salt FROM public.projectos_password_credentials()')
      : db.one<Credentials>('SELECT id,password_hash,salt FROM users WHERE email=?', normalized ?? '');
  });
  const candidate = await passwordHash(password, row?.salt ?? '00'.repeat(24));
  const expected = Buffer.from(row?.password_hash ?? '00'.repeat(64), 'hex');
  const matches = expected.length === 64 && timingSafeEqual(Buffer.from(candidate, 'hex'), expected);
  if (row) await transaction(async db => {
    await db.scopeIdentity?.({purpose:'login',email:normalized ?? ''});
    if (matches) await db.run('UPDATE users SET failed_logins=0,locked_until=0 WHERE id=? AND (failed_logins<>0 OR locked_until<>0)', row.id);
    else await db.run('UPDATE users SET failed_logins=CASE WHEN failed_logins<1000 THEN failed_logins+1 ELSE failed_logins END WHERE id=?', row.id);
  });
  return matches && row ? row.id : null;
}

export async function rateLimit(
  scope: string, bucket: string, limit: number, windowMs: number, timestamp = Date.now(), db = sql,
): Promise<{allowed:boolean; retryAfter:number}> {
  if (db === sql) return transaction(connection => rateLimit(scope,bucket,limit,windowMs,timestamp,connection));
  const bucketHash = hash(bucket);
  await db.scopeIdentity?.({purpose:'rate',scope,bucket:bucketHash});
  const expiresAt = Math.floor(timestamp / windowMs) * windowMs + windowMs;
  const row = await db.one<{hits: number}>(`INSERT INTO auth_rate_limits(scope,bucket,expires_at,hits) VALUES(?,?,?,1)
    ON CONFLICT(scope,bucket) DO UPDATE SET
      hits=CASE WHEN auth_rate_limits.expires_at<>excluded.expires_at THEN 1
        WHEN auth_rate_limits.hits<? THEN auth_rate_limits.hits+1 ELSE auth_rate_limits.hits END,
      expires_at=excluded.expires_at
    RETURNING hits`, scope, bucketHash, expiresAt, limit + 1);
  return { allowed: (row?.hits ?? limit + 1) <= limit, retryAfter: Math.max(1, Math.ceil((expiresAt - timestamp) / 1000)) };
}

export async function authRate(request: NextRequest, scope: string) {
  await requireWebRuntime();
  const source = request.headers.get('x-projectos-client-ip');
  const proxyConfigured = process.env.PROJECTOS_TRUST_CLIENT_IP === 'enabled';
  if (proxyConfigured && (!source || !isIP(source))) return { allowed: false, retryAfter: 60 };
  const global = await rateLimit(scope + ':global', 'global', proxyConfigured ? 240 : 60, 60_000);
  if (!global.allowed || !proxyConfigured) return global;
  return rateLimit(scope + ':source', source!, 20, 60_000);
}

export async function newSession(userId: string, db?: SqlExecutor): Promise<string> {
  if (!db) return transaction(connection => newSession(userId, connection));
  await db.scopeIdentity?.({purpose:'mfa',userId});
  if (!await accountByUser(userId, db)) throw new ForbiddenError();
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  await db.run('DELETE FROM sessions WHERE user_id=? AND (expires_at<=? OR last_seen_at<=?)',
    userId, now, now - SESSION_IDLE_MS);
  await db.run('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)',
    hash(token), userId, now, now + SESSION_SECONDS * 1000, now);
  return token;
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(COOKIE, token, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict',
    path: '/', maxAge: SESSION_SECONDS,
  });
}

export function readSessionToken() {
  return cookies().then(jar => jar.get(COOKIE)?.value);
}

export async function lookupSessionUserId(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const now = Date.now();
  const tokenHash = hash(token);
  return transaction(async db => {
    await db.scopeIdentity?.({purpose:'session',digest:tokenHash});
    if (db.scopeIdentity) return (await db.one<{id:string|null}>(
      'SELECT public.projectos_session_user(?,?) AS id',now,now-SESSION_IDLE_MS))?.id ?? null;
    const row = await db.one<{id: string; lastSeen: number}>(`SELECT s.user_id AS id,s.last_seen_at AS "lastSeen"
      FROM sessions s WHERE s.token_hash=? AND s.expires_at>? AND s.last_seen_at>?`, tokenHash, now, now - SESSION_IDLE_MS);
    if (!row) return null;
    if (now - row.lastSeen > 60_000) await db.run('UPDATE sessions SET last_seen_at=? WHERE token_hash=? AND last_seen_at<?',
      now, tokenHash, now - 60_000);
    return row.id;
  });
}

export async function getSessionAccount(): Promise<Account | null> {
  await requireWebRuntime();
  const token = await readSessionToken();
  const id = token ? await lookupSessionUserId(token) : null;
  if (!id) return null;
  const account = await accountByUser(id);
  return account ? { ...account, displayName: redactCredentials(account.displayName) } : null;
}

export async function getCurrentAccount(): Promise<Account | null> {
  const account = await getSessionAccount();
  if (!account) return null;
  if (requireMfa() && !await mfaEnabled(account.id)) return null;
  return account;
}

export async function signOut() {
  await requireWebRuntime();
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await transaction(async db => {
    const digest = hash(token);
    await db.scopeIdentity?.({purpose:'session',digest});
    if (db.scopeIdentity) await db.one('SELECT public.projectos_end_session()');
    else await db.run('DELETE FROM sessions WHERE token_hash=?', digest);
  });
  jar.set(COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 0 });
}

export async function sessionActive(db:SqlExecutor,userId:string,digest:string) {
  const now = Date.now();
  if (db.scopeIdentity) return (await db.one<{active:boolean}>(
    'SELECT public.projectos_session_active(?,?,?) AS active',digest,now,now-SESSION_IDLE_MS))?.active === true;
  return Boolean(await db.one('SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>? AND last_seen_at>?',
    digest,userId,now,now-SESSION_IDLE_MS));
}

export { userCount };

export class RequestBodyTooLargeError extends Error {
  constructor() { super('Request body exceeds allowed byte limit'); }
}

export async function readJsonBytes(request: NextRequest, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid body limit');
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new Error('JSON content type required');
  const length = request.headers.get('content-length');
  if (length !== null) {
    if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) throw new Error('Invalid Content-Length');
    if (Number(length) > maxBytes) throw new RequestBodyTooLargeError();
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Empty request body');
  const parts: Buffer[] = [];
  let consumed = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consumed += value.byteLength;
      if (consumed > maxBytes) {
        void reader.cancel('Body exceeds limit').catch(() => {});
        throw new RequestBodyTooLargeError();
      }
      parts.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts, consumed);
}

export async function readLimitedJson(request: NextRequest, maxBytes = 4096): Promise<unknown> {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readJsonBytes(request, maxBytes)));
}
