import { NextRequest, NextResponse } from 'next/server';
import { readJsonBytes } from '@/lib/server/auth';
import { requireWebRuntime, storedRecord, transaction } from '@/lib/server/db';
import { deliveryDigest, githubBindings, signedDelivery } from '@/lib/server/github';
import { apiError, jsonError, noStore } from '@/lib/server/http';

export const runtime = 'nodejs';

const events = new Set(['issues','release','deployment_status','push']);

export async function POST(request: NextRequest) {
  const key = process.env.PROJECTOS_GITHUB_WEBHOOK_SECRET;
  if (!key) return apiError('GitHub webhook is not configured', 503);
  const deliveryId = request.headers.get('x-github-delivery') ?? '';
  const event = request.headers.get('x-github-event') ?? '';
  if (!/^[a-f0-9-]{20,64}$/i.test(deliveryId) || !events.has(event)) return apiError('Invalid delivery metadata', 400);
  let raw: Buffer;
  try { raw = await readJsonBytes(request, 512_000); }
  catch (error) { return jsonError(error); }
  if (!signedDelivery(raw, request.headers.get('x-hub-signature-256'), key)) return apiError('Signature rejected', 401);
  await requireWebRuntime();
  let repository: unknown;
  try { repository = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw))?.repository?.full_name; }
  catch { return apiError('Invalid JSON', 400); }
  const matches = typeof repository === 'string' ? githubBindings().filter(binding => binding.repository === repository.toLowerCase()) : [];
  if (!matches.length) return apiError('Repository is out of scope', 404);
  const digest = deliveryDigest(raw);
  let accepted = 0;
  for (const binding of matches) {
    accepted += await transaction(async db => {
      await db.scopeWorkspace?.(binding.workspaceId,{role:'github',projects:[binding.projectId],repository:binding.repository});
      if (db.scopeIdentity) {
        const accepted = await db.one<{recorded:boolean}>('SELECT public.projectos_record_github_delivery(?,?,?) AS recorded',
          deliveryId,digest,event);
        return Number(accepted?.recorded === true);
      }
      if (!await storedRecord(db, binding.workspaceId, 'projects', binding.projectId)) return 0;
      const at = new Date().toISOString();
      const inserted = await db.run(`INSERT INTO github_deliveries(workspace_id,project_id,repo,delivery_id,payload_hash,event_type,received_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, binding.workspaceId, binding.projectId, binding.repository,
      deliveryId, digest, event, at);
      if (inserted) await db.run(`INSERT INTO github_snapshots(workspace_id,project_id,repo,checked_at,status,payload) VALUES(?,?,?,?,'pending_refresh',?)
        ON CONFLICT(workspace_id,project_id,repo) DO UPDATE SET checked_at=excluded.checked_at,status=excluded.status
        WHERE github_snapshots.checked_at<=excluded.checked_at`, binding.workspaceId, binding.projectId,binding.repository,
      at, JSON.stringify({repository:binding.repository, state:'pending_refresh', checkedAt:null}));
      return inserted;
    });
  }
  return NextResponse.json({ accepted }, {headers:noStore});
}
