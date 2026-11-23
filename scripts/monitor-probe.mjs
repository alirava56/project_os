import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

export function publicIPv4(ip) {
  if (isIP(ip) !== 4) return false;
  const [a,b,c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 2 || b === 168 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}
function validHost(host) {
  return host.length <= 253 && !host.endsWith('.') && !host.includes('..') && !isIP(host)
    && !/(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host)
    && /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && host.includes('.');
}

export function probeDiagnostic(error) {
  const code=typeof error?.code==='string'?error.code:'';
  if (['ENOTFOUND','EAI_AGAIN','ENODATA'].includes(code)) return 'dns';
  if (['ABORT_ERR','ETIMEDOUT','MONITOR_TIMEOUT'].includes(code)) return 'timeout';
  if (/^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_|UNABLE_TO_|SELF_SIGNED_)/.test(code)) return 'tls';
  if (['ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH'].includes(code)) return 'connection';
  return 'unavailable';
}

export async function probeHttps(address, allowlist, { resolve = lookup, connect = request } = {}) {
  const target = new URL(address);
  if (target.protocol !== 'https:' || target.username || target.password || target.port || target.search || target.hash
    || target.pathname !== '/' || !validHost(target.hostname) || !allowlist.has(target.hostname)) {
    throw new Error('Monitor endpoint not explicitly permitted');
  }
  const records = await resolve(target.hostname, { family:4, all:true });
  if (!records.length || records.some(record => !publicIPv4(record.address))) throw new Error('Public DNS verification failed');
  const pinned = records[0].address;
  const start = performance.now();
  return new Promise((done, fail) => {
    const req = connect(target, {
      method:'HEAD', timeout:7000, signal:AbortSignal.timeout(10000), maxHeaderSize:8192,
      family:4, autoSelectFamily:false, agent:false,
      lookup:(_hostname, opts, callback) => opts.all ? callback(null,[{address:pinned,family:4}]) : callback(null,pinned,4),
    }, response => {
      const status = response.statusCode ?? 0;
      // The pinned origin alone was observed. Never follow or mark a redirect as healthy.
      const state = status >= 200 && status < 300 ? 'healthy' : status >= 400 ? 'unhealthy' : 'unknown';
      const certificate = response.socket?.getPeerCertificate?.().valid_to;
      const expiry = certificate ? Date.parse(certificate) : NaN;
      response.once('error', fail);
      response.once('end', () => done({
        state, status, latency:Math.round(performance.now()-start),
        tlsExpiresAt:Number.isFinite(expiry) ? new Date(expiry).toISOString() : null,
      }));
      response.resume();
    });
    req.once('timeout', () => req.destroy(Object.assign(new Error('HTTPS timed out'),{code:'MONITOR_TIMEOUT'})));
    req.once('error', fail);
    req.end();
  });
}