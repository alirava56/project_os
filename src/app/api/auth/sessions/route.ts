import { NextRequest, NextResponse } from 'next/server';
import { authenticate, checkOrigin, getCurrentAccount, hash, rateLimit, readLimitedJson, readSessionToken, sessionActive, SESSION_IDLE_MS, signOut } from '@/lib/server/auth';
import { readTransaction, transaction } from '@/lib/server/db';
import { apiError, jsonError, noStore } from '@/lib/server/http';
import { lockIdentity, mfaEnabled, verifyMfa } from '@/lib/server/mfa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const reference = (tokenHash: string) => hash('projectos:session-reference:' + tokenHash);

export async function GET() {
  const account = await getCurrentAccount();
  const token = await readSessionToken();
  if (!account || !token) return apiError('Unauthenticated', 401);
  const now = Date.now();
  const current = hash(token);
  type Session = {id:string; current:boolean; createdAt:number; expiresAt:number; lastSeenAt:number};
  const sessions = await readTransaction(async db => {
    await db.scopeIdentity?.({purpose:'session-list',userId:account.id});
    if (db.scopeIdentity) return db.all<Session>('SELECT * FROM public.projectos_list_sessions(?,?,?)',current,now,now-SESSION_IDLE_MS);
    const rows = await db.all<Omit<Session,'id'|'current'> & {token_hash:string}>(
      `SELECT token_hash,created_at AS "createdAt",expires_at AS "expiresAt",last_seen_at AS "lastSeenAt"
        FROM sessions WHERE user_id=? AND expires_at>? AND last_seen_at>? ORDER BY created_at DESC`,
      account.id, now, now - SESSION_IDLE_MS,
    );
    return rows.map(({token_hash,...metadata}) => ({...metadata,id:reference(token_hash),current:token_hash===current}));
  });
  return NextResponse.json({ sessions, count: sessions.length }, { headers: noStore });
}

export async function POST(request: NextRequest) {
  if (!checkOrigin(request)) return apiError('Origin rejected', 403);
  const account = await getCurrentAccount();
  const token = await readSessionToken();
  if (!account || !token) return apiError('Unauthenticated', 401);
  let input: unknown;
  try { input = await readLimitedJson(request, 1024); }
  catch (error) { return jsonError(error); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return apiError('Invalid body', 400);
  const { action, password, totp, sessionId } = input as { action?: unknown; password?: unknown; totp?: unknown; sessionId?: unknown };
  if (action !== 'revokeOthers' && action !== 'revokeAll' && action !== 'revokeOne') return apiError('Unsupported action', 422);
  const quota = await rateLimit('sessions:reauthenticate', account.id, 8, 60_000);
  if (!quota.allowed) return apiError('Try again later', 429, {'Retry-After': String(quota.retryAfter)});
  if (await authenticate(account.email, password) !== account.id) return apiError('Re-authentication failed', 403);
  const current = hash(token);
  const result = await transaction(async db => {
    await lockIdentity(db, account.id);
    if (!await sessionActive(db,account.id,current)) return { status: 401 as const };
    if (await mfaEnabled(account.id, db) && !await verifyMfa(account.id, totp, db)) return { status: 403 as const };
    if (db.scopeIdentity) {
      const result = await db.one<{revoked:number; signedOut:boolean}>(
        'SELECT * FROM public.projectos_revoke_sessions(?,?,?)',current,action,typeof sessionId==='string' ? sessionId : null);
      if (!result || (action==='revokeOne' && !result.revoked)) return {status:404 as const};
      return {status:200 as const,...result};
    }
    if (action === 'revokeOne') {
      const sessions = await db.all<{token_hash: string}>('SELECT token_hash FROM sessions WHERE user_id=?', account.id);
      const target = sessions.find(session => reference(session.token_hash) === sessionId);
      if (!target) return { status: 404 as const };
      return {
        status: 200 as const, signedOut: target.token_hash === current,
        revoked: await db.run('DELETE FROM sessions WHERE user_id=? AND token_hash=?', account.id, target.token_hash),
      };
    }
    const revoked = action === 'revokeOthers'
      ? await db.run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', account.id, current)
      : await db.run('DELETE FROM sessions WHERE user_id=?', account.id);
    return { status: 200 as const, revoked, signedOut: action === 'revokeAll' };
  });
  if (result.status !== 200) return apiError('Session or second factor rejected', result.status);
  if (result.signedOut) await signOut();
  return NextResponse.json({ ok: true, revoked: result.revoked, signedOut: result.signedOut }, { headers: noStore });
}
