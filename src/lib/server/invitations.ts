import { randomBytes, randomUUID } from 'node:crypto';
import { validRecordId } from '../record-contract';
import { accountByUser, ForbiddenError, lockWorkspace, projectPolicy, readTransaction, storedRecord, transaction, type Account, type SqlExecutor } from './db';
import { authenticate, hash, normalizeEmail, passwordHash, rateLimit, safeDisplayLabel, validatePassword } from './auth';
import { lockIdentity, mfaEnabled, verifyMfa, verifyRecoveryCode } from './mfa';

export class InvitationError extends Error {}

async function projectScope(db: SqlExecutor, workspaceId: string, input: unknown): Promise<string | null> {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input) || input.length > 100 || !input.every(validRecordId)) throw new InvitationError('INVALID_PROJECT_GRANT');
  const ids = [...new Set(input)];
  for (const id of ids) {
    if (!await storedRecord(db, workspaceId, 'projects', id)) throw new InvitationError('INVALID_PROJECT_GRANT');
  }
  return JSON.stringify(ids);
}

async function lockOwner(db: SqlExecutor, account: Account) {
  if (account.role !== 'owner' || !await lockWorkspace(db, account.workspaceId)) throw new ForbiddenError();
  await projectPolicy(db, account);
}

export async function createInvitation(owner: Account, email: unknown, role: unknown, projectIds?: unknown) {
  if (owner.role !== 'owner') throw new ForbiddenError();
  const normalized = normalizeEmail(email);
  if (!normalized || (role !== 'editor' && role !== 'viewer')) throw new InvitationError('INVALID_INVITATION');
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID(), createdAt = Date.now(), expiresAt = createdAt + 48 * 3600_000;
  await transaction(async db => {
    await lockOwner(db, owner);
    const grants = await projectScope(db, owner.workspaceId, projectIds);
    await db.run(`UPDATE workspace_invites SET revoked_at=? WHERE workspace_id=? AND email=?
      AND revoked_at IS NULL AND redeemed_at IS NULL`, createdAt, owner.workspaceId, normalized);
    const active = await db.one<{n: number}>(`SELECT COUNT(*) AS n FROM workspace_invites WHERE workspace_id=?
      AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at>?`, owner.workspaceId, createdAt);
    if ((active?.n ?? 0) >= 20) throw new InvitationError('TOO_MANY_INVITES');
    await db.run('INSERT INTO workspace_invites(id,workspace_id,email,role,token_hash,expires_at,created_at,project_ids) VALUES(?,?,?,?,?,?,?,?)',
      id, owner.workspaceId, normalized, role, hash(token), expiresAt, createdAt, grants);
  });
  return { id, token, expiresAt };
}

export async function listInvitations(owner: Account) {
  if (owner.role !== 'owner') throw new ForbiddenError();
  const list = await readTransaction(async db => {
    await projectPolicy(db, owner);
    return db.all<{id: string; email: string; role: string; expiresAt: number; redeemedAt: number | null; revokedAt: number | null; project_ids: string | null}>(
      `SELECT id,email,role,created_at AS "createdAt",expires_at AS "expiresAt",redeemed_at AS "redeemedAt",
      revoked_at AS "revokedAt",project_ids FROM workspace_invites WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100`,
      owner.workspaceId);
  });
  return list.map(({ project_ids, ...item }) => ({
    ...item, projectIds: project_ids === null ? null : JSON.parse(project_ids),
    active: !item.redeemedAt && !item.revokedAt && item.expiresAt > Date.now(),
  }));
}

export async function revokeInvitation(owner: Account, id: string) {
  return transaction(async db => {
    await lockOwner(db, owner);
    return await db.run('UPDATE workspace_invites SET revoked_at=? WHERE workspace_id=? AND id=? AND redeemed_at IS NULL AND revoked_at IS NULL',
      Date.now(), owner.workspaceId, id) === 1;
  });
}

type Invite = { id: string; email: string; workspace_id: string; project_ids: string | null; role: 'editor' | 'viewer' };

export async function acceptInvitation(input: {token: unknown; email: unknown; password: unknown; displayName: unknown; totp?: unknown; recoveryCode?: unknown}) {
  const email = normalizeEmail(input.email);
  const name = safeDisplayLabel(input.displayName);
  const { password, token } = input;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !email || !validatePassword(password) || !name) {
    throw new InvitationError('INVALID_INVITATION');
  }
  const tokenHash = hash(token);
  const capability = {purpose:'invite',email,digest:tokenHash} as const;
  const lookup = async (db: SqlExecutor) => {
    await db.scopeIdentity?.(capability);
    if (db.scopeIdentity) return db.one<Invite>('SELECT id,email,workspace_id,role,project_ids FROM public.projectos_find_invite()');
    return db.one<Invite>(`SELECT id,email,workspace_id,role,project_ids FROM workspace_invites
      WHERE token_hash=? AND email=? AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at>?`, tokenHash, email, Date.now());
  };
  const {invite,existing} = await readTransaction(async db => {
    const invite = await lookup(db);
    return {invite,existing:invite ? await db.one<{id:string}>('SELECT id FROM users WHERE email=?',email) : undefined};
  });
  if (!invite) throw new InvitationError('INVALID_INVITATION');
  if (existing) {
    const quota = await rateLimit('invitation-password', invite.id, 6, 15 * 60_000);
    if (!quota.allowed || await authenticate(email, password) !== existing.id) throw new InvitationError('INVALID_INVITATION');
  }
  const salt = randomBytes(24).toString('hex');
  const digest = existing ? null : await passwordHash(password, salt);
  const result = await transaction(async db => {
    await lockWorkspace(db, invite.workspace_id);
    const current = await lookup(db);
    if (!current) throw new InvitationError('INVALID_INVITATION');
    const projects = current.project_ids === null ? null : JSON.parse(current.project_ids);
    await db.scopeWorkspace?.(current.workspace_id, {role:'invitation',projects});
    const grants = await projectScope(db, current.workspace_id, projects);
    const id = existing?.id ?? randomUUID();
    if (existing) {
      await lockIdentity(db, id);
      if (await accountByUser(id, db)) throw new InvitationError('ACCOUNT_ALREADY_IN_WORKSPACE');
      if (await mfaEnabled(id, db)) {
        const valid = typeof input.recoveryCode === 'string' && input.recoveryCode !== ''
          ? await verifyRecoveryCode(id, input.recoveryCode, db)
          : await verifyMfa(id, input.totp, db);
        if (!valid) return null; // The failed second-factor counter must commit.
      }
    } else {
      const inserted = await db.run(`INSERT INTO users(id,email,display_name,password_hash,salt,created_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(email) DO NOTHING`, id, email, name, digest, salt, new Date().toISOString());
      if (!inserted) throw new InvitationError('INVALID_INVITATION');
    }
    await db.scopeIdentity?.(capability);
    await db.run('INSERT INTO memberships(user_id,workspace_id,role,project_ids) VALUES(?,?,?,?)',
      id, current.workspace_id, current.role, grants);
    await db.run('UPDATE workspace_invites SET redeemed_at=? WHERE id=?', Date.now(), current.id);
    return id;
  });
  if (!result) throw new InvitationError('SECOND_FACTOR_REQUIRED');
  return result;
}

export async function changeMemberScope(owner: Account, memberId: string, projects: unknown) {
  if (projects === undefined) throw new InvitationError('INVALID_PROJECT_GRANT');
  return transaction(async db => {
    await lockOwner(db, owner);
    const grants = await projectScope(db, owner.workspaceId, projects);
    return await db.run("UPDATE memberships SET project_ids=? WHERE workspace_id=? AND user_id=? AND role<>'owner'",
      grants, owner.workspaceId, memberId) === 1;
  });
}

export async function removeMember(owner: Account, memberId: string) {
  if (owner.id === memberId) throw new InvitationError('CANNOT_REMOVE_OWNER');
  return transaction(async db => {
    await lockOwner(db, owner);
    if (db.dialect === 'sqlite') await lockIdentity(db, memberId);
    const row = await db.one<{role: string}>('SELECT role FROM memberships WHERE user_id=? AND workspace_id=?', memberId, owner.workspaceId);
    if (!row || row.role === 'owner') throw new InvitationError('CANNOT_REMOVE_OWNER');
    if (db.dialect === 'sqlite') await db.run('DELETE FROM sessions WHERE user_id=?', memberId);
    return await db.run('DELETE FROM memberships WHERE workspace_id=? AND user_id=?', owner.workspaceId, memberId) === 1;
  });
}
