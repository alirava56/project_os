import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentAccount } from '@/lib/server/auth';
import { loadState, projectPolicy, readTransaction } from '@/lib/server/db';
import { apiError, noStore } from '@/lib/server/http';
import { validRecordId } from '@/lib/record-contract';
import { vpnSummary,type VpnObservation } from '@/lib/vpn-observation';
import { sampledAvailability } from '@/lib/slo';
import { machineObservationFresh, type MachineObservation } from '@/lib/monitoring';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const account = await getCurrentAccount();
  if (!account) return apiError('Unauthenticated', 401);
  const {data} = await loadState(account);
  const allowed = new Set(data.resources.map(resource => resource.id));
  const resourceId = request.nextUrl.searchParams.get('resourceId');
  if (resourceId !== null && (!validRecordId(resourceId) || !allowed.has(resourceId))) return apiError('Not found',404);
  const filter = resourceId ? ' AND resource_id=?' : '';
  const params = resourceId ? [account.workspaceId, resourceId] : [account.workspaceId];
  const [rows, machineRows,lifecycle,vpnRows] = await readTransaction(async db => {
    await projectPolicy(db, account);
    const observations = await db.all<{resourceId: string; checkedAt: string; state: string; statusCode: number | null; latencyMs: number | null; source: string; tlsExpiresAt: string | null; diagnostic:string}>(
      `SELECT resource_id AS "resourceId",checked_at AS "checkedAt",state,status_code AS "statusCode",
        latency_ms AS "latencyMs",source,diagnostic,tls_expires_at AS "tlsExpiresAt"
        FROM monitor_observations WHERE workspace_id=?` + filter + ' ORDER BY checked_at DESC LIMIT 200',...params);
    const machine = await db.all<Omit<MachineObservation,'source'|'state'>>(
      `SELECT resource_id AS "resourceId",checked_at AS "checkedAt",cpu_percent AS "cpuPercent",
        used_bytes AS "usedBytes",total_bytes AS "totalBytes",
        disk_used_bytes AS "diskUsedBytes",disk_total_bytes AS "diskTotalBytes"
        FROM machine_observations WHERE workspace_id=?` + filter + ' ORDER BY checked_at DESC LIMIT 200',...params);
    const stages=db.scopeIdentity ? await db.all<{resourceId:string;state:string;lastChecked:string}>('SELECT * FROM public.projectos_slo_status()') : [];
    const vpn=db.scopeIdentity ? await db.all<VpnObservation>(`SELECT resource_id AS "resourceId",checked_at AS "checkedAt",
      handshake_at AS "handshakeAt",wireguard_state AS "wireguardState",service_state AS "serviceState",latency_ms AS "latencyMs"
      FROM vpn_observations WHERE workspace_id=?`+filter+' ORDER BY checked_at DESC LIMIT 400',...params) : [];
    return [observations,machine,stages,vpn] as const;
  });
  const now = Date.now();
  const freshnessWindowMinutes = 15;
  const observations = rows.filter(row => allowed.has(row.resourceId)).map(row => {
    const age = now - Date.parse(row.checkedAt);
    const state = Number.isFinite(age) && age >= -60_000 && age <= freshnessWindowMinutes * 60_000 ? row.state : 'stale';
    const diagnostic=['dns','timeout','tls','connection','unavailable'].includes(row.diagnostic) ? row.diagnostic : null;
    return {...row, diagnostic, state, recordedState: row.state};
  });
  const machineObservations = machineRows.filter(row => allowed.has(row.resourceId)).map(row => {
    return {...row,source:'machine-agent',state:machineObservationFresh(row.checkedAt,now)?'observed':'stale'};
  });
  const status = observations.length || machineObservations.length || process.env.PROJECTOS_MONITOR_HOSTS ? 'configured' : 'not_configured';
  const availability = sampledAvailability(observations.map(row=>({...row,state:row.recordedState})),now);
  return NextResponse.json({ observations, machineObservations, status, freshnessWindowMinutes, availability,vpn:vpnSummary(vpnRows.filter(row=>allowed.has(row.resourceId)),now),lifecycle:lifecycle.filter(item=>allowed.has(item.resourceId) && (!resourceId || item.resourceId===resourceId)) }, { headers: noStore });
}
