import { randomUUID } from 'node:crypto';
import { sql, transaction } from './database.mjs';
export { configuredChannels } from './notification-providers.mjs';

const leaseMs = 120_000;
const legacyLifetimeMs = 86_400_000;
const maxAttempts = 5;
const reasons = new Set(['rate_limited','provider_unavailable','provider_permission','provider_rejected','outcome_unknown']);

export async function claimDelivery(workspace, channel, now = Date.now()) {
  return transaction(async db => {
    const lock = db.dialect === 'postgres' ? ' FOR UPDATE OF o SKIP LOCKED' : '';
    const old = new Date(now-legacyLifetimeMs).toISOString();
    const expired = '(o.expires_at<=? OR (o.expires_at IS NULL AND o.created_at<=?))';
    const ended = await db.all(`SELECT o.id, r.dispatch_at FROM notification_outbox o
      LEFT JOIN delivery_retries r ON r.notification_id=o.id WHERE o.workspace_id=? AND o.channel=?
      AND ((o.state IN ('pending','retrying') AND ${expired}) OR
        (o.state='sending' AND r.claimed_at<=? AND (r.dispatch_at IS NOT NULL OR r.attempts>=? OR ${expired})))
      ORDER BY o.id LIMIT 100` + lock, workspace, channel, now, old, now-leaseMs, maxAttempts, now, old);
    for (const row of ended) {
      await db.run('UPDATE notification_outbox SET state=? WHERE id=?',row.dispatch_at == null ? 'failed' : 'unknown',row.id);
      await db.run('UPDATE delivery_retries SET lease_token=NULL WHERE notification_id=?',row.id);
    }
    const job = await db.one(`SELECT o.id,o.scheduled_for,o.channel,o.expires_at,o.telegram_title,o.telegram_project,
      COALESCE(r.attempts,0) AS attempts FROM notification_outbox o
      LEFT JOIN delivery_retries r ON r.notification_id=o.id WHERE o.workspace_id=? AND o.channel=?
      AND (o.expires_at>? OR (o.expires_at IS NULL AND o.created_at>?))
      AND COALESCE(r.attempts,0)<? AND COALESCE(r.retry_after,0)<=?
      AND (o.state IN ('pending','retrying') OR (o.state='sending' AND r.dispatch_at IS NULL AND r.claimed_at<=?))
      ORDER BY o.created_at,o.id LIMIT 1` + lock, workspace, channel, now, old, maxAttempts, now, now - leaseMs);
    if (!job) return;
    const lease = randomUUID(), attempts = job.attempts + 1;
    await db.run(`INSERT INTO delivery_retries(notification_id,attempts,retry_after,claimed_at,lease_token) VALUES(?,?,0,?,?)
      ON CONFLICT(notification_id) DO UPDATE SET attempts=excluded.attempts,retry_after=0,
        claimed_at=excluded.claimed_at,lease_token=excluded.lease_token`, job.id, attempts, now, lease);
    await db.run("UPDATE notification_outbox SET state='sending' WHERE id=?", job.id);
    return {...job, lease, attempts};
  });
}

export async function beginDelivery(job, now = Date.now()) {
  return transaction(async db => {
    const lock = db.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const current = await db.one('SELECT state,expires_at,created_at FROM notification_outbox WHERE id=?' + lock,job.id);
    if (current?.state !== 'sending' || (current.expires_at ?? Date.parse(current.created_at)+legacyLifetimeMs)<=now) return false;
    return Boolean(await db.run(`UPDATE delivery_retries SET dispatch_at=? WHERE notification_id=? AND lease_token=?
      AND dispatch_at IS NULL AND claimed_at>?`,now,job.id,job.lease,now-leaseMs));
  });
}

export async function finishDelivery(job, outcome, now = Date.now()) {
  if (outcome === true) outcome = {kind:'accepted'};
  if (outcome === false) outcome = {kind:'retry',reason:'provider_unavailable'};
  if (!['accepted','retry','failed','unknown'].includes(outcome?.kind)) outcome = {kind:'unknown',reason:'outcome_unknown'};
  return transaction(async db => {
    const lock = db.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const current = await db.one('SELECT state,expires_at,created_at FROM notification_outbox WHERE id=?' + lock, job.id);
    if (current?.state !== 'sending') return false;
    const accepted = outcome.kind === 'accepted';
    const retryAt = now + Math.max(15_000 * 2 ** job.attempts, outcome.retryMs ?? 0);
    const retrying = outcome.kind === 'retry' && job.attempts < maxAttempts && retryAt <= now + 3600_000
      && retryAt < (current.expires_at ?? Date.parse(current.created_at)+legacyLifetimeMs);
    const reason = reasons.has(outcome.reason) ? outcome.reason : null;
    const providerId = accepted && typeof outcome.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(outcome.id) ? outcome.id : null;
    const changed = await db.run(`UPDATE delivery_retries SET retry_after=?,lease_token=NULL,dispatch_at=NULL,last_error=?,provider_id=?
      WHERE notification_id=? AND lease_token=? AND dispatch_at IS NOT NULL AND claimed_at>?`, retrying ? Math.ceil(retryAt) : 0,
    accepted ? null : reason,providerId,job.id,job.lease,now-leaseMs);
    if (!changed) return false;
    const state = accepted ? 'delivered' : retrying ? 'retrying' : outcome.kind === 'unknown' ? 'unknown' : 'failed';
    await db.run('UPDATE notification_outbox SET state=?,delivered_at=? WHERE id=?',
      state, accepted ? new Date(now).toISOString() : null, job.id);
    return true;
  });
}

export async function deliverNotifications(workspace, channels, limit = 30, clock = Date.now, signal) {
  if (!workspace) throw new Error('An explicit notification workspace is required');
  if (!await sql.one('SELECT id FROM workspaces WHERE id=?', workspace)) throw new Error('Unknown notification workspace');
  let accepted = 0, failed = 0;
  for (const [channel, send] of Object.entries(channels)) {
    for (let i = 0; i < limit && !signal?.aborted; i++) {
      const job = await claimDelivery(workspace, channel, clock());
      if (!job) break;
      if (!await beginDelivery(job,clock())) continue;
      let outcome;
      try { outcome = await send(job); } catch { outcome = {kind:'unknown',reason:'outcome_unknown'}; }
      if (await finishDelivery(job, outcome, clock())) {
        if (outcome === true || outcome?.kind === 'accepted') accepted++;
        else failed++;
      }
    }
  }
  await sql.run(`INSERT INTO worker_heartbeats(name,checked_at) VALUES(?,?)
    ON CONFLICT(name) DO UPDATE SET checked_at=excluded.checked_at`, 'delivery/' + workspace, new Date(clock()).toISOString());
  return { accepted, failed, status:'provider-accepted-not-user-read' };
}
