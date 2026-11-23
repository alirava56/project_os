/** RFC 6238 SHA-1 TOTP with encrypted-at-rest per-user seeds. Requires independent deployment key. */
import {createHmac, createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual} from 'node:crypto';
import {readTransaction, sql, transaction, type SqlExecutor} from './db';
function key():Buffer {
  const text=process.env.PROJECTOS_MFA_ENCRYPTION_KEY;
  if(!text||!/^[a-f0-9]{64}$/i.test(text))throw new Error('MFA_KEY_NOT_CONFIGURED');
  return Buffer.from(text,'hex');
}
function encrypt(text:string):string {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv);
  cipher.setAAD(Buffer.from('PROJECTOS-MFA-v1'));
  const data=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
  return [iv.toString('hex'),cipher.getAuthTag().toString('hex'),data.toString('hex')].join(':');
}
function decrypt(text:string):string {
  const [iv,tag,data]=text.split(':');
  if(!iv||!tag||!data)throw Error('Corrupted MFA secret');
  const cipher=createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'hex'));
  cipher.setAAD(Buffer.from('PROJECTOS-MFA-v1'));cipher.setAuthTag(Buffer.from(tag,'hex'));
  return Buffer.concat([cipher.update(Buffer.from(data,'hex')),cipher.final()]).toString('utf8');
}
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32(data:Buffer) {
  let bits=0,value=0,out='';
  for(const byte of data){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-=5))&31];}}
  if(bits>0)out+=alphabet[(value<<(5-bits))&31];
  return out;
}
function decode(text:string):Buffer {
  let bits=0,value=0;const bytes:number[]=[];
  for(const c of text){const n=alphabet.indexOf(c);if(n<0)throw Error('Invalid TOTP seed');value=(value<<5)|n;bits+=5;if(bits>=8){bytes.push((value>>>(bits-=8))&255);}}
  return Buffer.from(bytes);
}
export function totp(seed:string,step=Math.floor(Date.now()/30000)):string {
  const buf=Buffer.alloc(8);buf.writeBigUInt64BE(BigInt(step));
  const digest=createHmac('sha1',decode(seed)).update(buf).digest();
  const offset=digest[19]&15;
  return (((digest.readUInt32BE(offset)&0x7fffffff)%1000000).toString()).padStart(6,'0');
}
function matchStep(seed:string,code:unknown,lastStep=-1):number|null {
  if(typeof code!=='string'||!/^[0-9]{6}$/.test(code))return null;
  const step=Math.floor(Date.now()/30000);
  for(let current=step-1;current<=step+1;current++){
    if(current<=lastStep)continue;
    if(timingSafeEqual(Buffer.from(totp(seed,current)),Buffer.from(code)))return current;
  }
  return null;
}
export async function lockIdentity(db: SqlExecutor, userId: string) {
  await db.scopeIdentity?.({purpose:'mfa',userId});
  const lock = db.dialect === 'postgres' ? ' FOR UPDATE' : '';
  return db.one<{id: string}>('SELECT id FROM users WHERE id=?' + lock, userId);
}

export async function mfaEnabled(userId: string, db?: SqlExecutor): Promise<boolean> {
  if (!db) return readTransaction(async connection => {
    await connection.scopeIdentity?.({purpose:'identity',userId});
    return mfaEnabled(userId,connection);
  });
  if (db.scopeIdentity) return (await db.one<{enabled:boolean}>('SELECT public.projectos_mfa_enabled() AS enabled'))?.enabled === true;
  return Boolean(await db.one('SELECT id FROM users WHERE id=? AND mfa_seed IS NOT NULL', userId));
}

export async function beginMfa(userId: string, email: string, session: string | null = null, db = sql):
Promise<{secret:string; provisioningUrl:string}> {
  if (db === sql) return transaction(async connection => {
    await lockIdentity(connection,userId);
    return beginMfa(userId,email,session,connection);
  });
  const seed = b32(randomBytes(20));
  await db.run('UPDATE users SET mfa_pending=?,mfa_pending_until=?,mfa_pending_session=? WHERE id=?',
    encrypt(seed), Date.now() + 10 * 60_000, session, userId);
  return { secret: seed, provisioningUrl: 'otpauth://totp/' + encodeURIComponent('ProjectOS:' + email)
    + '?secret=' + seed + '&issuer=ProjectOS&algorithm=SHA1&digits=6&period=30' };
}

export async function confirmMfa(userId: string, code: unknown, session: string | null = null, db?: SqlExecutor): Promise<boolean> {
  if (!db) return transaction(connection => confirmMfa(userId, code, session, connection));
  await lockIdentity(db, userId);
  type Pending = {pending: string | null; expires: number; binding: string | null};
  const row = db.scopeIdentity
    ? await db.one<Pending>('SELECT pending,expires,binding FROM public.projectos_mfa_material()')
    : await db.one<Pending>('SELECT mfa_pending AS pending,mfa_pending_until AS expires,mfa_pending_session AS binding FROM users WHERE id=?', userId);
  if (!row?.pending || row.expires < Date.now() || row.binding !== session) return false;
  const step = matchStep(decrypt(row.pending), code);
  if (step === null) return false;
  return await db.run('UPDATE users SET mfa_seed=?,mfa_pending=NULL,mfa_pending_until=0,mfa_pending_session=NULL,mfa_last_step=?,mfa_failed=0,mfa_locked_until=0 WHERE id=?',
    row.pending, step, userId) === 1;
}

export async function verifyMfa(userId: string, code: unknown, db?: SqlExecutor): Promise<boolean> {
  if (!db) return transaction(connection => verifyMfa(userId, code, connection));
  await lockIdentity(db, userId);
  type Factor = {seed: string | null; lastStep: number; failed: number; locked: number};
  const row = db.scopeIdentity
    ? await db.one<Factor>('SELECT seed,"lastStep",failed,locked FROM public.projectos_mfa_material()')
    : await db.one<Factor>('SELECT mfa_seed AS seed,mfa_last_step AS "lastStep",mfa_failed AS failed,mfa_locked_until AS locked FROM users WHERE id=?', userId);
  const now = Date.now();
  if (!row?.seed || row.locked > now) return false;
  const step = matchStep(decrypt(row.seed), code, row.lastStep);
  if (step === null) {
    const failed = (row.locked > 0 ? 0 : row.failed) + 1;
    await db.run('UPDATE users SET mfa_failed=?,mfa_locked_until=? WHERE id=?', failed, failed >= 5 ? now + 15 * 60_000 : 0, userId);
    return false;
  }
  return await db.run('UPDATE users SET mfa_last_step=?,mfa_failed=0,mfa_locked_until=0 WHERE id=? AND mfa_last_step<?',
    step, userId, step) === 1;
}

const recoveryHash = (code: string) => createHash('sha256').update(code).digest('hex');

export async function issueRecoveryCodes(userId: string, db?: SqlExecutor): Promise<string[]> {
  if (!db) return transaction(connection => issueRecoveryCodes(userId, connection));
  await lockIdentity(db, userId);
  if (!await mfaEnabled(userId, db)) throw new Error('MFA_NOT_ENABLED');
  const codes = Array.from({length: 10}, () => randomBytes(16).toString('base64url'));
  await db.run('DELETE FROM mfa_recovery_codes WHERE user_id=?', userId);
  const now = new Date().toISOString();
  for (const code of codes) await db.run('INSERT INTO mfa_recovery_codes(user_id,code_hash,created_at) VALUES(?,?,?)',
    userId, recoveryHash(code), now);
  return codes;
}

export async function verifyRecoveryCode(userId: string, code: unknown, db?: SqlExecutor): Promise<boolean> {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(code)) return false;
  if (!db) return transaction(connection => verifyRecoveryCode(userId, code, connection));
  await lockIdentity(db, userId);
  const digest = recoveryHash(code);
  const removed = db.scopeIdentity
    ? (await db.one<{removed:boolean}>('SELECT public.projectos_consume_recovery(?) AS removed',digest))?.removed
    : await db.run('DELETE FROM mfa_recovery_codes WHERE user_id=? AND code_hash=?', userId, digest) === 1;
  if (!removed) return false;
  await db.run('DELETE FROM sessions WHERE user_id=?', userId);
  return true;
}

export async function remainingRecoveryCodes(userId: string) {
  return readTransaction(async db => {
    await db.scopeIdentity?.({purpose:'identity',userId});
    return (await db.one<{n: number}>('SELECT COUNT(user_id) AS n FROM mfa_recovery_codes WHERE user_id=?', userId))?.n ?? 0;
  });
}
