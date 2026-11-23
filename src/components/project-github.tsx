'use client';

import { useEffect, useState } from 'react';
import { dateLabel } from '@/lib/format';
import type { RepositorySnapshot } from '@/lib/server/github';
import { Empty, Panel, Pill } from './ui';

type ProjectRepository = Omit<RepositorySnapshot,'checkedAt'> & { checkedAt: string | null };
const states: Record<RepositorySnapshot['state'], string> = {
  connected:'دریافت موفق', unknown:'نامشخص', stale:'دادهٔ قدیمی',
  rate_limited:'محدودیت نرخ', pending_refresh:'در انتظار همگام‌سازی',
};
const jobLabels:Record<string,string>={pending:'در صف',running:'در حال پردازش',backoff:'در انتظار تلاش مجدد',
  completed:'همگام‌سازی خودکار کامل شد',failed:'همگام‌سازی خودکار ناموفق'};
const phaseLabels:Record<string,string>={overview:'خلاصهٔ مخزن',commits:'Commitها',issues:'Issueها'};
const pullStates={open:'باز',closed:'بسته',merged:'ادغام‌شده'};
function time(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value))
    ? dateLabel(value,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : 'زمان نامشخص';
}

export function ProjectGitHub({ projectId }: { projectId: string }) {
  const [repositories,setRepositories]=useState<ProjectRepository[] | null>();
  useEffect(()=>{
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout> | undefined;
    const refresh=()=>fetch('/api/integrations/github?projectId='+encodeURIComponent(projectId),{cache:'no-store',signal:controller.signal})
      .then(async response=>{
        if(!response.ok) throw new Error('GitHub data unavailable');
        const payload=await response.json() as {repositories:ProjectRepository[]};
        if(!controller.signal.aborted) setRepositories(payload.repositories);
      }).catch(()=>{if(!controller.signal.aborted) setRepositories(null);}).finally(()=>{
        if(!controller.signal.aborted) timer=setTimeout(refresh,15_000);
      });
    void refresh();
    return ()=>{controller.abort();clearTimeout(timer);};
  },[projectId]);

  return <Panel title="فعالیت GitHub">
    {repositories===undefined && <p role="status" className="muted">در حال دریافت داده‌های مخزن…</p>}
    {repositories===null && <p role="alert" className="form-error">داده‌های GitHub قابل دریافت نیست.</p>}
    {repositories?.length===0 && <Empty title="مخزنی برای پروژه تنظیم نشده است" />}
    {repositories?.map(repo=><section key={repo.repository} className="form-stack">
      <div className="flex flex-wrap items-center gap-2">
        <a className="cell-link" href={'https://github.com/'+repo.repository} target="_blank" rel="noopener noreferrer">
          <bdi dir="ltr">{repo.repository}</bdi>
        </a>
        <Pill tone={repo.state==='connected'?'good':'neutral'}>{states[repo.state] ?? states.unknown}</Pill>
        <small className="muted">آخرین بررسی API · {time(repo.checkedAt)}</small>
        {repo.state!=='connected' && repo.lastSuccessfulAt && <small className="muted">آخرین دادهٔ موفق · {time(repo.lastSuccessfulAt)}</small>}
      </div>
      {repo.job && <p className="muted" aria-live="polite">{jobLabels[repo.job.state]}
        {['running','pending','backoff'].includes(repo.job.state) && <> · {phaseLabels[repo.job.stage]} · صفحهٔ {repo.job.page}</>}
        {repo.job.error==='rate_limited' && <> · محدودیت نرخ</>}
      </p>}
      {!!repo.commits?.length && <details><summary>Commitها</summary><ul>{repo.commits.map(commit=>
        <li key={commit.sha}><bdi>{commit.subject}</bdi> · <bdi dir="ltr">{commit.sha.slice(0,8)}</bdi> · {time(commit.committedAt)}</li>
      )}</ul></details>}
      {!!repo.branches?.length && <details><summary>شاخه‌ها</summary><ul>{repo.branches.map(branch=>
        <li key={branch.name}><bdi dir="ltr">{branch.name}</bdi> · <bdi dir="ltr">{branch.sha.slice(0,8)}</bdi></li>
      )}</ul></details>}
      {!!repo.pullRequests?.length && <details><summary>درخواست‌های ادغام</summary><ul>{repo.pullRequests.map(pull=>
        <li key={pull.number}><bdi dir="ltr">#{pull.number}</bdi> <bdi>{pull.title}</bdi> · {pullStates[pull.status]} · {time(pull.updatedAt)}</li>
      )}</ul></details>}
      {!!repo.issues?.length && <details><summary>Issueهای باز</summary><ul>{repo.issues.map(issue=>
        <li key={issue.number}><bdi dir="ltr">#{issue.number}</bdi> <bdi>{issue.title}</bdi></li>
      )}</ul></details>}
    </section>)}
  </Panel>;
}
