import type { SecretReference } from '../types';

export type VaultCheck = {
  status: 'verified' | 'unavailable' | 'permission_denied' | 'not_found' | 'not_configured';
  providerVersion: number | null;
};
export type VaultSettings = { origin:string; token:string; mounts:ReadonlySet<string>; prefixes?:ReadonlySet<string> };

const segment = /^[a-zA-Z0-9_-]{1,128}$/;
const noVersion = (status: VaultCheck['status']): VaultCheck => ({status,providerVersion:null});

export function vaultSettings(workspaceId: string, env = process.env): VaultSettings | undefined {
  const token = env.PROJECTOS_VAULT_TOKEN;
  if (workspaceId !== env.PROJECTOS_VAULT_WORKSPACE || !token
    || !/^[A-Za-z0-9._-]{1,4096}$/.test(token) || !env.PROJECTOS_VAULT_ORIGIN) return;
  try {
    const url = new URL(env.PROJECTOS_VAULT_ORIGIN);
    if (url.protocol !== 'https:' || url.origin !== env.PROJECTOS_VAULT_ORIGIN) return;
    const mounts = new Set((env.PROJECTOS_VAULT_MOUNTS ?? '').split(',').map(mount => mount.trim()).filter(Boolean));
    if (!mounts.size || [...mounts].some(mount => !segment.test(mount))) return;
    const allowed = env.PROJECTOS_VAULT_PREFIXES;
    if (allowed === undefined) return {origin:url.origin,token,mounts};
    const prefixes = new Set(allowed.split(',').map(prefix => prefix.trim()));
    if ([...prefixes].some(prefix => {
      const [mount,...path] = prefix.split('/');
      return !mounts.has(mount) || !path.length || path.some(part => !segment.test(part));
    })) return;
    return {origin:url.origin,token,mounts,prefixes};
  } catch { return; }
}

export function configuredVaultReference(reference: SecretReference, settings?: VaultSettings) {
  const {vaultMount, vaultPath, vaultProvider} = reference;
  return vaultProvider === 'HashiCorp Vault' && Boolean(vaultMount && vaultPath && settings?.mounts.has(vaultMount)
    && segment.test(vaultMount) && vaultPath.length <= 512 && vaultPath.split('/').every(value => segment.test(value))
    && (!settings.prefixes || [...settings.prefixes].some(prefix => (vaultMount + '/' + vaultPath + '/').startsWith(prefix + '/'))));
}

async function readMetadata(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return;
  let bytes = 0, body = '';
  const decoder = new TextDecoder('utf-8', {fatal:true});
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) return JSON.parse(body + decoder.decode()) as {
        data?: {current_version?: unknown; versions?: Record<string, {destroyed?: unknown; deletion_time?: unknown}>};
      };
      bytes += value.length;
      if (bytes > 256 * 1024) { await reader.cancel(); return; }
      body += decoder.decode(value, {stream:true});
    }
  } finally { reader.releaseLock(); }
}

export async function verifyVaultReference(reference: SecretReference, settings?: VaultSettings, request = fetch): Promise<VaultCheck> {
  if (!settings || !configuredVaultReference(reference, settings)) return noVersion('not_configured');
  try {
    const endpoint = new URL('/v1/' + reference.vaultMount + '/metadata/' + reference.vaultPath, settings.origin);
    const response = await request(endpoint, {
      method:'GET', headers:{'X-Vault-Token':settings.token}, redirect:'error', cache:'no-store', signal:AbortSignal.timeout(6000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) return noVersion('not_found');
      if (response.status === 401 || response.status === 403) return noVersion('permission_denied');
      return noVersion('unavailable');
    }
    const body = await readMetadata(response);
    const version = body?.data?.current_version;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || version > 2147483647) {
      return noVersion('unavailable');
    }
    const metadata = body?.data?.versions?.[String(version)];
    if (typeof metadata?.destroyed !== 'boolean' || typeof metadata.deletion_time !== 'string') return noVersion('unavailable');
    if (metadata.destroyed || metadata.deletion_time) return noVersion('not_found');
    return {status:'verified',providerVersion:version};
  } catch {
    return noVersion('unavailable');
  }
}
