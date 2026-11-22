import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { validRecordId } from '@/lib/record-contract';
import { hash, rateLimit, readLimitedJson } from '@/lib/server/auth';
import { requireWebRuntime, storedRecord, transaction } from '@/lib/server/db';
import { apiError, jsonError, noStore } from '@/lib/server/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const key = process.env.PROJECTOS_MONITOR_AGENT_TOKEN;
  const workspace = process.env.PROJECTOS_MONITOR_WORKSPACE;
  const approved = new Set((process.env.PROJECTOS_MONITOR_AGENT_RESOURCES ?? '').split(',').map(id=>id.trim()).filter(Boolean));
  if (!key || key.length < 32 || !workspace || !approved.size) return apiError('Agent ingestion not configured',503);
  const credential = request.headers.get('authorization') ?? '';
  if (!timingSafeEqual(Buffer.from(hash(credential),'hex'),Buffer.from(hash('Bearer '+key),'hex'))) return apiError('Unauthenticated',401);
  await requireWebRuntime();
  const limit = await rateLimit('monitor:agent',workspace,120,60_000);
  if (!limit.allowed) return apiError('Try again later',429,{'Retry-After':String(limit.retryAfter)});
  let input: unknown;
  try { input = await readLimitedJson(request,2048); }
  catch (error) { return jsonError(error); }
  const {resourceId,cpuPercent,usedBytes,totalBytes,observedAt,diskUsedBytes,diskTotalBytes} = (input ?? {}) as Record<string,unknown>;
  const stamp = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
  const diskOmitted = diskUsedBytes === undefined && diskTotalBytes === undefined;
  const diskValid = typeof diskUsedBytes === 'number' && typeof diskTotalBytes === 'number'
    && Number.isSafeInteger(diskUsedBytes) && Number.isSafeInteger(diskTotalBytes)
    && diskTotalBytes>0 && diskUsedBytes>=0 && diskUsedBytes<=diskTotalBytes;
  if (!validRecordId(resourceId) || typeof cpuPercent !== 'number' || !Number.isFinite(cpuPercent) || cpuPercent<0 || cpuPercent>100
    || typeof usedBytes!=='number' || typeof totalBytes!=='number' || !Number.isSafeInteger(usedBytes)
    || !Number.isSafeInteger(totalBytes) || totalBytes<1 || usedBytes<0 || usedBytes>totalBytes || !Number.isFinite(stamp)
    || Math.abs(Date.now()-stamp)>120_000 || (!diskOmitted && !diskValid)) return apiError('Invalid observation',422);
  if (!approved.has(resourceId)) return apiError('Not found',404);
  const inserted = await transaction(async db => {
    await db.scopeWorkspace?.(workspace,{role:'agent',projects:[],resources:[resourceId]});
    if (!await storedRecord(db,workspace,'resources',resourceId)) return;
    return db.run(`INSERT INTO machine_observations(workspace_id,resource_id,checked_at,cpu_percent,used_bytes,total_bytes,disk_used_bytes,disk_total_bytes)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,workspace,resourceId,new Date(stamp).toISOString(),cpuPercent,usedBytes,totalBytes,
      diskValid ? diskUsedBytes : null,diskValid ? diskTotalBytes : null);
  });
  if (inserted===undefined) return apiError('Not found',404);
  return NextResponse.json({accepted:inserted===1},{headers:noStore});
}
