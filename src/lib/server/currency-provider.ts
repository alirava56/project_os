import { parseRate } from '../exchange-rate';

export const quoteMaxAge = 48*60*60_000;
export const providerName='currencyapi';
const endpoint='https://api.currencyapi.com/v3/latest?base_currency=USD&currencies=IRR';

export async function getUsdIrr(apiKey:string, fetcher=fetch, now=Date.now()) {
  try {
    const response=await fetcher(endpoint,{headers:{apikey:apiKey},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)});
    if (!response.ok) {
      await response.body?.cancel();
      const header=response.headers.get('retry-after') ?? '';
      return {status:response.status===429?'rate_limited':'unavailable',
        retryAfter:/^\d{1,7}$/.test(header)?Number(header):undefined} as const;
    }
    const reader=response.body?.getReader();
    if (!reader) return {status:'unavailable'} as const;
    const decoder=new TextDecoder('utf8',{fatal:true});
    let raw='', size=0;
    try {
      for (;;) {
        const {done,value}=await reader.read();
        if (done) break;
        size+=value.length;
        if (size>8192) {await reader.cancel();return {status:'unavailable'} as const;}
        raw+=decoder.decode(value,{stream:true});
      }
      raw+=decoder.decode();
    } finally {reader.releaseLock();}
    const body=JSON.parse(raw,(key,value,context?:{source?:string})=>
      key==='value' && typeof value==='number' ? context?.source : value);
    const entry=body?.data?.IRR;
    const rate=typeof entry?.value==='string' && parseRate(entry.value);
    const observed=typeof body?.meta?.last_updated_at==='string' ? Date.parse(body.meta.last_updated_at) : NaN;
    if (entry?.code!=='IRR' || !rate || !Number.isFinite(observed) || observed>now || now-observed>quoteMaxAge) {
      return {status:'unavailable'} as const;
    }
    return {status:'ok',rate:rate.text,observedAt:new Date(observed).toISOString(),receivedAt:new Date(now).toISOString()} as const;
  } catch {return {status:'unavailable'} as const;}
}
