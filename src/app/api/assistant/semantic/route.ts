import { NextRequest,NextResponse } from 'next/server';
import { checkOrigin,getCurrentAccount,rateLimit,readLimitedJson } from '@/lib/server/auth';
import { apiError,jsonError,noStore } from '@/lib/server/http';
import { validRecordId } from '@/lib/record-contract';
import { suspiciousCredential } from '@/lib/server/credential-guard';
import { rebuildSemanticIndex,semanticSearch } from '@/lib/server/semantic-search';
import { MissingRecordError } from '@/lib/server/record-service';
import { ForbiddenError } from '@/lib/server/db';

export const runtime='nodejs';

export async function POST(request:NextRequest) {
  if (!checkOrigin(request)) return apiError('Origin rejected',403);
  const account=await getCurrentAccount();
  if (!account) return apiError('Unauthenticated',401);
  let input:unknown;
  try {input=await readLimitedJson(request,2000);}
  catch (error) {return jsonError(error);}
  if (!input || typeof input!=='object' || Array.isArray(input)) return apiError('Invalid request',422);
  const {action,projectId,question,after} =input as Record<string,unknown>;
  if (!validRecordId(projectId) || (action!=='rebuild' && action!=='query')) return apiError('Invalid request',422);
  if (action==='rebuild' && account.role!=='owner') return apiError('Forbidden',403);
  if (action==='query' && (typeof question!=='string' || question.trim().length<2 || question.length>400 || suspiciousCredential(question))) {
    return apiError('Invalid question',422);
  }
  if (after!==undefined && after!=='' && !validRecordId(after)) return apiError('Invalid cursor',422);
  const limit=await rateLimit('semantic:'+action,account.id,action==='rebuild'?10:20,60_000);
  if (!limit.allowed) return apiError('Try again later',429,{'Retry-After':String(limit.retryAfter)});
  try {
    if (action==='rebuild') return NextResponse.json(await rebuildSemanticIndex(account,projectId,String(after??'')),{headers:noStore});
    const citations=await semanticSearch(account,projectId,String(question));
    return NextResponse.json({citations,answer:citations.length?'قطعه‌های مرتبط از اسناد پروژه پیدا شدند.':
      'در اسناد نمایه‌شده شواهد کافی پیدا نشد.',mode:'semantic',externalTransmission:false},{headers:noStore});
  } catch (error) {
    if (error instanceof MissingRecordError) return apiError('Not found',404);
    if (error instanceof ForbiddenError) return apiError('Forbidden',403);
    return apiError('Local semantic search unavailable',503);
  }
}
