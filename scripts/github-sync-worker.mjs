#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { closeDatabase, postgresConfigured, sql } from './database.mjs';
import { loadWorkerModule } from './worker-module.mjs';

const { githubBindings, readGitHubBackfillPage, syncRepository } = await loadWorkerModule('../src/lib/server/github.ts');

function merge(list, page, key) {
  return [...new Map([...list,...page].map(item=>[item[key],item])).values()];
}

export async function runGitHubSync(bindings, key, {request=fetch,limit=40,signal}={}) {
  let processed=0, completed=0;
  for (const {workspaceId,projectId,repository} of bindings) {
    for (let i=0;i<limit&&!signal?.aborted;i++) {
      const lease=randomUUID();
      const args=[workspaceId,projectId,repository,lease];
      const {job}=await sql.one('SELECT public.projectos_github_claim(?,?,?,?) AS job',...args);
      if (!job) break;
      const settle=async (stage,page,payload,failure=null,retry=null)=>await sql.one(
        'SELECT public.projectos_github_settle(?,?,?,?,?,?,?::jsonb,?,?) AS settled',
      ...args,stage,page,JSON.stringify(payload),failure,retry);
      let next, checkpoint;
      try {
        if (job.stage==='overview') {
          const base=await syncRepository(repository,key,request);
          if (base.state!=='connected') throw Object.assign(new Error('Provider unavailable'),{retryAt:base.retryAt});
          checkpoint={...base,commits:[],issues:[]};
          next={stage:'commits',page:1};
        } else {
          const page=await readGitHubBackfillPage(repository,job.stage,job.page,job.anchor,key,request);
          if (page.more && job.page===100) {
            await settle(null,null,{},'page_limit');
            break;
          }
          checkpoint={...job.payload,[job.stage]:merge(job.payload[job.stage],page.items,job.stage==='commits'?'sha':'number')};
          next=page.more ? {stage:job.stage,page:job.page+1} : {stage:job.stage==='commits'?'issues':'done',page:1};
        }
      } catch (error) {
        const providerDelay=error?.retryAt ? Math.ceil((Date.parse(error.retryAt)-Date.now())/1000) : 0;
        await settle(null,null,{},providerDelay>0?'rate_limited':'provider',Math.max(providerDelay,15*2**(job.failures-1)));
        break;
      }
      if (Buffer.byteLength(JSON.stringify(checkpoint))>850_000) {
        await settle(null,null,{},'page_limit');
        break;
      }
      if (!(await settle(next.stage,next.page,checkpoint)).settled) break;
      processed++;
      if (next.stage==='done') completed++;
    }
  }
  return {processed,completed};
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const stop=new AbortController();
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>stop.abort());
  try {
    const token=process.env.PROJECTOS_GITHUB_TOKEN;
    const bindings=githubBindings();
    if (!postgresConfigured() || !token || !bindings.length) throw new Error('Worker requires PostgreSQL and server configuration');
    do {
      console.log(JSON.stringify(await runGitHubSync(bindings,token,{signal:stop.signal})));
      if (process.argv.includes('--once') || stop.signal.aborted) break;
      await delay(15_000,undefined,{signal:stop.signal});
    } while (!stop.signal.aborted);
  } catch (error) {
    if (!stop.signal.aborted) { console.error('GitHub worker unavailable:',error.code??error.name);process.exitCode=1; }
  } finally {await closeDatabase();}
}
