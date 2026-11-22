import { createHash } from 'node:crypto';
import { NextRequest,NextResponse } from 'next/server';
import { checkOrigin,getCurrentAccount,readLimitedJson } from '@/lib/server/auth';
import { loadState } from '@/lib/server/db';
import { invalidRecordBody,recordError,recordFailure,recordHeaders } from '@/lib/server/record-http';
import { commitRecordChanges } from '@/lib/server/record-service';
import { validRecordId } from '@/lib/record-contract';
import { splitSharedCost } from '@/lib/shared-cost';

export const runtime='nodejs';

export async function POST(request:NextRequest) {
  if (!checkOrigin(request)) return recordError('Origin rejected',403);
  const account=await getCurrentAccount();
  if (!account) return recordError('Unauthenticated',401);
  if (account.role!=='owner') return recordError('Forbidden',403);
  let input:unknown;
  try {input=await readLimitedJson(request,2048);}
  catch (error) {return invalidRecordBody(error);}
  if (!input || typeof input!=='object' || Array.isArray(input)) return recordError('Invalid allocation',422);
  const {resourceId,title,amount,currency,date,reference}=input as Record<string,unknown>;
  if (!validRecordId(resourceId) || typeof title!=='string' || !title.trim() || typeof amount!=='number'
    || !Number.isSafeInteger(amount) || amount<1 || amount>1e12 || typeof reference!=='string'
    || !/^[a-f0-9-]{36}$/.test(reference) || !['USD','IRR','TOMAN'].includes(String(currency))) {
    return recordError('Invalid allocation',422);
  }
  try {
    const snapshot=await loadState(account);
    const resource=snapshot.data.resources.find(item=>item.id===resourceId);
    if (!resource) return recordError('Not found',404);
    const parts=splitSharedCost(BigInt(amount),[resource.projectId,...(resource.linkedProjectIds??[])]);
    if (!parts.length) return recordError('Shared projects and enough minor units are required',422);
    const group=createHash('sha256').update(reference).digest('hex').slice(0,32);
    const changes=parts.map(({projectId,amount},index)=>{
      const id='split-'+group+'-'+index;
      const record={id,projectId,amount:Number(amount),title:title.trim(),date,currency,amountUnit:'minor',
        category:resource.type==='domain'?'دامنه':'زیرساخت',status:'upcoming'};
      return {kind:'expenses',action:'create',id,record};
    });
    await commitRecordChanges(account,snapshot.version,changes,undefined,true,'shared-cost');
    return NextResponse.json({shares:parts.length},{status:201,headers:recordHeaders});
  } catch (error) {return recordFailure(error);}
}
