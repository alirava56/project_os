#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeDatabase, lockWorkspace, requireWorkerWorkspace, sql, transaction } from './database.mjs';
import { probeDiagnostic, probeHttps } from './monitor-probe.mjs';

const hosts = new Set((process.env.PROJECTOS_MONITOR_HOSTS ?? '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean));
const workspace = process.env.PROJECTOS_MONITOR_WORKSPACE;

async function run() {
  if (!hosts.size || !workspace) throw new Error('Monitoring workspace and HTTPS hosts are required');
  await requireWorkerWorkspace('monitor',workspace);
  const rows = await sql.all("SELECT id,payload FROM records WHERE kind='resources' AND workspace_id=? ORDER BY id", workspace);
  const candidates = rows.filter(row => {
    try { return hosts.has(new URL(JSON.parse(row.payload).address).hostname.toLowerCase()); }
    catch { return false; }
  }).slice(0,100);
  let tested = 0;
  // Limit parallel sockets so one maintenance cycle has predictable resource use.
  for (let offset = 0; offset < candidates.length; offset += 5) {
    await Promise.all(candidates.slice(offset,offset+5).map(async row => {
      const resource = JSON.parse(row.payload);
      let observation, diagnostic='https';
      try { observation = await probeHttps(resource.address, hosts); }
      catch (error) {
        diagnostic=probeDiagnostic(error);
        observation = {state:'unknown', status:null, latency:null, tlsExpiresAt:null};
      }
      const at = new Date().toISOString();
      await transaction(async db => {
        const scope = await lockWorkspace(db, workspace);
        if (!scope) return;
        const current = await db.one("SELECT payload FROM records WHERE workspace_id=? AND kind='resources' AND id=?", workspace, row.id);
        if (!current || JSON.parse(current.payload).address !== resource.address) return;
        await db.run(`INSERT INTO monitor_observations(workspace_id,resource_id,checked_at,state,status_code,latency_ms,diagnostic,source,tls_expires_at)
          VALUES(?,?,?,?,?,?,?,'https',?) ON CONFLICT DO NOTHING`,
        workspace,row.id,at,observation.state,observation.status,observation.latency,diagnostic,observation.tlsExpiresAt);
        tested++;
        const preferences = await db.one("SELECT payload FROM records WHERE workspace_id=? AND kind='preferences' AND id='singleton'", workspace);
        if (!preferences || !JSON.parse(preferences.payload).outage || observation.state !== 'unhealthy') return;
        const id = 'monitor-' + createHash('sha256').update(JSON.stringify([workspace,row.id])).digest('hex').slice(0,28);
        const incident = {id,projectId:JSON.parse(current.payload).projectId,title:'پاسخ ناموفق HTTPS',priority:'high',
          source:'پایش HTTPS · ثبت خودکار',date:at,state:'open'};
        const changed = await db.run(`INSERT INTO records(workspace_id,kind,id,project_id,payload,updated_at,record_version)
          VALUES(?,'incidents',?,?,?,?,?) ON CONFLICT DO NOTHING`,
        workspace,id,incident.projectId,JSON.stringify(incident),at,scope.version+1);
        if (changed) await db.run('UPDATE workspaces SET version=version+1 WHERE id=?',workspace);
      });
    }));
  }
  await sql.run(`INSERT INTO worker_heartbeats(name,checked_at) VALUES('monitors',?)
    ON CONFLICT(name) DO UPDATE SET checked_at=excluded.checked_at`,new Date().toISOString());
  return { tested, loggedAt:new Date().toISOString(), source:'https' };
}

try { console.log(JSON.stringify(await run())); }
catch (error) {
  console.error('Monitor worker failed:',error.code ?? error.name);
  process.exitCode = 1;
} finally { await closeDatabase(); }
