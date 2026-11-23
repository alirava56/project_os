import { NextRequest, NextResponse } from 'next/server';
import {
  authenticate, checkOrigin, getSessionAccount, hash, newSession, rateLimit, readLimitedJson, readSessionToken, sessionActive, setSessionCookie,
} from '@/lib/server/auth';
import { transaction } from '@/lib/server/db';
import { apiError, jsonError, noStore } from '@/lib/server/http';
import { beginMfa, confirmMfa, issueRecoveryCodes, lockIdentity, mfaEnabled, remainingRecoveryCodes, verifyMfa } from '@/lib/server/mfa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const account = await getSessionAccount();
  if (!account) return apiError('Unauthorized', 401);
  const [enabled, recoveryCodesRemaining] = await Promise.all([mfaEnabled(account.id), remainingRecoveryCodes(account.id)]);
  return NextResponse.json({ enabled, recoveryCodesRemaining }, { headers: noStore });
}

export async function POST(request: NextRequest) {
  if (!checkOrigin(request)) return apiError('Forbidden', 403);
  const account = await getSessionAccount();
  const token = await readSessionToken();
  if (!account || !token) return apiError('Unauthorized', 401);
  let input: unknown;
  try { input = await readLimitedJson(request); }
  catch (error) { return jsonError(error); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return apiError('Invalid body', 400);
  const { action, password, code } = input as { action?: unknown; password?: unknown; code?: unknown };
  if (action !== 'start' && action !== 'confirm' && action !== 'rotate-recovery') return apiError('Unsupported action', 400);
  const quota = await rateLimit('mfa:' + action, account.id, 6, 60_000);
  if (!quota.allowed) return apiError('Try again later', 429, { 'Retry-After': String(quota.retryAfter) });
  if (action !== 'confirm' && await authenticate(account.email, password) !== account.id) return apiError('Re-authentication required', 403);
  const sessionHash = hash(token);
  try {
    const result = await transaction(async db => {
      await lockIdentity(db, account.id);
      const active = await sessionActive(db,account.id,sessionHash);
      if (!active) return { status: 401 as const };
      const enabled = await mfaEnabled(account.id, db);
      if (action === 'start') {
        if (enabled && !await verifyMfa(account.id, code, db)) return { status: 403 as const };
        return { status: 200 as const, body: await beginMfa(account.id, account.email, sessionHash, db) };
      }
      if (action === 'rotate-recovery' && (!enabled || !await verifyMfa(account.id, code, db))) return { status: 403 as const };
      if (action === 'confirm' && !await confirmMfa(account.id, code, sessionHash, db)) return { status: 422 as const };
      const recoveryCodes = await issueRecoveryCodes(account.id, db);
      // New factor or recovery credentials invalidate every historical session.
      await db.run('DELETE FROM sessions WHERE user_id=?', account.id);
      return { status: 200 as const, body: { ok: true, recoveryCodes }, token: await newSession(account.id, db) };
    });
    if (result.status !== 200) return apiError('Session or second factor rejected', result.status);
    if (result.token) await setSessionCookie(result.token);
    return NextResponse.json(result.body, { headers: noStore });
  } catch {
    return apiError('MFA is unavailable', 503);
  }
}
