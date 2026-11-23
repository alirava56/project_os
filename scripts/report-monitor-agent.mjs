#!/usr/bin/env node
import { cpus, freemem, totalmem } from 'node:os';
import { statfs } from 'node:fs/promises';
import { localTunnelService,wireGuardEvidence } from './vpn-evidence.mjs';
import { setTimeout } from 'node:timers/promises';

function captureCpu() {
  let idle = 0, total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((a,b)=>a+b,0);
  }
  return { idle, total };
}

async function captureDisk(path) {
  if (!path) return {};
  try {
    const {blocks,bsize,bfree}=await statfs(path,{bigint:true});
    const total=blocks*bsize, used=(blocks-bfree)*bsize;
    if (total > BigInt(Number.MAX_SAFE_INTEGER) || total<=0n || used<0n || used>total) return {};
    return {diskTotalBytes:Number(total),diskUsedBytes:Number(used)};
  } catch {
    return {};
  }
}
try {
  const endpoint = new URL(process.env.PROJECTOS_AGENT_TARGET);
  const token = process.env.PROJECTOS_MONITOR_AGENT_TOKEN;
  const resourceId = process.env.PROJECTOS_AGENT_RESOURCE_ID;
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search
    || endpoint.pathname !== '/api/monitoring/observations' || !token || !resourceId) throw new Error('Invalid agent configuration');
  const before = captureCpu();
  await setTimeout(1000);
  const after = captureCpu();
  const elapsed = after.total - before.total;
  if (elapsed <= 0) throw new Error('CPU sample unavailable');
  const cpuPercent = Math.max(0,Math.min(100,(1-(after.idle-before.idle)/elapsed)*100));
  const totalBytes = totalmem();
  const disk=await captureDisk(process.env.PROJECTOS_AGENT_DISK_PATH);
  const iface=process.env.PROJECTOS_AGENT_WIREGUARD_INTERFACE;
  const vpn=iface ? {...await wireGuardEvidence(iface),...await localTunnelService(process.env.PROJECTOS_AGENT_VPN_HEALTH_URL)} : undefined;
  const result = await fetch(endpoint,{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(7000),
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({ resourceId,cpuPercent,totalBytes,usedBytes:totalBytes-freemem(),...disk,vpn,observedAt:new Date().toISOString() }),
  });
  if (!result.ok) throw new Error('Observation rejected');
  console.log('Authenticated machine observation submitted');
} catch {
  console.error('Machine observation could not be submitted');
  process.exitCode=1;
}
