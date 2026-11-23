import { createHash } from 'node:crypto';
import { lockWorkspace, sql, transaction } from './database.mjs';
import { localInstant, wallClock } from '../src/lib/reminder-time.ts';
import { safeLabel } from './notification-providers.mjs';

const dayMs = 86400_000;
const utcDay = date => Date.parse(date + 'T00:00:00Z');
const dayString = ms => new Date(ms).toISOString().slice(0, 10);
const dateAt = (zone, date) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);
export const reminderAlertId = (workspace, kind, id, due, source) => 'auto-' + createHash('sha256')
  .update([workspace, kind, id, due, ...(source ? [source] : [])].join('|')).digest('hex').slice(0, 28);

export async function retireReminderAlert(db, workspace, id) {
  const removed = await db.run("DELETE FROM records WHERE workspace_id=? AND kind='incidents' AND id=?", workspace, id);
  await db.run(`UPDATE notification_outbox SET state='cancelled' WHERE workspace_id=?
    AND (id=? OR id=? OR id=? OR id LIKE ? OR id LIKE ?) AND state IN ('pending','retrying','sending','available')`,
  workspace, id, 'tg-' + id, 'email-' + id, 'tg-' + id + '-%', 'email-' + id + '-%');
  return removed;
}

function dueDate(value, zone) {
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateAt(zone, date) : null;
}

function monthDate(anchor, months) {
  const [year, month, day] = anchor.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1 + months + 1, 0);
  date.setUTCDate(Math.min(day, date.getUTCDate()));
  return date.toISOString().slice(0, 10);
}

export function occurrences(value, repeat, zone, lowest, highest) {
  const anchor = dueDate(value, zone);
  if (!anchor) return [];
  if (!repeat || repeat === 'none') return [value];
  const start = utcDay(anchor);
  const low = utcDay(lowest), high = utcDay(highest);
  if (start > high) return [];
  const found = [];
  if (repeat === 'daily' || repeat === 'weekly') {
    const step = dayMs * (repeat === 'daily' ? 1 : 7);
    const first = start + Math.max(0, Math.ceil((low - start) / step)) * step;
    for (let at = first; at <= high; at += step) found.push(dayString(at));
    return found;
  }
  const step = {monthly: 1, quarterly: 3, yearly: 12}[repeat];
  if (!step) return [];
  const a = new Date(start), b = new Date(low);
  const elapsed = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
  for (let index = Math.max(0, Math.floor(elapsed / step)); ; index++) {
    const date = monthDate(anchor, index * step);
    if (date > highest) break;
    if (date >= lowest) found.push(date);
  }
  return found;
}

async function enqueue(db, workspace, channels, alertId, ref, scheduled, timestamp, expiresAt, slot = 0, details = {}) {
  let queued = 0;
  for (const channel of channels) {
    const prefix = channel === 'telegram' ? 'tg-' : 'email-';
    const id = prefix + alertId + (slot ? '-' + slot : '');
    const perOccurrence = slot ? ref + ':' + alertId + ':' + slot : ref;
    const title = channel === 'telegram' ? safeLabel(details.title) || null : null;
    const project = channel === 'telegram' ? safeLabel(details.project) || null : null;
    const result = await db.run(`INSERT INTO notification_outbox(id,workspace_id,reminder_id,scheduled_for,channel,state,created_at,
      expires_at,telegram_title,telegram_project) VALUES(?,?,?,?,?,'pending',?,?,?,?) ON CONFLICT DO NOTHING`,
    id, workspace, perOccurrence, scheduled, channel, timestamp, expiresAt, title, project);
    queued += result || await db.run(`UPDATE notification_outbox SET state='pending',expires_at=?,telegram_title=?,telegram_project=?
      WHERE id=? AND state='cancelled' AND NOT EXISTS (
        SELECT 1 FROM delivery_retries dr WHERE dr.notification_id=notification_outbox.id AND (dr.attempts>=5 OR dr.dispatch_at IS NOT NULL))`,
    expiresAt, title, project, id);
  }
  return queued;
}

function activeCandidates(parsed, preferences, timestamp, horizon) {
  const currentZone = preferences.zone ?? 'Asia/Tehran';
  const info = [];
  for (const item of parsed) {
    const { kind, id, value } = item;
    const noticeDays = Number.isSafeInteger(value.noticeDays) && value.noticeDays >= 0 && value.noticeDays <= 60
      ? value.noticeDays : undefined;
    let draft;
    if (kind === 'reminders' && !value.paused) draft = {kind:value.kind, name:value.title,
      anchor:value.due, repeat:value.repeat, zone:value.zone ?? currentZone};
    if (kind === 'tasks' && value.status !== 'done' && noticeDays !== undefined) draft = {
      kind:'یادآوری', name:'موعد وظیفه ' + value.title, anchor:value.due, zone:currentZone,
    };
    if (kind === 'charges' && value.status === 'active') draft = {
      kind:'تمدید', name:'اشتراک ' + value.title, anchor:value.nextDue, repeat:value.period, zone:currentZone,
    };
    if (kind === 'resources' && value.expires) draft = {kind:'تمدید', name:'تمدید ' + value.name, anchor:value.expires, zone:currentZone};
    if (kind === 'contracts' && value.state === 'active') draft = {kind:'تمدید', name:'پایان قرارداد ' + value.title, anchor:value.end, zone:currentZone};
    if (kind === 'secrets' && value.rotationDue) draft = {kind:'تمدید', name:'چرخش اعتبارنامه', anchor:value.rotationDue, zone:currentZone};
    if (!draft || (draft.kind === 'تمدید' && preferences.renewal === false)) continue;
    const today = dateAt(draft.zone, timestamp);
    const low = dayString(utcDay(today) - 3 * dayMs);
    const high = dayString(utcDay(today) + (noticeDays ?? horizon) * dayMs);
    for (let due of occurrences(draft.anchor, draft.repeat, draft.zone, low, high)) {
      const localDue = dueDate(due, draft.zone);
      if (!localDue || (noticeDays !== undefined && localDue > high)) continue;
      // The anchor can have a historic UTC instant; keep its established identity.
      if (due === dueDate(draft.anchor, draft.zone)) due = draft.anchor;
      else if (due !== draft.anchor && draft.anchor.includes('T')) {
        const time = wallClock(draft.zone,new Date(draft.anchor)).slice(11);
        due = new Date(localInstant(due + 'T' + time,draft.zone)).toISOString();
      }
      info.push({ ...draft, id, due, projectId: value.projectId, source:kind, today, noticeDays });
    }
  }
  return info;
}

export async function reconcileReminders({ clock = new Date(), channels = [], notificationWorkspace, telegramDetails = false, offsets = [14, 7, 3, 1, 0] } = {}) {
  const timing = new Set(offsets);
  const horizon = Math.max(3, ...offsets);
  const totals = { generated:0, resumed:0, retired:0, queuedTelegram:0, queuedEmail:0, cancelledTelegram:0, ambiguousLegacy:0 };
  const workspaces = await sql.all('SELECT id FROM workspaces ORDER BY id');
  const timestamp = clock.toISOString();
  for (const {id:workspace} of workspaces) {
    const targets = workspace === notificationWorkspace ? channels : [];
    await transaction(async db => {
      const current = await lockWorkspace(db, workspace);
      if (!current) return;
      const version = current.version + 1;
      const rows = await db.all(`SELECT id,kind,payload FROM records WHERE workspace_id=?
        AND kind IN ('reminders','tasks','charges','resources','contracts','preferences','incidents','secrets')`, workspace);
      const restricted = db.dialect === 'postgres' && (await db.one('SELECT public.projectos_reminder_workspace() AS scope'))?.scope === workspace;
      if (restricted) rows.push(...await db.all("SELECT id,'secrets' AS kind,payload FROM public.projectos_rotation_deadlines()"));
      const projectNames = new Map();
      if (telegramDetails && targets.includes('telegram')) {
        const projects = restricted ? await db.all('SELECT id,name FROM public.projectos_reminder_project_names()')
          : (await db.all("SELECT id,payload FROM records WHERE workspace_id=? AND kind='projects'",workspace))
            .map(row => ({id:row.id,name:JSON.parse(row.payload).name}));
        for (const project of projects) projectNames.set(project.id,project.name);
      }
      const parsed = rows
        .map(row => ({...row, value:JSON.parse(row.payload)}));
      const currentIncidents = parsed.filter(row => row.kind === 'incidents');
      const incidents = new Map(currentIncidents.map(row => [row.id, row.value]));
      const preferences = parsed.find(row => row.kind === 'preferences')?.value ?? {};
      const candidates = activeCandidates(parsed, preferences, clock, horizon);
      const outbox = new Map((await db.all('SELECT id,reminder_id,created_at,state FROM notification_outbox WHERE workspace_id=?', workspace))
        .map(row => [row.id, row]));
      const groups = new Map();
      for (const candidate of candidates) {
        const legacy = reminderAlertId(workspace, candidate.kind, candidate.id, candidate.due);
        const group = groups.get(legacy) ?? [];
        group.push(candidate);
        groups.set(legacy, group);
      }
      const active = new Set(), schedules = [];
      for (const [legacy, group] of groups) {
        const incident = incidents.get(legacy);
        const reference = (outbox.get(legacy) ?? outbox.get('tg-' + legacy))?.reminder_id;
        const match = group.filter(row => reference === row.source + ':' + row.id
          || incident?.title === row.name + ' · ' + dueDate(row.due, row.zone));
        if ((incident || reference) && match.length !== 1) {
          active.add(legacy);
          for (const row of group) active.add(reminderAlertId(workspace, row.kind, row.id, row.due, row.source));
          totals.ambiguousLegacy++;
          continue;
        }
        for (const row of group) {
          const scoped = reminderAlertId(workspace, row.kind, row.id, row.due, row.source);
          const legacyOwner = row === match[0] && !incidents.has(scoped) && !outbox.has(scoped) && !outbox.has('tg-' + scoped);
          const id = legacyOwner ? legacy : scoped;
          active.add(id);
          schedules.push({ ...row, alertId:id, ref:legacyOwner ? reference ?? row.id : row.source + ':' + row.id });
        }
      }
      let changes = 0, openCount = 0;
      for (const row of currentIncidents) {
        if (row.id.startsWith('auto-') && !active.has(row.id)) {
          await retireReminderAlert(db, workspace, row.id);
          totals.retired++;
          changes++;
        } else if (row.value.state === 'snoozed' && row.value.snoozedUntil
          && Date.parse(row.value.snoozedUntil) <= clock.getTime()) {
          row.value.state = 'open';
          delete row.value.snoozedUntil;
          await db.run(`UPDATE records SET payload=?,updated_at=?,record_version=? WHERE workspace_id=? AND kind='incidents' AND id=?`,
            JSON.stringify(row.value), timestamp, version, workspace, row.id);
          totals.resumed++;
          changes++;
        }
      }
      for (const channel of ['telegram', 'email']) {
        if (targets.includes(channel)) continue;
        const n = await db.run(`UPDATE notification_outbox SET state='cancelled' WHERE workspace_id=? AND channel=?
          AND state IN ('pending','retrying','sending')`, workspace, channel);
        if (channel === 'telegram') totals.cancelledTelegram += n;
      }
      for (const row of schedules) {
        const localDue = dueDate(row.due, row.zone);
        if (!localDue) continue;
        const diff = Math.round((utcDay(localDue) - utcDay(row.today)) / dayMs);
        const lead = row.noticeDays ?? (row.kind === 'تمدید' ? horizon : row.repeat && row.repeat !== 'none' ? 0 : 3);
        if (diff < -3 || diff > lead || (diff === 0 && lead === 0 && row.due.includes('T') && Date.parse(row.due)>clock.getTime())) continue;
        let incident = incidents.get(row.alertId);
        if (!incident) {
          incident = { id:row.alertId, title:row.name + ' · ' + localDue, projectId:row.projectId,
            priority:diff<=3?'high':'medium',
            source:row.source==='secrets'?'زمان‌بند داخلی · چرخش اعتبارنامه':'زمان‌بند داخلی · ثبت خودکار',
            date:row.today, state:'open' };
          const created = await db.run(`INSERT INTO records(workspace_id,kind,id,project_id,payload,updated_at,record_version)
            VALUES(?,'incidents',?,?,?,?,?) ON CONFLICT DO NOTHING`,
          workspace, incident.id, row.projectId, JSON.stringify(incident), timestamp, version);
          totals.generated += created;
          changes += created;
        }
        await db.run(`INSERT INTO notification_outbox(id,workspace_id,reminder_id,scheduled_for,channel,state,created_at)
          VALUES(?,?,?,?,'in_app','available',?) ON CONFLICT(id) DO UPDATE SET state='available'
          WHERE notification_outbox.state='cancelled'`,
        incident.id, workspace, row.ref, row.due, timestamp);
        if (incident.state !== 'open') continue;
        openCount++;
        if (diff < 0 || (diff === 0 && row.due.includes('T') && Date.parse(row.due)>clock.getTime())) continue;
        const expiry = localInstant(dayString(utcDay(row.today)+dayMs) + 'T00:00:00',row.zone);
        const details = telegramDetails && row.source !== 'secrets' ? {title:row.name,project:projectNames.get(row.projectId)} : {};
        for (const channel of targets) {
          const first = outbox.get((channel === 'telegram' ? 'tg-' : 'email-') + incident.id);
          const scheduled = row.noticeDays === undefined && (row.kind === 'تمدید' ? timing.has(diff) : diff === 0);
          if (first && first.state !== 'cancelled' && !scheduled) continue;
          const priorDay = first && dateAt(row.zone, new Date(first.created_at)) !== row.today;
          const slot = priorDay && scheduled && first.state !== 'cancelled' ? diff || 'due' : 0;
          const queued = await enqueue(db, workspace, [channel], incident.id, row.ref, row.due, timestamp, expiry, slot, details);
          if (channel === 'telegram') totals.queuedTelegram += queued;
          if (channel === 'email') totals.queuedEmail += queued;
        }
      }
      if (preferences.digest && openCount) {
        const today = dateAt(preferences.zone ?? 'Asia/Tehran', clock);
        const digestId = reminderAlertId(workspace, 'digest', 'daily', today);
        await enqueue(db, workspace, targets, digestId, 'digest:' + today, today, timestamp,
          localInstant(dayString(utcDay(today)+dayMs) + 'T00:00:00',preferences.zone ?? 'Asia/Tehran'));
      }
      if (changes) await db.run('UPDATE workspaces SET version=? WHERE id=?', version, workspace);
    });
  }
  for (const workspace of workspaces) await sql.run(`INSERT INTO worker_heartbeats(name,checked_at) VALUES(?,?)
    ON CONFLICT(name) DO UPDATE SET checked_at=excluded.checked_at`, 'reminders/' + workspace.id, timestamp);
  return { ...totals, ranAt: timestamp, channel: 'in_app' };
}
