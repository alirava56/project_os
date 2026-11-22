import { isRecordKind, validRecordId, type RecordChange, type RecordKind, type WorkspaceRecord } from '../record-contract';
import type { DemoData } from '../types';
import {
  canSeeProject, ForbiddenError, lockWorkspace, persistChanges, projectOf, projectPolicy, recordReadTable, storedRecord,
  transaction, VersionConflictError, type Account, type PreparedChange, type RecordRow, type SqlExecutor,
} from './db';
import { parsePreferences, parseRecord, validateGraph, ValidationError } from './validation';

export class MissingRecordError extends Error {}
export class DuplicateRecordError extends Error {}
const editorKinds = new Set<RecordKind>(['tasks', 'docs', 'reminders', 'incidents']);

function validateChange(input: unknown): RecordChange {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ValidationError('Invalid record change');
  const change = input as Partial<RecordChange>;
  if (!isRecordKind(change.kind) || !validRecordId(change.id)
    || (change.action !== 'create' && change.action !== 'replace' && change.action !== 'delete')
    || Object.keys(input).some(key => !['kind', 'id', 'action', 'record'].includes(key))) {
    throw new ValidationError('Invalid record change');
  }
  return { kind: change.kind, id: change.id, action: change.action, record: change.record };
}

function key(kind: RecordKind, id: string) { return kind + ':' + id; }
function decode(row: RecordRow): WorkspaceRecord { return JSON.parse(row.payload) as WorkspaceRecord; }

async function validateRelations(db: SqlExecutor, workspaceId: string, changes: Map<string, PreparedChange>, checkTaskGraph: boolean) {
  const exists = async (kind: RecordKind, id: string) => {
    const draft = changes.get(key(kind, id));
    return draft ? Boolean(draft.record) : Boolean(await storedRecord(db, workspaceId, kind, id));
  };
  const updates = [...changes.values()];
  for (const {kind, record} of updates) {
    if (!record || kind === 'projects') continue;
    const project = projectOf(kind, record);
    if (!project || !await exists('projects', project)) throw new ValidationError('Unknown project');
  }

  const removedProjects = new Set(updates.filter(change => change.kind === 'projects' && !change.record).map(change => change.id));
  for (const projectId of removedProjects) {
    const children = await db.all<RecordRow>(`SELECT kind,id,project_id,payload,record_version FROM ${recordReadTable(db)}
      WHERE workspace_id=? AND project_id=? AND kind<>'projects'`, workspaceId, projectId);
    for (const row of children) {
      const draft = changes.get(key(row.kind as RecordKind, row.id));
      if (!draft || (draft.record && projectOf(draft.kind, draft.record) === projectId)) {
        throw new ValidationError('Project still has records');
      }
    }
  }

  async function graphRows<Kind extends 'tasks' | 'resources' | 'charges' | 'secrets'>(kind: Kind) {
    const rows = await db.all<RecordRow>(`SELECT kind,id,project_id,payload,record_version FROM ${recordReadTable(db)} WHERE workspace_id=? AND kind=?`,
      workspaceId, kind);
    type Item = DemoData[Kind][number];
    const effective = new Map<string, Item>(rows.map(row => [row.id, decode(row) as Item]));
    for (const draft of updates) {
      if (draft.kind !== kind) continue;
      if (draft.record) effective.set(draft.id, draft.record as Item);
      else effective.delete(draft.id);
    }
    return effective;
  }
  if (checkTaskGraph && updates.some(change => change.kind === 'tasks')) {
    const tasks = await graphRows('tasks');
    validateGraph(new Map([...tasks].map(([id, task]) => [id, task.dependencies])), 'task dependencies');
  }

  const removedResources = new Set(updates.filter(change => change.kind === 'resources' && !change.record).map(change => change.id));
  if (removedResources.size) {
    const references = await graphRows('secrets');
    if ([...references.values()].some(reference => reference.resourceId && removedResources.has(reference.resourceId))) {
      throw new ValidationError('Resource still has Vault references');
    }
  }

  if (updates.some(change => change.kind === 'resources' || change.kind === 'charges') || removedProjects.size) {
    const resources = await graphRows('resources');
    validateGraph(new Map([...resources].map(([id, resource]) => [id, resource.parentId ? [resource.parentId] : []])), 'resource parents');
    for (const resource of resources.values()) {
      if (resource.linkedProjectIds?.some(id => removedProjects.has(id))) throw new ValidationError('Project still has shared resources');
    }
    for (const change of updates) {
      if (change.kind !== 'resources' || !change.record) continue;
      const resource = change.record as DemoData['resources'][number];
      for (const id of resource.linkedProjectIds ?? []) {
        if (!await exists('projects', id)) throw new ValidationError('Invalid shared resource project');
      }
    }
    const charges = await graphRows('charges');
    for (const charge of charges.values()) {
      if (charge.linkedResourceId && !resources.has(charge.linkedResourceId)) {
        throw new ValidationError('Invalid charge resource reference');
      }
    }
  }
}

export async function commitRecordChanges(
  account: Account, expectedVersion: number, input: unknown, preferences?: unknown, strictWorkspaceVersion = false,
) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new ValidationError('Invalid revision');
  if (!Array.isArray(input) || input.length > 100 || (!input.length && preferences === undefined)) {
    throw new ValidationError('Expected up to 100 record changes');
  }
  if (account.role === 'viewer' || (preferences !== undefined && account.role !== 'owner')) throw new ForbiddenError();
  const changes = input.map(validateChange);
  const settings = preferences === undefined ? undefined : parsePreferences(preferences);
  return transaction(async db => {
    const workspace = await lockWorkspace(db, account.workspaceId);
    if (!workspace) throw new ForbiddenError();
    const policy = await projectPolicy(db, account);
    const privateTaskGraph = db.dialect==='postgres' && account.role==='editor' && policy.projectIds!==null
      && Boolean(process.env.PROJECTOS_DB_SCOPE_KEY);
    if (expectedVersion > workspace.version || (strictWorkspaceVersion && workspace.version !== expectedVersion)) {
      throw new VersionConflictError();
    }
    if (settings) {
      const existing = await storedRecord(db, account.workspaceId, 'preferences', 'singleton');
      if (existing && existing.record_version > expectedVersion) throw new VersionConflictError();
    }

    const prepared = new Map<string, PreparedChange>();
    for (const change of changes) {
      const { kind, id, action } = change;
      if (account.role === 'editor' && !editorKinds.has(kind)) throw new ForbiddenError();
      const keyForRecord = key(kind, id);
      if (prepared.has(keyForRecord)) throw new ValidationError('Duplicate change in transaction');
      const previous = await storedRecord(db, account.workspaceId, kind, id);
      if (previous && !canSeeProject(policy, previous.project_id)) throw new MissingRecordError();
      if (action === 'create' && previous) throw new DuplicateRecordError();
      if (action !== 'create' && !previous) throw new MissingRecordError();
      if (previous && previous.record_version > expectedVersion) throw new VersionConflictError();
      if (!previous) {
        const stale = db.scopeIdentity
          ? (await db.one<{stale:boolean}>('SELECT public.projectos_check_record_tombstone(?,?,?) AS stale',kind,id,expectedVersion))?.stale
          : await db.one('SELECT id FROM record_tombstones WHERE workspace_id=? AND kind=? AND id=? AND record_version>?',
            account.workspaceId,kind,id,expectedVersion);
        if (stale) throw new VersionConflictError();
      }
      const record = action === 'delete' ? undefined : parseRecord(kind, change.record);
      if (record && record.id !== id) throw new ValidationError('Record id mismatch');
      if (record && !canSeeProject(policy, projectOf(kind, record))) throw new ForbiddenError();
      // Legacy same-workspace cross-project dependencies may be hidden from this editor.
      // Keep those edges intact and reject any new dependency outside the editor's grant.
      if (record && kind === 'tasks' && policy.projectIds !== null) {
        const task = record as DemoData['tasks'][number];
        const old = previous && !privateTaskGraph ? decode(previous) as DemoData['tasks'][number] : undefined;
        const hidden: string[] = [];
        for (const id of old?.dependencies ?? []) {
          const row = await storedRecord(db, account.workspaceId, 'tasks', id);
          if (row && !canSeeProject(policy, row.project_id)) hidden.push(id);
        }
        for (const id of task.dependencies) {
          const row = await storedRecord(db, account.workspaceId, 'tasks', id);
          if ((row && !canSeeProject(policy, row.project_id)) || (privateTaskGraph && !row
            && !changes.some(change=>change.kind==='tasks' && change.id===id && change.action==='create'))) {
            throw new ValidationError('Invalid task dependency');
          }
        }
        task.dependencies = [...task.dependencies, ...hidden];
      }
      prepared.set(keyForRecord, { kind, id, previous, record });
    }
    await validateRelations(db, account.workspaceId, prepared, !privateTaskGraph);
    const version = workspace.version + 1;
    await persistChanges(db, account, version, [...prepared.values()], settings);
    const tasks=[...prepared.values()].filter(change=>change.kind==='tasks').map(change=>change.id);
    if (privateTaskGraph && tasks.length) {
      const verified=await db.one<{result:string}>('SELECT public.projectos_check_task_graph(?::jsonb) AS result',JSON.stringify(tasks));
      if (verified?.result!=='valid') throw new ValidationError('Invalid task dependency graph');
    }
    return version;
  });
}

export function mutateRecord(account: Account, expectedVersion: number, kind: RecordKind, id: string,
  action: RecordChange['action'], record?: unknown, strictWorkspaceVersion = true) {
  return commitRecordChanges(account, expectedVersion, [{kind, id, action, record}], undefined, strictWorkspaceVersion);
}
