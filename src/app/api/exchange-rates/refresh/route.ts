import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { checkOrigin,getCurrentAccount,rateLimit,readLimitedJson } from '@/lib/server/auth';
import { loadRecord,loadState,projectPolicy,readTransaction,recordReadTable,storedRecord } from '@/lib/server/db';
import { invalidRecordBody,recordError,recordFailure,recordHeaders } from '@/lib/server/record-http';
import { commitRecordChanges } from '@/lib/server/record-service';
import { getUsdIrr,providerName,quoteMaxAge } from '@/lib/server/currency-provider';
import { validRecordId } from '@/lib/record-contract';

export const runtime='nodejs';

export async function GET(request:NextRequest) {
  const account=await getCurrentAccount();
  if (!account) return recordError('Unauthenticated',401);
  const project=request.nextUrl.searchParams.get('projectId');
  if (!validRecordId(project)) return recordError('Invalid project',422);
  try {
    const result=await readTransaction(async db=>{
      const policy=await projectPolicy(db,account);
      if ((policy.projectIds && !policy.projectIds.has(project)) || !await storedRecord(db,account.workspaceId,'projects',project)) return;
      const status=db.scopeIdentity ? (await db.one<{info:unknown}>(
        'SELECT public.projectos_currency_status(?) AS info',project))?.info : null;
      const jsonSource=db.dialect==='postgres'?"payload::jsonb->>'source'":"json_extract(payload,'$.source')";
      const row=await db.one<{payload:string}>(`SELECT payload FROM ${recordReadTable(db)} WHERE workspace_id=? AND project_id=?
        AND kind='exchangeRates' AND ${jsonSource}='currencyapi' ORDER BY updated_at DESC,id LIMIT 1`,account.workspaceId,project);
      return {schedule:status??null,quote:row ? JSON.parse(row.payload) : null};
    });
    return result ? NextResponse.json(result,{headers:recordHeaders}) : recordError('Not found',404);
  } catch (error) {return recordFailure(error);}
}

export async function POST(request:NextRequest) {
  if (!checkOrigin(request)) return recordError('Origin rejected',403);
  const account=await getCurrentAccount();
  if (!account) return recordError('Unauthenticated',401);
  if (account.role!=='owner') return recordError('Forbidden',403);
  let input:unknown;
  try {input=await readLimitedJson(request,1024);}
  catch (error) {return invalidRecordBody(error);}
  if (!input || typeof input!=='object' || !('projectId' in input) || !validRecordId(input.projectId)) return recordError('Invalid project',422);
  const projectId=input.projectId;
  try {
    if (!await loadRecord(account,'projects',projectId)) return recordError('Not found',404);
    const key=process.env.PROJECTOS_CURRENCYAPI_KEY;
    if (!key || process.env.PROJECTOS_CURRENCYAPI_ENABLED!=='enabled') return recordError('Provider is not configured',503);
    const before=await loadState(account);
    const now=Date.now();
    const cached=before.data.exchangeRates.find(rate=>rate.projectId===projectId && rate.source===providerName
      && rate.from==='USD' && rate.to==='IRR' && rate.receivedAt
      && now-Date.parse(rate.receivedAt)<3600_000 && now-Date.parse(rate.observedAt)<=quoteMaxAge);
    if (cached) return NextResponse.json(cached,{headers:recordHeaders});
    const quota=await rateLimit('currencyapi:refresh',account.workspaceId,3,60_000);
    if (!quota.allowed) return NextResponse.json({error:'Rate limited'},{status:429,headers:{...recordHeaders,'Retry-After':String(quota.retryAfter)}});
    const quote=await getUsdIrr(key);
    if (quote.status!=='ok') return NextResponse.json({error:'Provider unavailable'},{status:quote.status==='rate_limited'?429:503,
      headers:{...recordHeaders,...(quote.retryAfter===undefined?{}:{'Retry-After':String(quote.retryAfter)})}});
    const id='rate-'+createHash('sha256').update(JSON.stringify([projectId,quote.observedAt,quote.rate])).digest('hex').slice(0,32);
    const current=await loadState(account);
    const existing=current.data.exchangeRates.find(rate=>rate.id===id);
    if (existing) return NextResponse.json(existing,{headers:recordHeaders});
    const record={id,projectId,from:'USD',to:'IRR',source:providerName,rate:quote.rate,observedAt:quote.observedAt,receivedAt:quote.receivedAt};
    await commitRecordChanges(account,current.version,[{kind:'exchangeRates',id,action:'create',record}],undefined,false,'currency-provider');
    return NextResponse.json(record,{headers:recordHeaders});
  } catch (error) {return recordFailure(error);}
}
