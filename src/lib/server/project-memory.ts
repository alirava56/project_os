import { canSeeProject, projectPolicy, readTransaction, recordReadTable, storedRecord, type Account } from './db';
import { MissingRecordError } from './record-service';
import { redactCredentials, redactStoredValue, suspiciousCredential } from './credential-guard';
import type { Project, Task } from '../types';

export type Citation = {
  id: string; kind: 'doc' | 'task' | 'project' | 'reminder' | 'activity';
  projectId: string; title: string; href: string; updatedAt: string; excerpt: string;
};

export function normalizePersian(value: string) {
  return value.normalize('NFKC').toLowerCase().replaceAll('ي', 'ی').replaceAll('ك', 'ک')
    .replace(/[\u200c\u200d]/g, ' ').replace(/\s+/g, ' ').trim();
}

type MemoryRow = { kind: 'docs' | 'tasks' | 'projects' | 'reminders'; id: string; project_id: string; updated_at: string; payload: string };
type MemoryPayload = { title?: string; name?: string; body?: string; description?: string; due?: string; kind?: string };
const paths = {
  docs: { kind: 'doc', href: (id: string) => '/docs?doc=' + encodeURIComponent(id) },
  tasks: { kind: 'task', href: (id: string) => '/tasks/' + encodeURIComponent(id) },
  projects: { kind: 'project', href: (id: string) => '/projects/' + encodeURIComponent(id) },
  reminders: { kind: 'reminder', href: () => '/calendar' },
} as const;

function memoryText(value: string) {
  const redacted=redactCredentials(value.trim());
  return suspiciousCredential(redacted) || redacted.includes('[REDACTED') ? '' : redacted;
}

export async function resumeProject(account: Account, projectId: string) {
  return readTransaction(async db => {
    const policy=await projectPolicy(db,account);
    const stored=canSeeProject(policy,projectId) && await db.one<Pick<MemoryRow,'updated_at'|'payload'>>(
      `SELECT updated_at,payload FROM ${recordReadTable(db)} WHERE workspace_id=? AND kind='projects' AND id=?`,account.workspaceId,projectId);
    if (!stored) throw new MissingRecordError();
    const project=redactStoredValue(JSON.parse(stored.payload)) as Project;
    const workspace=account.workspaceId;
    type Event = {id:string;title:string;action:string;kind:string;created_at:string;actor_id:string|null};
    const latest=await db.one<Event>(`SELECT id,title,action,kind,created_at,actor_id FROM audit_events
      WHERE workspace_id=? AND project_id=? AND kind IN ('manual','projects','tasks','docs')
      ORDER BY created_at DESC,CASE WHEN kind='manual' THEN 0 ELSE 1 END,id DESC LIMIT 1`,workspace,projectId);
    const personal=latest?.actor_id===account.id ? undefined : await db.one<Event>(
      `SELECT id,title,action,kind,created_at,actor_id FROM audit_events
       WHERE workspace_id=? AND project_id=? AND actor_id=? AND kind IN ('manual','projects','tasks','docs')
       ORDER BY created_at DESC,CASE WHEN kind='manual' THEN 0 ELSE 1 END,id DESC LIMIT 1`,workspace,projectId,account.id);
    const notes:string[]=[];
    const citations:Citation[]=[];
    for (const [label,event] of [['آخرین فعالیت ثبت‌شده',latest],['آخرین فعالیت ثبت‌شدهٔ شما',personal]] as const) {
      if (!event) continue;
      const title=memoryText(event.title);
      if (!title) continue;
      const action=event.kind==='manual' ? memoryText(event.action)
        : {create:'ثبت رکورد',update:'به‌روزرسانی رکورد',delete:'حذف رکورد'}[event.action] ?? '';
      citations.push({id:'activity:'+event.id,kind:'activity',projectId,title,
        href:'/activity?event='+encodeURIComponent(event.id),updatedAt:event.created_at,excerpt:action});
      notes.push(label+' «'+title+'» ['+citations.length+']');
    }
    if (project.status==='archived') {
      citations.push({id:'project:'+projectId,kind:'project',projectId,title:memoryText(project.name),
        href:paths.projects.href(projectId),updatedAt:stored.updated_at,excerpt:'وضعیت پروژه: بایگانی‌شده'});
      notes.push('پروژه بایگانی شده است. ['+citations.length+']');
    } else {
      const next=memoryText(project.next);
      if (next) {
        citations.push({id:'project:'+projectId,kind:'project',projectId,title:memoryText(project.name),
          href:paths.projects.href(projectId),updatedAt:stored.updated_at,excerpt:next});
        notes.push('قدم بعدی ثبت‌شده «'+next+'» ['+citations.length+']');
      } else {
        const rows=await db.all<MemoryRow>(`SELECT kind,id,project_id,updated_at,payload FROM ${recordReadTable(db)}
          WHERE workspace_id=? AND project_id=? AND kind='tasks' ORDER BY updated_at DESC,id LIMIT 2000`,workspace,projectId);
        const priorities={high:0,medium:1,low:2};
        const candidate=rows.map(row=>({row,task:redactStoredValue(JSON.parse(row.payload)) as Task}))
          .filter(({task})=>['doing','todo'].includes(task.status) && !!memoryText(task.title))
          .sort((a,b)=>Number(a.task.status!=='doing')-Number(b.task.status!=='doing') ||
            priorities[a.task.priority]-priorities[b.task.priority] || a.task.due.localeCompare(b.task.due))[0];
        if (candidate) {
          const {row,task}=candidate;
          const title=memoryText(task.title);
          const status=task.status==='doing'?'در حال انجام':'برای انجام';
          citations.push({id:'task:'+row.id,kind:'task',projectId,title,href:paths.tasks.href(row.id),
            updatedAt:row.updated_at,excerpt:status+' · '+task.due});
          notes.push('کار قابل پیگیری «'+title+'» ['+citations.length+']');
        } else {
          notes.push('برای تعیین قدم بعدی، اطلاعات کافی در پروژه ثبت نشده است.');
        }
      }
    }
    return {answer:notes.join('\n'),citations};
  });
}

export async function retrieveMemory(account: Account, query: string, projectId?: string): Promise<Citation[]> {
  return readTransaction(async db => {
    const policy = await projectPolicy(db, account);
    if (projectId && (!canSeeProject(policy, projectId) || !await storedRecord(db, account.workspaceId, 'projects', projectId))) {
      throw new MissingRecordError();
    }
    const scope = projectId ? [projectId] : policy.projectIds ? [...policy.projectIds] : undefined;
    if (scope && !scope.length) return [];
    const clauses = scope ? ' AND project_id IN (' + scope.map(() => '?').join(',') + ')' : '';
    const rows = await db.all<MemoryRow>(`SELECT kind,id,project_id,updated_at,payload FROM ${recordReadTable(db)} WHERE workspace_id=?
      AND kind IN ('docs','tasks','projects','reminders')${clauses} ORDER BY updated_at DESC,id LIMIT 2000`,
    account.workspaceId, ...(scope ?? []));
    const terms = [...new Set(normalizePersian(query).split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 1))];
    return rows.flatMap(row => {
      const {kind, href} = paths[row.kind];
      const value = redactStoredValue(JSON.parse(row.payload)) as MemoryPayload;
      const title = redactCredentials(value.title ?? value.name ?? '').slice(0, 180);
      const excerpt = redactCredentials(value.body ?? value.description ?? [value.kind, value.due].filter(Boolean).join(' · ')).slice(0, 850);
      const titleKey = normalizePersian(title), textKey = normalizePersian(excerpt);
      const score = terms.reduce((sum, term) => sum + (titleKey.includes(term) ? 4 : 0) + (textKey.includes(term) ? 1 : 0), 0);
      return score && title ? [{ score, citation: {
        id: kind + ':' + row.id, kind, title, href: href(row.id), projectId: row.project_id, updatedAt: row.updated_at, excerpt,
      } }] : [];
    }).sort((left, right) => right.score - left.score).slice(0, 6).map(item => item.citation);
  });
}

/** Provider output is untrusted. Display only literal, attributable fragments of submitted sources. */
export function verifyQuotes(text: string, citations: Citation[]) {
  let output: unknown;
  try { output = JSON.parse(text); } catch { return []; }
  const quotes = (output as { quotes?: unknown })?.quotes;
  if (!Array.isArray(quotes) || !quotes.length || quotes.length > 5) return [];
  const verified: Array<{citation: Citation; quote: string}> = [];
  for (const item of quotes) {
    const {id, quote} = item as {id?: unknown; quote?: unknown} ?? {};
    const citation = citations.find(candidate => candidate.id === id);
    if (!citation || typeof quote !== 'string' || quote.trim() !== quote || quote.length < 6 || quote.length > 240
      || suspiciousCredential(quote) || !citation.excerpt.includes(quote)) return [];
    verified.push({ citation, quote });
  }
  return verified;
}
