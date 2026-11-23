import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { validRecordId } from '../record-contract';
import { redactCredentials } from './credential-guard';

export type RepositoryBinding = { workspaceId: string; projectId: string; repository: string };
export type JobProgress = {state:string;stage:string;page:number;error:string|null};
export type RepositorySnapshot = {
  repository: string;
  state: 'connected' | 'unknown' | 'rate_limited' | 'pending_refresh' | 'stale';
  checkedAt: string;
  updatedAt?: string;
  openIssues?: number;
  issues?: Array<{number: number; title: string}>;
  commits?: Array<{sha: string; subject: string; committedAt: string | null}>;
  branches?: Array<{name: string; sha: string}>;
  pullRequests?: Array<{number: number; title: string; status: 'open' | 'closed' | 'merged'; updatedAt: string | null}>;
  releases?: Array<{tag: string; publishedAt: string | null}>;
  latestDeployment?: {id: number; state: string} | null;
  retryAt?: string;
  lastSuccessfulAt?: string;
  job?: JobProgress;
};

export function githubBindings(value = process.env.PROJECTOS_GITHUB_PROJECTS): RepositoryBinding[] {
  if (!value || value.length > 24_000) return [];
  try {
    const entries: unknown = JSON.parse(value);
    if (!Array.isArray(entries) || entries.length > 50) return [];
    const result: RepositoryBinding[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const row = entry as Partial<RepositoryBinding> | null;
      if (!row || !validRecordId(row.workspaceId) || !validRecordId(row.projectId) || typeof row.repository !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(row.repository) || row.repository.endsWith('.')) return [];
      const normalized = row.repository.toLowerCase();
      const key = JSON.stringify([row.workspaceId, row.projectId, normalized]);
      if (!seen.has(key)) result.push({ workspaceId:row.workspaceId, projectId:row.projectId, repository:normalized });
      seen.add(key);
    }
    return result;
  } catch { return []; }
}

export function signedDelivery(raw: Buffer, signature: string | null, key: string) {
  if (key.length < 24 || !signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature.slice(7), 'hex'), createHmac('sha256', key).update(raw).digest());
}

export function deliveryDigest(raw: Buffer) { return createHash('sha256').update(raw).digest('hex'); }

class GitHubUnavailable extends Error {
  readonly retryAt?:string;
  constructor(retryAt?:string) { super('GitHub request unavailable'); this.retryAt=retryAt; }
}

function retryTime(response: Response, now: number) {
  const retry = response.headers.get('retry-after');
  const reset = response.headers.get('x-ratelimit-reset');
  const numeric = retry !== null && /^\d{1,7}$/.test(retry) ? now + Number(retry) * 1000 : NaN;
  const next = Number.isFinite(numeric) ? numeric : reset !== null && /^\d{1,12}$/.test(reset) ? Number(reset) * 1000 : now + 60_000;
  return new Date(Math.min(now + 86400_000, Math.max(next, now + 15_000))).toISOString();
}

type Issue = {number?: unknown; title?: unknown; pull_request?: unknown};
type Release = {tag_name?: unknown; published_at?: unknown};
type Deployment = {id?: unknown};
type Commit = {sha?: unknown; commit?: {message?: unknown; committer?: {date?: unknown} | null}};
type Branch = {name?: unknown; commit?: {sha?: unknown}};
type Pull = {number?: unknown; title?: unknown; state?: unknown; merged_at?: unknown; updated_at?: unknown};
const gitSha = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function records<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new Error('Unexpected GitHub response');
  return value.filter(item => item && typeof item === 'object') as T[];
}

function unique<T>(items:T[], key:(item:T)=>string|number) {
  const seen=new Set<string|number>();
  return items.filter(item=>{
    const id=key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function retainRepositorySnapshot(next:RepositorySnapshot, previous?:RepositorySnapshot) {
  if (next.state==='connected') return {...next,lastSuccessfulAt:next.checkedAt};
  const lastSuccessfulAt=previous?.lastSuccessfulAt ?? (previous?.state==='connected' ? previous.checkedAt : undefined);
  return previous && lastSuccessfulAt ? {...previous,...next,lastSuccessfulAt} : next;
}

async function readGitHubJson(response:Response) {
  const reader=response.body?.getReader();
  if (!reader) throw new Error('Empty GitHub response');
  let size=0, body='';
  const decoder=new TextDecoder('utf-8',{fatal:true});
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if (done) return JSON.parse(body+decoder.decode());
      size+=value.length;
      if (size>2*1024*1024) {await reader.cancel();throw new Error('GitHub response exceeds size limit');}
      body+=decoder.decode(value,{stream:true});
    }
  } finally {reader.releaseLock();}
}

async function githubGet(repository:string,path:string,token:string,request:typeof fetch,now:number) {
  const result=await request('https://api.github.com/repos/'+repository+path,{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},
    cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8500),
  });
  if (!result.ok) {
    const limited=result.status===429 || (result.status===403 &&
      (result.headers.has('retry-after') || result.headers.get('x-ratelimit-remaining')==='0'));
    await result.body?.cancel();
    throw new GitHubUnavailable(limited?retryTime(result,now):undefined);
  }
  const more=/(?:^|,)\s*<[^>]+>;\s*rel="next"/i.test(result.headers.get('link')??'');
  return {body:await readGitHubJson(result),more};
}

export async function readGitHubBackfillPage(repository:string, kind:'commits'|'issues', page:number, anchor:string,
  token:string, request=fetch) {
  const suffix=kind==='commits' ? '&until='+encodeURIComponent(anchor) : '&state=open&sort=created&direction=asc';
  const {body,more}=await githubGet(repository,'/'+kind+'?per_page=10&page='+page+suffix,token,request,Date.now());
  const items=kind==='commits'
    ? records<Commit>(body).flatMap(({sha,commit})=>gitSha(sha)&&typeof commit?.message==='string'
      ? [{sha,subject:redactCredentials(commit.message.split(/\r?\n/,1)[0]).slice(0,160),committedAt:timestamp(commit.committer?.date)}]:[])
    : records<Issue>(body).flatMap(({number,title,pull_request})=>!pull_request&&typeof number==='number'
      && Number.isSafeInteger(number)&&number>0&&typeof title==='string'
      ? [{number,title:redactCredentials(title.slice(0,160))}]:[]);
  return {items,more};
}

export async function syncRepository(repository: string, token: string, request = fetch, clock = new Date(), backfill = false): Promise<RepositorySnapshot> {
  const checkedAt = clock.toISOString();
  async function query(path: string): Promise<unknown> {
    return (await githubGet(repository,path,token,request,clock.getTime())).body;
  }

  async function activity<T>(path: string, params = '') {
    const items: T[] = [];
    for (let page = 1; page <= (backfill ? 3 : 1); page++) {
      const batch = records<T>(await query(path + '?per_page=10&page=' + page + params));
      items.push(...batch.slice(0,10));
      if (batch.length < 10) break;
    }
    return items;
  }
  try {
    // A repository quota response avoids launching follow-up requests.
    const overview = await query('') as { pushed_at?: unknown; open_issues_count?: unknown };
    const [issueItems, releaseItems, deployItems, commitItems, branchItems, pullItems] = await Promise.all([
      activity<Issue>('/issues','&state=open'), query('/releases?per_page=5'), query('/deployments?per_page=1'),
      activity<Commit>('/commits'), activity<Branch>('/branches'), activity<Pull>('/pulls','&state=all&sort=updated&direction=desc'),
    ]);
    const issues = issueItems.filter(issue => !issue.pull_request && typeof issue.number === 'number'
      && Number.isSafeInteger(issue.number) && typeof issue.title === 'string')
      .map(issue => ({number:issue.number as number, title:redactCredentials((issue.title as string).slice(0,160))}));
    const releases = records<Release>(releaseItems).filter(release => typeof release.tag_name === 'string').slice(0,5)
      .map(release => ({tag:redactCredentials((release.tag_name as string).slice(0,100)),
        publishedAt:typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)) ? release.published_at : null}));
    const commits=commitItems.flatMap(({sha,commit})=>gitSha(sha) && typeof commit?.message === 'string'
      ? [{sha,subject:redactCredentials(commit.message.split(/\r?\n/,1)[0]).slice(0,160),committedAt:timestamp(commit.committer?.date)}] : []);
    const branches=branchItems.flatMap(({name,commit})=>gitSha(commit?.sha) && typeof name==='string'
      ? [{name:redactCredentials(name).slice(0,120),sha:commit.sha}] : []);
    const pullRequests=pullItems.flatMap<NonNullable<RepositorySnapshot['pullRequests']>[number]>(({number,title,state,merged_at,updated_at})=>{
      if (typeof number!=='number' || !Number.isSafeInteger(number) || number<1 || typeof title!=='string'
        || (state!=='open' && state!=='closed')) return [];
      const status=timestamp(merged_at) ? 'merged' : state;
      return [{number,title:redactCredentials(title).slice(0,160),status,updatedAt:timestamp(updated_at)}];
    });
    const deploymentId = records<Deployment>(deployItems)[0]?.id;
    let latestDeployment: RepositorySnapshot['latestDeployment'] = null;
    if (typeof deploymentId === 'number' && Number.isSafeInteger(deploymentId) && deploymentId > 0) {
      const statuses = records<{state:unknown}>(await query('/deployments/' + deploymentId + '/statuses?per_page=1'));
      const initial = statuses[0]?.state;
      const state = typeof initial === 'string' && ['error','failure','inactive','in_progress','queued','pending','success'].includes(initial)
        ? initial : 'unknown';
      latestDeployment = {id:deploymentId, state};
    }
    return {
      repository, checkedAt, state:'connected',
      updatedAt:typeof overview?.pushed_at === 'string' && Number.isFinite(Date.parse(overview.pushed_at)) ? overview.pushed_at : undefined,
      openIssues:typeof overview?.open_issues_count === 'number' && Number.isSafeInteger(overview.open_issues_count) ? overview.open_issues_count : undefined,
      issues:unique(issues,item=>item.number),commits:unique(commits,item=>item.sha),
      branches:unique(branches,item=>item.name),pullRequests:unique(pullRequests,item=>item.number),releases,latestDeployment,
    };
  } catch (error) {
    const retryAt = error instanceof GitHubUnavailable ? error.retryAt : undefined;
    return { repository, checkedAt, state:retryAt ? 'rate_limited' : 'unknown', retryAt };
  }
}
