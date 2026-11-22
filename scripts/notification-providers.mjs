import { suspiciousCredential } from '../src/lib/server/credential-guard.ts';

const types = { 'Content-Type':'application/json' };
const transient = status => status >= 500 && status <= 599;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let body = '', length = 0;
  try {
    for (;;) {
      const {value,done} = await reader.read();
      if (done) return JSON.parse(body + decoder.decode());
      length += value.length;
      if (length > 16 * 1024) { await reader.cancel(); return; }
      body += decoder.decode(value, {stream:true});
    }
  } catch { return; }
  finally { reader.releaseLock(); }
}

function retryDelay(response, seconds, now) {
  const header = response.headers.get('Retry-After') ?? '';
  const headerMs = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
  const bodyMs = typeof seconds === 'number' && seconds > 0 ? seconds * 1000 : 0;
  return Math.max(Number.isNaN(headerMs) ? 0 : headerMs, bodyMs, 0);
}

function rejection(response, status, seconds) {
  if (status === 429) return {kind:'retry', reason:'rate_limited', retryMs:retryDelay(response, seconds, Date.now())};
  if (transient(status)) return {kind:'retry', reason:'provider_unavailable', retryMs:retryDelay(response, undefined, Date.now())};
  if (status === 401 || status === 403) return {kind:'failed', reason:'provider_permission'};
  if ([400,404,422].includes(status)) return {kind:'failed', reason:'provider_rejected'};
  return {kind:'unknown',reason:'outcome_unknown'};
}

export function safeLabel(value) {
  if (typeof value !== 'string' || suspiciousCredential(value)) return '';
  const clean = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').trim();
  return Array.from(clean).slice(0,140).join('');
}

function dateText(scheduled) {
  if (typeof scheduled !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T[0-9:.+-]+Z?)?$/.test(scheduled)) return 'نامشخص';
  const date = new Date(scheduled);
  if (!Number.isFinite(date.getTime())) return 'نامشخص';
  const timed = scheduled.includes('T');
  return new Intl.DateTimeFormat('fa-IR', {
    dateStyle:'long', ...(timed ? {timeStyle:'short'} : {}), timeZone:timed ? 'Asia/Tehran' : 'UTC',
  }).format(date);
}

function textMessage(date) {
  return 'یک یادآوری برای ' + date + ' ثبت شده است. برای مشاهدهٔ جزئیات وارد ProjectOS شوید.';
}

function address(value) {
  return typeof value === 'string' && value.length <= 254
    && /^[A-Za-z0-9.!#$%&'*+/=?^_{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)
    && !value.split('@')[0].split('.').some(part => !part);
}

export function configuredChannels(env, send = fetch, timeoutMs = 10_000) {
  const channels = {};
  const telegram = env.PROJECTOS_TELEGRAM_BOT_TOKEN;
  const chat = env.PROJECTOS_TELEGRAM_CHAT_ID;
  const key = env.PROJECTOS_RESEND_API_KEY;
  const options = () => ({method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(timeoutMs)});
  if (env.PROJECTOS_TELEGRAM_NOTIFICATIONS === 'enabled' && /^\d{5,}:[a-zA-Z0-9_-]{20,}$/.test(telegram ?? '')
    && /^-?\d{4,20}$/.test(chat ?? '')) {
    channels.telegram = async ({scheduled_for,telegram_title,telegram_project}) => {
      const content = [textMessage(dateText(scheduled_for))];
      if (env.PROJECTOS_TELEGRAM_PROJECT_DETAILS === 'enabled') {
        const project = safeLabel(telegram_project), title = safeLabel(telegram_title);
        if (project) content.push('پروژه ' + project);
        if (title) content.push('هشدار ' + title);
      }
      try {
        const response = await send('https://api.telegram.org/bot' + telegram + '/sendMessage', {
          ...options(),headers:types,body:JSON.stringify({chat_id:chat,text:content.join('\n'),link_preview_options:{is_disabled:true}}),
        });
        const body = await boundedJson(response);
        const id = body?.result?.message_id;
        if (response.ok && body?.ok === true && Number.isSafeInteger(id) && id > 0) return {kind:'accepted',id:String(id)};
        const status = response.ok && body?.ok === false ? body.error_code : response.status;
        return rejection(response,status,body?.parameters?.retry_after);
      } catch { return {kind:'unknown',reason:'outcome_unknown'}; }
    };
  }
  if (env.PROJECTOS_EMAIL_NOTIFICATIONS === 'enabled' && /^[A-Za-z0-9_-]{8,256}$/.test(key ?? '')
    && address(env.PROJECTOS_EMAIL_FROM) && address(env.PROJECTOS_EMAIL_TO)) {
    channels.email = async ({id,scheduled_for}) => {
      const text = textMessage(dateText(scheduled_for));
      try {
        const response = await send('https://api.resend.com/emails', {
          ...options(),headers:{...types,Authorization:'Bearer ' + key,'Idempotency-Key':id},
          body:JSON.stringify({from:env.PROJECTOS_EMAIL_FROM,to:[env.PROJECTOS_EMAIL_TO],
            subject:'یادآوری ProjectOS',text,html:'<div lang="fa" dir="rtl"><p>' + text + '</p></div>'}),
        });
        if (!response.ok) {
          await response.body?.cancel();
          return rejection(response,response.status);
        }
        const body = await boundedJson(response);
        if (typeof body?.id === 'string' && uuid.test(body.id)) return {kind:'accepted',id:body.id};
        return {kind:'unknown',reason:'outcome_unknown'};
      } catch { return {kind:'unknown',reason:'outcome_unknown'}; }
    };
  }
  return channels;
}
