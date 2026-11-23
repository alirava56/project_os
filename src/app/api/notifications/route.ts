import { NextRequest, NextResponse } from 'next/server';
import { getCurrentAccount } from '@/lib/server/auth';
import { canSeeProject, projectPolicy, readTransaction, storedRecord } from '@/lib/server/db';
import { recordFailure } from '@/lib/server/record-http';
import { apiError, noStore } from '@/lib/server/http';
import type { Incident } from '@/lib/types';

export const runtime = 'nodejs';

type Delivery = {channel:string; state:string; scheduled_for:string; delivered_at:string | null; retry_after:number | null; last_error:string | null};
const deliveryStates = new Set(['available','pending','sending','retrying','failed','cancelled','unknown']);
const safeReasons = new Set(['rate_limited','provider_unavailable','provider_permission','provider_rejected','outcome_unknown']);
type Heartbeat = {name:string; checked_at:string};

export async function GET(request: NextRequest) {
  const account = await getCurrentAccount();
  if (!account) return apiError('Unauthenticated',401);
  const id = request.nextUrl.searchParams.get('alert');
  if (id === null ? account.role !== 'owner' : !/^(auto|monitor)-[a-f0-9]{28}$/.test(id)) return apiError('Not found',404);
  try {
    const result = await readTransaction(async db => {
      const policy = await projectPolicy(db,account);
      if (id === null) {
        const beats = db.scopeIdentity
          ? await db.all<Heartbeat>('SELECT * FROM public.projectos_notification_health()')
          : await db.all<Heartbeat>(`SELECT substr(name,1,instr(name,'/')-1) AS name,checked_at
            FROM worker_heartbeats WHERE name IN (?,?)`,'reminders/' + account.workspaceId,'delivery/' + account.workspaceId);
        const now = Date.now();
        return {workers:['reminders','delivery'].map(name => {
          const checkedAt = beats.find(beat => beat.name===name)?.checked_at ?? null;
          const age = checkedAt ? now - Date.parse(checkedAt) : -1;
          const status = age < 0 || !Number.isFinite(age) ? 'unobserved' : age <= 15 * 60_000 ? 'recent' : 'stale';
          return {name,status,checkedAt};
        })};
      }
      const row = await storedRecord(db,account.workspaceId,'incidents',id);
      if (!row || !canSeeProject(policy,row.project_id)) return;
      const alert = JSON.parse(row.payload) as Incident;
      if (account.role !== 'owner' && alert.source === 'زمان‌بند داخلی · چرخش اعتبارنامه') return;
      const delivery = db.scopeIdentity
        ? await db.all<Delivery>('SELECT * FROM public.projectos_notification_status(?)',id)
        : await db.all<Delivery>(`SELECT o.channel,o.state,o.scheduled_for,o.delivered_at,
            CASE WHEN o.state='retrying' THEN r.retry_after ELSE NULL END AS retry_after,r.last_error
          FROM notification_outbox o LEFT JOIN delivery_retries r ON r.notification_id=o.id
          WHERE o.workspace_id=? AND ((o.channel='in_app' AND o.id=?)
            OR (o.channel='telegram' AND (o.id=? OR o.id LIKE ?))
            OR (o.channel='email' AND (o.id=? OR o.id LIKE ?))) ORDER BY o.created_at DESC,o.id LIMIT 50`,
        account.workspaceId,id,'tg-' + id,'tg-' + id + '-%','email-' + id,'email-' + id + '-%');
      return {delivery:delivery.map(job => ({
        channel:job.channel,status:job.state === 'delivered' ? 'accepted' : deliveryStates.has(job.state) ? job.state : 'unknown',
        scheduledFor:/^\d{4}-\d{2}-\d{2}(?:T[0-9:.+-]+Z?)?$/.test(job.scheduled_for) && Number.isFinite(Date.parse(job.scheduled_for))
          ? job.scheduled_for : null,
        acceptedAt:job.delivered_at,retryAt:job.retry_after ? new Date(job.retry_after).toISOString() : null,
        reason:job.last_error && safeReasons.has(job.last_error) ? job.last_error : null,
      }))};
    });
    return result ? NextResponse.json(result,{headers:noStore}) : apiError('Not found',404);
  } catch (error) { return recordFailure(error); }
}
