import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function latestHandshake(stdout,now) {
  if (typeof stdout!=='string' || stdout.length>32_768) throw new Error('Invalid handshake output');
  let latest=0;
  for (const line of stdout.trimEnd().split(/\r?\n/)) {
    if (!line) continue;
    const match=/^[A-Za-z0-9+/]{43}=\t([0-9]{1,12})$/.exec(line);
    if (!match || Number(match[1])*1000>now) throw new Error('Invalid handshake row');
    latest=Math.max(latest,Number(match[1]));
  }
  return latest ? new Date(latest*1000).toISOString() : null;
}

export async function wireGuardEvidence(iface,run=promisify(execFile),now=Date.now()) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,31}$/.test(iface)) throw new Error('Invalid configured WireGuard interface');
  try {
    const {stdout}=await run('wg',['show',iface,'latest-handshakes'],{timeout:3500,maxBuffer:32_768,encoding:'utf8',windowsHide:true});
    return {wireguardState:'observed',handshakeAt:latestHandshake(stdout,now)};
  } catch {return {wireguardState:'unavailable',handshakeAt:null};}
}

export async function localTunnelService(configured,request=fetch) {
  if (!configured) return {serviceState:'unconfigured',latencyMs:null};
  const endpoint=new URL(configured);
  if (endpoint.protocol!=='https:' || endpoint.hostname!=='127.0.0.1' || endpoint.pathname!=='/health'
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid VPN health endpoint');
  const start=performance.now();
  try {
    const response=await request(endpoint,{redirect:'error',method:'HEAD',cache:'no-store',signal:AbortSignal.timeout(4500)});
    await response.body?.cancel();
    return response.status===204 ? {serviceState:'ok',latencyMs:Math.min(5000,Math.round(performance.now()-start))}
      : {serviceState:'unexpected',latencyMs:null};
  } catch (error) {
    const code=error.cause?.code ?? error.code ?? '';
    const state=error.name==='TimeoutError'?'timeout':/^(ERR_TLS_|CERT_|DEPTH_|SELF_SIGNED_|UNABLE_TO_)/.test(code)?'tls':'connection';
    return {serviceState:state,latencyMs:null};
  }
}
