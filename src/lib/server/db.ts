import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getDb, lockWorkspace, readTransaction, sql, transaction, type SqlExecutor } from '../../../scripts/database.mjs';
import { reminderAlertId, retireReminderAlert } from '../../../scripts/reminder-scheduler.mjs';
import { emptyData } from '../empty-data';
import { normalized } from '../format';
import { allocationId } from '../shared-cost';
import { isRecordKind, recordKinds, type RecordKind, type WorkspaceRecord } from '../record-contract';
import type { ActivityEvent, DemoData, Invoice, Payment, Preferences, Resource } from '../types';
import { redactStoredValue, redactCredentials } from './credential-guard';
import { ValidationError, type CanonicalState } from './validation';

export { getDb, lockWorkspace, readTransaction, sql, transaction, type SqlExecutor };
export { requireWebRuntime } from '../../../scripts/database.mjs';
export interface Account {
  id: string;
  email: string;
  displayName: string;
  workspaceId: string;
  role: 'owner' | 'editor' | 'viewer';
}
export interface ProjectPolicy {
  projectIds: ReadonlySet<string> | null;
}
export interface RecordRow {
  kind: RecordKind | 'preferences';
  id: string;
  project_id: string | null;
  payload: string;
  record_version: number;
}
export interface PreparedChange {
  kind: RecordKind;
  id: string;
  previous?: RecordRow;
  record?: WorkspaceRecord;
}
export class VersionConflictError extends Error {
  constructor() { super('The record has changed. Refresh and retry.'); }
}
export class ForbiddenError extends Error {
  constructor() { super('Insufficient workspace permission'); }
}

export async function userCount() {
  if (sql.dialect === 'postgres') return (await sql.one<{open: boolean}>('SELECT public.projectos_setup_open() AS open'))?.open ? 0 : 1;
  return (await sql.one<{n: number}>('SELECT COUNT(*) AS n FROM users'))?.n ?? 0;
}

export async function accountByUser(userId: string, db?: SqlExecutor): Promise<Account | null> {
  if (!db) return readTransaction(async connection => {
    await connection.scopeIdentity?.({purpose:'identity', userId});
    return accountByUser(userId, connection);
  });
  return await db.one<Account>(`SELECT u.id,u.email,u.display_name AS "displayName",
    m.workspace_id AS "workspaceId",m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=?`,
  userId) ?? null;
}

export async function projectPolicy(db: SqlExecutor, account: Account): Promise<ProjectPolicy> {
  if (db === sql) return readTransaction(connection => projectPolicy(connection, account));
  await db.scopeIdentity?.({purpose:'identity',userId:account.id});
  const member = await db.one<{role: Account['role']; project_ids: string | null}>(
    'SELECT role,project_ids FROM memberships WHERE workspace_id=? AND user_id=?',
    account.workspaceId, account.id,
  );
  if (!member || member.role !== account.role) throw new ForbiddenError();
  if (member.role === 'owner' || member.project_ids === null) {
    await db.scopeWorkspace?.(account.workspaceId,{role:member.role,projects:null,actor:account.id});
    return { projectIds: null };
  }
  const grants: unknown = JSON.parse(member.project_ids);
  if (!Array.isArray(grants) || grants.some(id => typeof id !== 'string')) throw new ForbiddenError();
  await db.scopeWorkspace?.(account.workspaceId,{role:member.role,projects:grants,actor:account.id});
  return { projectIds: new Set<string>(grants) };
}

export function canSeeProject(policy: ProjectPolicy, projectId: string | null | undefined) {
  return policy.projectIds === null || (typeof projectId === 'string' && policy.projectIds.has(projectId));
}

export function recordReadTable(db: SqlExecutor) {
  return db.scopeIdentity ? 'public.projectos_records' : 'records';
}

export function storedRecord(db: SqlExecutor, workspaceId: string, kind: RecordRow['kind'], id: string) {
  return db.one<RecordRow>(
    `SELECT kind,id,project_id,payload,record_version FROM ${recordReadTable(db)} WHERE workspace_id=? AND kind=? AND id=?`,
    workspaceId, kind, id,
  );
}

function redactRecord(row: RecordRow): WorkspaceRecord {
  return redactStoredValue(JSON.parse(row.payload)) as WorkspaceRecord;
}

async function projectRecord(
  db: SqlExecutor, account: Account, policy: ProjectPolicy, row: RecordRow,
): Promise<WorkspaceRecord | undefined> {
  if (!isRecordKind(row.kind) || (row.kind === 'secrets' && account.role !== 'owner')) return;
  const record = redactRecord(row);
  if (row.kind === 'incidents' && account.role !== 'owner'
    && (record as DemoData['incidents'][number]).source === 'زمان‌بند داخلی · چرخش اعتبارنامه') return;
  if (policy.projectIds === null) return record;
  if (row.kind === 'resources') {
    const resource = record as DemoData['resources'][number];
    const accessibleProjects = [resource.projectId, ...(resource.linkedProjectIds ?? [])]
      .filter(id => canSeeProject(policy, id));
    if (!accessibleProjects.length) return;
    const [projectId, ...linkedProjectIds] = accessibleProjects;
    const parent = resource.parentId
      ? await storedRecord(db, account.workspaceId, 'resources', resource.parentId)
      : undefined;
    const visibleParent = parent && (canSeeProject(policy, parent.project_id)
      || ((JSON.parse(parent.payload).linkedProjectIds ?? []) as string[]).some(id => canSeeProject(policy, id)));
    return { ...resource, projectId, linkedProjectIds, parentId: visibleParent ? resource.parentId : undefined };
  }
  if (!canSeeProject(policy, row.project_id)) return;
  if (row.kind === 'tasks') {
    const task = record as DemoData['tasks'][number];
    const dependencies = await Promise.all(task.dependencies.map(async id => {
      const dependency = await storedRecord(db, account.workspaceId, 'tasks', id);
      return dependency && canSeeProject(policy, dependency.project_id) ? id : undefined;
    }));
    return { ...task, dependencies: dependencies.filter(id => id !== undefined) };
  }
  if (row.kind === 'charges') {
    const charge = record as DemoData['charges'][number];
    const resource = charge.linkedResourceId
      ? await storedRecord(db, account.workspaceId, 'resources', charge.linkedResourceId)
      : undefined;
    if (resource && await projectRecord(db, account, policy, resource)) return charge;
    return { ...charge, linkedResourceId: undefined };
  }
  return record;
}

export async function loadRecord(account: Account, kind: RecordKind, id: string) {
  return readTransaction(async db => {
    const policy = await projectPolicy(db, account);
    const row = await storedRecord(db, account.workspaceId, kind, id);
    if (!row) return;
    const record = await projectRecord(db, account, policy, row);
    if (!record) return;
    const workspace = await db.one<{version: number}>('SELECT version FROM workspaces WHERE id=?', account.workspaceId);
    if (!workspace) throw new ForbiddenError();
    return { record, version: workspace.version, recordVersion: row.record_version };
  });
}

const eventSources: Record<string, string> = {
  projects: 'پروژه‌ها', tasks: 'وظایف', resources: 'زیرساخت', docs: 'مستندات',
  reminders: 'تقویم', incidents: 'هشدارها', secrets: 'خزانه', expenses: 'مالی',
  charges: 'اشتراک‌ها', contracts: 'قراردادها', revenues: 'درآمد',
  invoices: 'فاکتورها', payments: 'پرداخت‌ها',
  exchangeRates: 'نرخ تبدیل ارز',
  manual: 'ثبت دستی',
};
type EventRow = Pick<ActivityEvent, 'id' | 'title' | 'projectId' | 'date'> & {
  kind: string; action: string; actorSnapshot: string; fallbackActor: string | null;
};
const eventFields=`a.id,a.title,a.project_id AS "projectId",a.kind,a.action,
  a.created_at AS date,a.actor_snapshot AS "actorSnapshot",u.display_name AS "fallbackActor"`;
function activityEvent(event:EventRow):ActivityEvent {
  return {
    id: event.id, title: redactCredentials(event.title), projectId: event.projectId, date: event.date,
    actor: redactCredentials(event.actorSnapshot || event.fallbackActor || 'کاربر حذف‌شده'),
    source: eventSources[event.kind] ?? event.kind,
    detail: {create: 'ثبت رکورد جدید', update: 'به‌روزرسانی رکورد', delete: 'حذف رکورد'}[event.action] ?? redactCredentials(event.action),
  };
}
export function loadActivityById(account:Account,id:string) {
  return readTransaction(async db => {
    const policy=await projectPolicy(db,account);
    const event=await db.one<EventRow>(`SELECT ${eventFields}
      FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id
      WHERE a.workspace_id=? AND a.id=? AND (?=1 OR a.kind<>'secrets')`,account.workspaceId,id,Number(account.role==='owner'));
    if (event && canSeeProject(policy,event.projectId)) return activityEvent(event);
  });
}
type Member = {id: string; name: string; email: string; role: Account['role']; project_ids: string | null};

export function loadState(account: Account): Promise<{data: DemoData; version: number}> {
  return readTransaction(db => readState(db, account));
}
async function readState(db: SqlExecutor, account: Account) {
  const policy = await projectPolicy(db, account);
  const workspace = await db.one<{version: number; name: string}>(
    'SELECT version,name FROM workspaces WHERE id=?', account.workspaceId,
  );
  if (!workspace) throw new ForbiddenError();
  const data = structuredClone(emptyData);
  const rows = await db.all<RecordRow>(`SELECT kind,id,project_id,payload,record_version FROM ${recordReadTable(db)}
    WHERE workspace_id=? AND (?=1 OR kind<>'secrets') ORDER BY updated_at,id`,
  account.workspaceId, Number(account.role === 'owner'));
  const prefs = rows.find(row => row.kind === 'preferences');
  if (prefs) data.preferences = { ...data.preferences, ...redactStoredValue(JSON.parse(prefs.payload)) as object };
  data.preferences.workspace = redactCredentials(workspace.name);
  if (account.role !== 'owner' || !prefs) data.preferences.displayName = redactCredentials(account.displayName);
  for (const row of rows) {
    if (!isRecordKind(row.kind)) continue;
    const record = await projectRecord(db, account, policy, row);
    if (record) (data[row.kind] as WorkspaceRecord[]).push(record);
  }
  const members = await db.all<Member>(`SELECT u.id,u.display_name AS name,u.email,m.role,m.project_ids FROM memberships m
    JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND (?=1 OR u.id=?)
    ORDER BY CASE WHEN u.id=? THEN 0 ELSE 1 END,u.email`,
  account.workspaceId, Number(account.role === 'owner'), account.id, account.id);
  data.users = members.map(m => ({
    id: m.id, name: redactCredentials(m.name), email: redactCredentials(m.email),
    role: m.role === 'owner' ? 'Owner' : m.role === 'editor' ? 'Developer' : 'Viewer',
    projectId: '', state: 'active',
    ...(account.role === 'owner' ? { projectIds: m.project_ids === null ? null : JSON.parse(m.project_ids) as string[] } : {}),
  }));
  const grants = policy.projectIds ? [...policy.projectIds] : null;
  const projectCondition = grants
    ? grants.length ? ` AND a.project_id IN (${grants.map(() => '?').join(',')})` : ' AND 1=0'
    : '';
  const events = await db.all<EventRow>(`SELECT ${eventFields}
    FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id
    WHERE a.workspace_id=? AND (?=1 OR a.kind<>'secrets')${projectCondition}
    ORDER BY a.created_at DESC,a.id DESC LIMIT 500`, account.workspaceId, Number(account.role === 'owner'), ...(grants ?? []));
  data.events = events.map(activityEvent);
  return { data, version: workspace.version };
}

export function projectOf(kind: RecordKind, record: WorkspaceRecord) {
  return kind === 'projects' ? record.id : 'projectId' in record ? record.projectId : null;
}

async function writeRow(db: SqlExecutor, workspaceId: string, row: RecordRow, timestamp: string) {
  await db.run(`INSERT INTO records(workspace_id,kind,id,project_id,payload,updated_at,record_version) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(workspace_id,kind,id) DO UPDATE SET project_id=?,payload=?,updated_at=?,record_version=?`,
  workspaceId, row.kind, row.id, row.project_id, row.payload, timestamp, row.record_version,
  row.project_id,row.payload,timestamp,row.record_version);
}

function automationFields(record: object) {
  return Object.fromEntries(Object.entries(record).filter(([field]) => field !== 'state' && field !== 'snoozedUntil'));
}

function resourceLink(kind: RecordKind, record?: WorkspaceRecord) {
  if (kind === 'charges') {
    const charge = record as DemoData['charges'][number] | undefined;
    if (charge?.linkedResourceId) return {id:charge.linkedResourceId, projectId:charge.projectId};
  }
  if (kind === 'secrets') {
    const reference = record as DemoData['secrets'][number] | undefined;
    if (reference?.resourceId) return {id:reference.resourceId, projectId:reference.projectId};
  }
}

function standaloneDeadline(kind: RecordKind, record?: WorkspaceRecord) {
  if (kind === 'resources') {
    const resource = record as Resource | undefined;
    if (resource?.expires) return {category:'تمدید', date:resource.expires, projectId:resource.projectId};
  }
  if (kind === 'tasks') {
    const task = record as DemoData['tasks'][number] | undefined;
    if (task && task.status !== 'done' && task.noticeDays !== undefined) {
      return {category:'یادآوری', date:task.due, projectId:task.projectId};
    }
  }
}

async function retireChangedDeadlines(db: SqlExecutor, workspace: string, changes: PreparedChange[]) {
  for (const {kind, id, previous, record} of changes) {
    if (!previous) continue;
    if (kind === 'reminders') {
      const before = JSON.parse(previous.payload) as DemoData['reminders'][number];
      const after = record as DemoData['reminders'][number] | undefined;
      const timing = (item?: DemoData['reminders'][number]) => item && !item.paused
        ? [item.due,item.projectId,item.kind,item.repeat,item.zone,item.noticeDays] : null;
      if (timing(before) && !isDeepStrictEqual(timing(before),timing(after))) {
        if (db.scopeIdentity) await db.one('SELECT public.projectos_retire_explicit_reminder(?)',id);
        else {
          const alerts = await db.all<{id:string}>(`SELECT i.id FROM records i JOIN notification_outbox n
            ON n.workspace_id=i.workspace_id AND n.id=i.id AND n.channel='in_app'
            WHERE i.workspace_id=? AND i.kind='incidents' AND i.project_id=? AND n.reminder_id=?`,
          workspace,before.projectId,'reminders:' + id);
          for (const alert of alerts) {
            if (!/^auto-[a-f0-9]{28}$/.test(alert.id)) continue;
            await db.run(`UPDATE notification_outbox SET state='cancelled' WHERE workspace_id=?
              AND (id=? OR id=? OR id=? OR id LIKE ? OR id LIKE ?) AND state IN ('pending','retrying','sending','available')`,
            workspace,alert.id,'tg-' + alert.id,'email-' + alert.id,'tg-' + alert.id + '-%','email-' + alert.id + '-%');
          }
        }
      }
      continue;
    }
    if (kind !== 'tasks' && kind !== 'resources') continue;
    const before = standaloneDeadline(kind, JSON.parse(previous.payload) as WorkspaceRecord);
    const after = standaloneDeadline(kind, record);
    if (!before || (before.date === after?.date && before.projectId === after?.projectId)) continue;
    if (db.scopeIdentity) {
      await db.one('SELECT public.projectos_retire_deadline(?,?)',kind,id);
      continue;
    }
    await retireReminderAlert(db, workspace, reminderAlertId(workspace, before.category, id, before.date, kind));
    const legacy = reminderAlertId(workspace, before.category, id, before.date);
    const provenLegacy = await db.one(`SELECT id FROM notification_outbox WHERE workspace_id=? AND id=? AND reminder_id=?`,
      workspace, legacy, kind + ':' + id);
    if (provenLegacy) await retireReminderAlert(db, workspace, legacy);
  }
}

async function validateInvoiceLedger(db: SqlExecutor, workspace: string) {
  const rows=await db.all<Pick<RecordRow,'kind'|'id'|'payload'>>(
    `SELECT kind,id,payload FROM ${recordReadTable(db)} WHERE workspace_id=? AND kind IN ('projects','contracts','invoices','payments')`,workspace);
  const projects=new Set(rows.filter(row=>row.kind==='projects').map(row=>row.id));
  const contracts=new Map(rows.filter(row=>row.kind==='contracts').map(row=>[row.id,JSON.parse(row.payload) as DemoData['contracts'][number]]));
  const invoices=new Map<string,Invoice>();
  const invoiceReferences=new Set<string>();
  for (const row of rows) {
    if (row.kind!=='invoices') continue;
    const invoice=JSON.parse(row.payload) as Invoice;
    const key=normalized(invoice.reference.normalize('NFKC'));
    if (!projects.has(invoice.projectId)) throw new ValidationError('Invoice project must exist');
    if (invoice.contractId !== undefined) {
      const contract=contracts.get(invoice.contractId);
      if (!contract || contract.projectId!==invoice.projectId || contract.currency!==invoice.currency) {
        throw new ValidationError('Invoice contract must have the same project and currency');
      }
    }
    if (invoiceReferences.has(key)) throw new ValidationError('Duplicate invoice reference');
    invoiceReferences.add(key);
    invoices.set(invoice.id,invoice);
  }
  const paymentReferences=new Set<string>();
  const balances=new Map<string,bigint>();
  for (const row of rows) {
    if (row.kind!=='payments') continue;
    const payment=JSON.parse(row.payload) as Payment;
    const key=normalized(payment.reference.normalize('NFKC'));
    if (paymentReferences.has(key)) throw new ValidationError('Duplicate payment reference');
    paymentReferences.add(key);
    const invoice=invoices.get(payment.invoiceId);
    if (!invoice || invoice.projectId!==payment.projectId || invoice.currency!==payment.currency
      || invoice.state==='void' || payment.paidOn<invoice.issuedOn) {
      throw new ValidationError('Payment is incompatible with its invoice');
    }
    const paid=(balances.get(payment.invoiceId) ?? BigInt(0))+BigInt(payment.amount);
    if (paid>BigInt(invoice.amount)) throw new ValidationError('Payments exceed invoice amount');
    balances.set(payment.invoiceId,paid);
  }
}

export async function persistChanges(
  db: SqlExecutor, account: Account, version: number, changes: PreparedChange[], preferences?: Preferences,
  provenance?:'shared-cost' | 'currency-provider',
) {
  const now = new Date().toISOString();
  const { workspaceId } = account;
  if (changes.length > 100) throw new ValidationError('Too many record changes');
  await retireChangedDeadlines(db, workspaceId, changes);
  const resourceChanges = new Map(changes.filter(change => change.kind === 'resources').map(change => [change.id, change]));
  for (const change of changes) {
    const { kind, id, record, previous } = change;
    const before = previous ? JSON.parse(previous.payload) as WorkspaceRecord : undefined;
    const projectId = record ? projectOf(kind, record) : previous?.project_id ?? null;
    if (kind==='expenses' && allocationId.test(id) && (!record || (before ? !isDeepStrictEqual({...before,status:(record as DemoData['expenses'][number]).status},record) : provenance!=='shared-cost'))) {
      throw new ValidationError('Shared expense shares preserve the original allocation');
    }
    if (kind==='payments' && previous) throw new ValidationError('Posted payments are immutable');
    if (kind==='exchangeRates' && (record as DemoData['exchangeRates'][number] | undefined)?.receivedAt && !previous
      && provenance!=='currency-provider') throw new ValidationError('Provider receipt time is server managed');
    if (kind==='exchangeRates' && previous) throw new ValidationError('Recorded exchange rates are immutable');
    if (kind==='projects' && !record && await db.one(`SELECT id FROM ${recordReadTable(db)} WHERE workspace_id=?
      AND project_id=? AND kind='exchangeRates' LIMIT 1`,workspaceId,id)) {
      throw new ValidationError('Project still has exchange rates');
    }
    if (kind==='invoices') {
      const invoice=record as Invoice | undefined;
      const original=before as Invoice | undefined;
      if (!original && invoice?.state!=='open') throw new ValidationError('New invoices must be open');
      if (original && (original.state!=='open' || !isDeepStrictEqual(invoice,{...original,state:'void'}))) {
        throw new ValidationError('An issued invoice can only be voided');
      }
    }
    if (kind === 'incidents' && (id.startsWith('auto-') || id.startsWith('monitor-'))) {
      if (!before || !record || !isDeepStrictEqual(automationFields(before), automationFields(record))) {
        throw new ForbiddenError();
      }
      const incident = record as DemoData['incidents'][number];
      if (incident.source === 'زمان‌بند داخلی · چرخش اعتبارنامه' && account.role !== 'owner') throw new ForbiddenError();
      if (incident.state !== 'open' && db.scopeIdentity) {
        await db.one('SELECT public.projectos_cancel_incident_outbox(?)',id);
      } else if (incident.state !== 'open') {
        await db.run(`UPDATE notification_outbox SET state='cancelled' WHERE workspace_id=?
          AND (id=? OR id=? OR id LIKE ? OR id LIKE ?) AND state IN ('pending','retrying','sending')`,
        workspaceId, 'tg-' + id, 'email-' + id, 'tg-' + id + '-%', 'email-' + id + '-%');
      }
    }
    if (record && before && !isDeepStrictEqual(before, redactStoredValue(before))) {
      // A read projection is insufficient to overwrite a quarantined legacy record.
      throw new ValidationError('Legacy record requires offline credential remediation');
    }
    if (kind === 'secrets' && record) {
      const proposed = record as DemoData['secrets'][number];
      const current = before as DemoData['secrets'][number] | undefined;
      if (proposed.lastCheckedAt !== current?.lastCheckedAt
        || (current?.lastCheckedAt && proposed.externalRef !== current.externalRef)) {
        throw new ForbiddenError();
      }
    }
    const link = resourceLink(kind, record);
    if (link) {
      const prior = resourceLink(kind, before);
      if (link.id !== prior?.id || link.projectId !== prior?.projectId) {
        const pending = resourceChanges.get(link.id);
        const stored = pending ? undefined : await storedRecord(db, workspaceId, 'resources', link.id);
        const resource = (pending?.record as Resource | undefined) ?? (stored ? JSON.parse(stored.payload) as Resource : undefined);
        if (!resource || (resource.projectId !== link.projectId && !resource.linkedProjectIds?.includes(link.projectId))) {
          throw new ValidationError('Linked resource must belong to or be shared with the record project');
        }
      }
    }
    if (record && !before && (kind === 'projects' || kind === 'docs')) {
      const usePrivateHistory = db.dialect==='postgres' && kind==='docs' && account.role==='editor'
        && Boolean(process.env.PROJECTOS_DB_SCOPE_KEY);
      const deleted = usePrivateHistory
        ? (await db.one<{retired:boolean}>('SELECT public.projectos_document_was_retired(?) AS retired',id))?.retired
        : await db.one(`SELECT id FROM audit_events WHERE workspace_id=? AND kind=? AND record_id=?
          AND action='delete' LIMIT 1`, workspaceId, kind, id);
      if (deleted) throw new VersionConflictError();
    }
    if (record && kind === 'docs') {
      const doc = record as DemoData['docs'][number];
      const old = before as DemoData['docs'][number] | undefined;
      if (old && doc.revision <= old.revision) throw new ValidationError('Document revision must advance on edits');
      const added = await db.run(`INSERT INTO document_versions(workspace_id,document_id,revision,payload,saved_at) VALUES(?,?,?,?,?)
        ON CONFLICT(workspace_id,document_id,revision) DO NOTHING`,
      workspaceId, id, doc.revision, JSON.stringify(doc), now);
      if (!added) throw new VersionConflictError();
    }
    if (record) {
      await writeRow(db, workspaceId, { kind, id, project_id: projectId, payload: JSON.stringify(record), record_version: version }, now);
      await db.run('DELETE FROM record_tombstones WHERE workspace_id=? AND kind=? AND id=?', workspaceId, kind, id);
    } else {
      await db.run('DELETE FROM records WHERE workspace_id=? AND kind=? AND id=?', workspaceId, kind, id);
      if (db.dialect === 'postgres') {
        await db.run(`INSERT INTO record_tombstones(workspace_id,kind,id,record_version,project_id) VALUES(?,?,?,?,?)
          ON CONFLICT(workspace_id,kind,id) DO UPDATE SET record_version=excluded.record_version,project_id=excluded.project_id`,
        workspaceId,kind,id,version,projectId);
      } else {
        await db.run(`INSERT INTO record_tombstones(workspace_id,kind,id,record_version) VALUES(?,?,?,?)
          ON CONFLICT(workspace_id,kind,id) DO UPDATE SET record_version=excluded.record_version`,workspaceId,kind,id,version);
      }
    }
    const title = record && 'title' in record ? record.title : record && 'name' in record ? record.name : id;
    await db.run(`INSERT INTO audit_events(id,workspace_id,actor_id,kind,record_id,action,title,project_id,created_at,actor_snapshot)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, randomUUID(), workspaceId, account.id,
    kind === 'incidents' && ((record ?? before) as DemoData['incidents'][number] | undefined)?.source === 'زمان‌بند داخلی · چرخش اعتبارنامه'
      ? 'secrets' : kind, id,
    record ? previous ? 'update' : 'create' : 'delete', redactCredentials(title), projectId ?? '', now,
    redactCredentials(account.displayName));
  }
  if (changes.some(({kind, record})=>kind==='invoices' || kind==='payments' || kind==='contracts' || (kind==='projects' && !record))) {
    await validateInvoiceLedger(db,workspaceId);
  }
  if (preferences) {
    await writeRow(db, workspaceId, { kind: 'preferences', id: 'singleton', project_id: null,
      payload: JSON.stringify(preferences), record_version: version }, now);
    await db.run('UPDATE workspaces SET version=?,name=? WHERE id=?', version, preferences.workspace, workspaceId);
    await db.run('UPDATE users SET display_name=? WHERE id=?', preferences.displayName, account.id);
  } else {
    await db.run('UPDATE workspaces SET version=? WHERE id=?', version, workspaceId);
  }
}

export async function saveState(account: Account, expectedVersion: number, next: CanonicalState) {
  if (account.role !== 'owner') throw new ForbiddenError();
  return transaction(async db => {
    const workspace = await lockWorkspace(db, account.workspaceId);
    if (!workspace) throw new ForbiddenError();
    await projectPolicy(db, account);
    if (workspace.version !== expectedVersion) throw new VersionConflictError();
    const rows = await db.all<RecordRow>(
      `SELECT kind,id,project_id,payload,record_version FROM ${recordReadTable(db)} WHERE workspace_id=? AND kind<>'preferences'`,
      account.workspaceId,
    );
    const changes: PreparedChange[] = [];
    for (const kind of recordKinds) {
      const requested=next[kind];
      if (requested===undefined) continue;
      const previous = new Map(rows.filter(row => row.kind === kind).map(row => [row.id, row]));
      for (const record of requested) {
        const row = previous.get(record.id);
        previous.delete(record.id);
        if (!row || !isDeepStrictEqual(redactRecord(row), record)) {
          changes.push({ kind, id: record.id, previous: row, record });
        }
      }
      for (const row of previous.values()) changes.push({ kind, id: row.id, previous: row });
    }
    const version = expectedVersion + 1;
    await persistChanges(db, account, version, changes, next.preferences);
    return version;
  });
}
