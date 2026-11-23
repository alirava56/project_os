#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { closeDatabase,postgresConfigured,sql } from './database.mjs';
import { loadWorkerModule } from './worker-module.mjs';

const {getUsdIrr}=await loadWorkerModule('../src/lib/server/currency-provider.ts');

export async function runCurrencyCycle(workspace,key,request=fetch) {
  const token=randomUUID();
  if (!(await sql.one('SELECT public.projectos_currency_claim(?,?) AS job',workspace,token)).job) return 'idle';
  const rate=await getUsdIrr(key,request);
  const accepted=await sql.one('SELECT public.projectos_currency_settle(?,?,?,?,?,?) AS settled',workspace,token,rate.status,
    rate.rate??null,rate.observedAt??null,rate.retryAfter??null);
  return accepted.settled?rate.status:'lost_lease';
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const stop=new AbortController();
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>stop.abort());
  try {
    const workspace=process.env.PROJECTOS_CURRENCY_WORKSPACE;
    const key=process.env.PROJECTOS_CURRENCYAPI_KEY;
    if (!postgresConfigured() || !workspace || !key || process.env.PROJECTOS_CURRENCYAPI_ENABLED!=='enabled') {
      throw new Error('Scheduled exchange rates are not configured');
    }
    do {
      console.log(JSON.stringify({status:await runCurrencyCycle(workspace,key)}));
      if (process.argv.includes('--once') || stop.signal.aborted) break;
      await delay(30_000,undefined,{signal:stop.signal});
    } while (!stop.signal.aborted);
  } catch (error) {
    if (!stop.signal.aborted) {console.error('Currency worker unavailable:',error.code??error.name);process.exitCode=1;}
  } finally {await closeDatabase();}
}
