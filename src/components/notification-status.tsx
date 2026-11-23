'use client';

import { useEffect, useState } from 'react';
import { dateLabel } from '@/lib/format';

type Delivery = {channel:string; status:string; scheduledFor:string | null; acceptedAt:string | null; retryAt:string | null; reason:string | null};
type Worker = {name:string; status:string; checkedAt:string | null};
type Status = {delivery?:Delivery[]; workers?:Worker[]};
const deliveryLabels: Record<string,string> = {
  available:'در برنامه قابل مشاهده است', pending:'در صف', sending:'در حال ارسال',
  accepted:'پذیرفته‌شده توسط ارائه‌دهنده', retrying:'در انتظار تلاش مجدد', failed:'ارسال ناموفق',
  cancelled:'لغوشده', unknown:'نتیجهٔ ارسال نامعلوم است',
};
const reasons: Record<string,string> = {rate_limited:'محدودیت نرخ ارائه‌دهنده',provider_unavailable:'اختلال ارائه‌دهنده',
  provider_permission:'رد دسترسی ارائه‌دهنده',provider_rejected:'رد درخواست توسط ارائه‌دهنده',outcome_unknown:'پاسخ قطعی دریافت نشد'};
const channelLabels: Record<string,string> = {in_app:'درون برنامه',telegram:'تلگرام',email:'ایمیل'};
const workerNames: Record<string,string> = {reminders:'زمان‌بند',delivery:'ارسال اعلان'};
const workerLabels: Record<string,string> = {recent:'اجرای اخیر ثبت شده',stale:'آخرین اجرا قدیمی است',unobserved:'هنوز اجرایی در این فضا ثبت نشده'};

export function NotificationStatus({alert, zone}: {alert?:string;zone:string}) {
  const [status,setStatus] = useState<Status>();
  const [error,setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const url = '/api/notifications' + (alert ? '?alert=' + encodeURIComponent(alert) : '');
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function update() {
      try {
        const response = await fetch(url,{cache:'no-store',signal:controller.signal});
        if (!response.ok) throw new Error('Notification status unavailable');
        const data = await response.json() as Status;
        if (!controller.signal.aborted) { setStatus(data); setError(''); }
      } catch {
        if (!controller.signal.aborted) setError('خواندن وضعیت اعلان ممکن نشد.');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(update,15_000);
      }
    }
    void update();
    return () => { controller.abort(); clearTimeout(timer); };
  },[alert]);

  function time(value:string) {
    return dateLabel(value,{month:'short',day:'numeric',...(value.includes('T') ? {hour:'2-digit',minute:'2-digit'} : {})},zone);
  }

  return <div className="stack" aria-live="polite">
    {error ? <p className="form-error">{error}</p> : !status ? <p className="muted">در حال خواندن وضعیت اعلان…</p> : <>
      {status.delivery && (status.delivery.length ? <ul aria-label="وضعیت ارسال اعلان">{status.delivery.map((job,index) =>
        <li className="muted" key={job.channel + '-' + index}>
          <strong>{channelLabels[job.channel] ?? job.channel}</strong> · {deliveryLabels[job.status] ?? 'نامشخص'}{job.scheduledFor && <> · {time(job.scheduledFor)}</>}
          {job.reason && reasons[job.reason] && <> · {reasons[job.reason]}</>}
          {job.retryAt && <> · تلاش بعدی {time(job.retryAt)}</>}
          {job.acceptedAt && <> · زمان پذیرش {time(job.acceptedAt)}</>}
        </li>)}</ul> : <p className="muted">برای این هشدار اعلانی ثبت نشده است.</p>)}
      {status.workers && <ul aria-label="وضعیت اجرای پردازشگرها">{status.workers.map(worker =>
        <li className="muted" key={worker.name}><strong>{workerNames[worker.name]}</strong> · {workerLabels[worker.status]}
          {worker.checkedAt && <> · {time(worker.checkedAt)}</>}</li>)}</ul>}
    </>}
  </div>;
}
