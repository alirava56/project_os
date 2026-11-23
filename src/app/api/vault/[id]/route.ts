import { NextRequest, NextResponse } from 'next/server';
import type { SecretReference } from '@/lib/types';
import { validRecordId } from '@/lib/record-contract';
import { authenticate, checkOrigin, getCurrentAccount, rateLimit, readLimitedJson } from '@/lib/server/auth';
import { lockWorkspace, projectPolicy, readTransaction, storedRecord, transaction } from '@/lib/server/db';
import { apiError, jsonError, noStore } from '@/lib/server/http';
import { mfaEnabled, verifyMfa } from '@/lib/server/mfa';
import { configuredVaultReference, vaultSettings, verifyVaultReference } from '@/lib/server/vault';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
type Context = {params: Promise<{id:string}>};

export async function GET(_request: NextRequest, context: Context) {
  const account = await getCurrentAccount();
  if (!account) return apiError('Unauthenticated', 401);
  const {id} = await context.params;
  if (account.role !== 'owner' || !validRecordId(id)) return apiError('Not found', 404);
  const value = await readTransaction(async db => {
    await projectPolicy(db, account);
    const row = await storedRecord(db, account.workspaceId, 'secrets', id);
    if (!row) return;
    const reference = JSON.parse(row.payload) as SecretReference;
    const configured = configuredVaultReference(reference, vaultSettings(account.workspaceId));
    const check = await db.one<{status:string; checkedAt:string; providerVersion:number | null}>(
      `SELECT status,checked_at AS "checkedAt",provider_version AS "providerVersion" FROM vault_checks
       WHERE workspace_id=? AND ref_id=? AND reference_version=?`, account.workspaceId, id, row.record_version);
    if (!configured) return {status:'not_configured', checkedAt:null};
    if (!check) return {status:'unknown', checkedAt:null};
    const age = Date.now() - Date.parse(check.checkedAt);
    return age >= 0 && age <= 3600_000 ? check : {...check, status:'stale'};
  });
  return value ? NextResponse.json(value, {headers:noStore}) : apiError('Not found', 404);
}

export async function POST(request: NextRequest, context: Context) {
  if (!checkOrigin(request)) return apiError('Origin rejected', 403);
  const account = await getCurrentAccount();
  if (!account) return apiError('Unauthenticated', 401);
  const {id} = await context.params;
  if (account.role !== 'owner' || !validRecordId(id)) return apiError('Not found', 404);
  let input: unknown;
  try { input = await readLimitedJson(request, 1024); }
  catch (error) { return jsonError(error); }
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => key !== 'password' && key !== 'totp')) return apiError('Invalid verification request', 400);
  const body = input as {password?: unknown; totp?: unknown};
  const quota = await rateLimit('vault:verify', account.id, 8, 60_000);
  if (!quota.allowed) return apiError('Try again later', 429, {'Retry-After':String(quota.retryAfter)});
  if (await authenticate(account.email, body?.password) !== account.id) return apiError('Re-authentication required', 403);
  const reference = await transaction(async db => {
    await projectPolicy(db, account);
    if (await mfaEnabled(account.id, db) && !await verifyMfa(account.id, body?.totp, db)) return null;
    return storedRecord(db, account.workspaceId, 'secrets', id);
  });
  if (reference === null) return apiError('Fresh MFA required', 403);
  if (!reference) return apiError('Not found', 404);
  const item = JSON.parse(reference.payload) as SecretReference;
  const check = await verifyVaultReference(item, vaultSettings(account.workspaceId));
  if (check.status === 'not_configured') return NextResponse.json({...check, checkedAt:null}, {headers:noStore});
  const checkedAt = new Date().toISOString();
  const saved = await transaction(async db => {
    await lockWorkspace(db, account.workspaceId);
    await projectPolicy(db, account);
    const current = await storedRecord(db, account.workspaceId, 'secrets', id);
    if (!current || current.record_version !== reference.record_version) return false;
    await db.run(`INSERT INTO vault_checks(workspace_id,ref_id,reference_version,checked_at,status,provider_version)
      VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,ref_id) DO UPDATE SET reference_version=excluded.reference_version,
      checked_at=excluded.checked_at,status=excluded.status,provider_version=excluded.provider_version`,
    account.workspaceId, id, current.record_version, checkedAt, check.status, check.providerVersion);
    await db.run(`INSERT INTO audit_events(id,workspace_id,actor_id,kind,record_id,action,title,project_id,created_at,actor_snapshot)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, randomUUID(), account.workspaceId, account.id, 'secrets', id, 'verify',
    'بررسی فرادادهٔ خزانه', item.projectId, checkedAt, account.displayName);
    return true;
  });
  return saved ? NextResponse.json({...check, checkedAt}, {headers:noStore}) : apiError('Reference changed', 409);
}