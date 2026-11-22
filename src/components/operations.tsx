'use client';

import { useEffect, useState } from 'react';
import { Activity, Bell, Check, CircleAlert, Clock3, Radio, RefreshCw } from 'lucide-react';
import { afterHours, dateLabel, matches, number, resourceHref } from '@/lib/format';
import { choices, incidentStates, priorities, priorityTones } from '@/lib/labels';
import { machineObservationFresh, type MachineObservation } from '@/lib/monitoring';
import { availabilityTarget, type sampledAvailability } from '@/lib/slo';
import { savePreferences, useDemo } from '@/lib/store';
import type { Incident } from '@/lib/types';
import { ProjectFilter, projectName } from './forms';
import { NotificationStatus } from './notification-status';
import { Button, Callout, Empty, Filter, Heading, Metrics, Modal, Panel, Pill, Row, SearchField, Switch, TextLink } from './ui';

export function Monitoring() {
  const { data }=useDemo();
  const [query,setQuery]=useState('');
  const [observations,setObservations]=useState<Array<{resourceId:string;checkedAt:string;state:string;statusCode:number|null;latencyMs:number|null;tlsExpiresAt:string|null;diagnostic:string|null}>>([]);
  const [machine,setMachine]=useState<MachineObservation[]>([]);
  const [availability,setAvailability]=useState<ReturnType<typeof sampledAvailability>>([]);
  const [monitorStatus,setMonitorStatus]=useState<'loading'|'not_configured'|'configured'|'error'>('loading');
  const [requestCycle,setRequestCycle]=useState(0);
  const [range,setRange]=useState('day');
  useEffect(()=>{
    let cancelled=false;
    fetch('/api/monitoring',{cache:'no-store'}).then(async response=>{
      if(!response.ok)throw Error('Unavailable');
      return response.json();
    }).then(payload=>{
      if(cancelled)return;
      setObservations(Array.isArray(payload.observations)?payload.observations:[]);
      setMachine(Array.isArray(payload.machineObservations)?payload.machineObservations:[]);
      setAvailability(Array.isArray(payload.availability)?payload.availability:[]);
      setMonitorStatus(payload.status==='configured'?'configured':'not_configured');
    }).catch(()=>{if(!cancelled)setMonitorStatus('error');});
    return ()=>{cancelled=true;};
  },[requestCycle]);
  const latest=new Map<string,(typeof observations)[number]>();
  const [clock,setClock]=useState(()=>Date.now());
  useEffect(()=>{
    const timer=setInterval(()=>setClock(Date.now()),30_000);
    return ()=>clearInterval(timer);
  },[]);
  for(const obs of observations){if(!latest.has(obs.resourceId))latest.set(obs.resourceId,obs);}
  const fresh=(id:string)=>{
    const observation=latest.get(id);
    return observation&&Number.isFinite(Date.parse(observation.checkedAt))&&clock-Date.parse(observation.checkedAt)>=-60_000&&clock-Date.parse(observation.checkedAt)<=15*60*1000&&observation.state!=='stale'?observation:undefined;
  };
  const diagnosticLabels:Record<string,string>={dns:'خطای DNS',tls:'خطای TLS',timeout:'مهلت پاسخ تمام شد',connection:'خطای اتصال',unavailable:'بررسی ناموفق'};
  const stateLabel=(state:string)=>({healthy:'HTTPS پاسخ‌گو',unhealthy:'HTTPS ناموفق',stale:'مشاهدهٔ قدیمی'}[state] ?? 'وضعیت نامشخص');
  const unknown=data.resources.filter(r=>!fresh(r.id)).length;
  const resources=data.resources.filter(r=>matches(query,r.name,r.address,r.provider));
  const expiring=data.resources.filter(r=>r.expires&&Date.parse(r.expires)>=clock&&Date.parse(r.expires)<clock+7*24*60*60*1000);
  const elapsed=range==='recent' ? 15*60*1000 : 24*60*60*1000;
  const visibleObservations=observations.filter(observation=>{
    const age=clock-Date.parse(observation.checkedAt);
    return age>=-60_000&&age<=elapsed;
  });
  return <>
    <Heading title="وضعیت سرویس‌ها" subtitle="مشاهدات زمان‌دار HTTPS فقط برای دامنه‌های مجاز و فعال‌شده در تنظیمات سرور ثبت می‌شوند.">
      <Button icon={RefreshCw} disabled={monitorStatus==='loading'} onClick={()=>{setMonitorStatus('loading');setRequestCycle(cycle=>cycle+1);}}>
        {monitorStatus==='error'?'تلاش دوباره':'تازه‌کردن مشاهدات'}
      </Button>
    </Heading>
    <div className="stack">
      <Callout><strong>وضعیت اتصال: {monitorStatus==='configured'?'Worker پیکربندی شده':monitorStatus==='loading'?'در حال دریافت':monitorStatus==='error'?'خطای دریافت':'غیرفعال'}.</strong> سلامت فقط برای مشاهدات معتبر ۱۵ دقیقه اخیر گزارش می‌شود. پایش نیازمند اجرای زمان‌بندی‌شده Worker است؛ بررسی دائمی خودکار هنوز فعال نیست.</Callout>
      <Metrics entries={[
        {label:'منابع ثبت‌شده',value:data.resources.length,note:'اطلاعات دستی، نه پایش زنده',icon:Radio},
        {label:'وضعیت نامشخص',value:unknown,note:'بدون مشاهده تازه',icon:Clock3},
        {label:'تمدید در ۷ روز',value:expiring.length,note:'براساس تاریخ ثبت‌شده',icon:Bell},
        {label:'هشدار ثبت‌شده',value:data.incidents.filter(i=>i.state==='open').length,note:'باز و نیازمند بررسی',icon:CircleAlert},
      ]}/>
      <Panel title="دارایی‌ها و آخرین وضعیت ثبت‌شده"><SearchField label="جست‌وجوی منبع" value={query} onChange={setQuery}/>
        {resources.length?resources.map(item=>{
          const latestCheck=latest.get(item.id);
          const state=fresh(item.id)?.state ?? (latestCheck ? 'stale' : 'unknown');
          return <Row key={item.id} icon={Activity} title={item.name} meta={<bdi dir="ltr">{item.address}</bdi>}
            href={resourceHref(item)} end={<Pill tone={state==='healthy'?'good':'warn'}>
              {stateLabel(state)}{latestCheck?' · '+dateLabel(latestCheck.checkedAt,{hour:'2-digit',minute:'2-digit'}):''}
            </Pill>}/>;
        }):<Empty title="هنوز منبعی ثبت نشده است"/>}
      </Panel>
      <Panel title="آخرین مشاهدات HTTPS" action={<Filter label="بازهٔ مشاهدات HTTPS" value={range} onChange={setRange}
        options={[{value:'day',label:'۲۴ ساعت گذشته'},{value:'recent',label:'۱۵ دقیقهٔ گذشته'}]}/>}>{visibleObservations.length?
        <div className="stack">{visibleObservations.slice(0,12).map((o,index)=><Row key={`${o.resourceId}-${o.checkedAt}-${index}`} icon={Activity}
          title={data.resources.find(r=>r.id===o.resourceId)?.name??'منبع'}
          meta={<>{dateLabel(o.checkedAt,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} · کد {o.statusCode??'نامشخص'} · {o.latencyMs??'—'} ms
            {o.diagnostic && diagnosticLabels[o.diagnostic] && <> · {diagnosticLabels[o.diagnostic]}</>}
            {o.tlsExpiresAt?' · انقضای TLS '+dateLabel(o.tlsExpiresAt):''}</>}
          end={<Pill tone={o.state==='healthy'&&fresh(o.resourceId)?.checkedAt===o.checkedAt?'good':'warn'}>{stateLabel(
            clock-Date.parse(o.checkedAt)>15*60*1000 ? 'stale' : o.state,
          )}</Pill>}/>)}</div>:
        <Empty title="در این بازه مشاهده‌ای ثبت نشده است"/>}</Panel>
      <Panel title="دسترس‌پذیری نمونه‌برداری‌شده و بودجهٔ خطا">
        <p className="muted">هدف {number(availabilityTarget)}٪ در ۲۴ ساعت گذشته. پوشش با بازه‌های ۱۵ دقیقه‌ای سنجیده می‌شود.</p>
        {monitorStatus==='configured' && availability.length ? availability.map(item=><Row key={item.resourceId} icon={Activity}
          title={data.resources.find(resource=>resource.id===item.resourceId)?.name ?? 'منبع'}
          meta={number(item.covered)+' از '+number(item.expected)+' بازه مشاهده شده · '+number(item.failed)+' بازه ناموفق'}
          end={<Pill tone={item.covered===item.expected && item.errorBudgetRemaining>=0?'good':'warn'}>
            {number(item.availability)}٪ · {item.covered===item.expected
              ? number(item.errorBudgetRemaining)+' بازه بودجهٔ باقی‌مانده' : 'پوشش ناکافی برای ارزیابی بودجه'}
          </Pill>}/>) : <Empty title={monitorStatus==='loading'?'در حال دریافت مشاهدات':'مشاهدهٔ معتبر برای محاسبه ثبت نشده است'}/>}
      </Panel>
      <Panel title="آخرین گزارش‌های عامل میزبان">
        {machine.length?machine.slice(0,10).map(o=><Row key={o.resourceId+o.checkedAt} icon={Activity}
          title={data.resources.find(r=>r.id===o.resourceId)?.name??'منبع'}
          meta={dateLabel(o.checkedAt,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+' · عامل میزبان'}
          end={o.state==='observed'&&machineObservationFresh(o.checkedAt,clock)
            ? <Pill>CPU {Math.round(o.cpuPercent)}٪ · RAM {Math.round(o.usedBytes/o.totalBytes*100)}٪
              {o.diskUsedBytes!==null&&o.diskTotalBytes!==null ? ` · Disk ${Math.round(o.diskUsedBytes/o.diskTotalBytes*100)}٪` : ''}</Pill>
            : <Pill tone="warn">گزارش قدیمی</Pill>}/>) : <Empty title="گزارشی از عامل میزبان دریافت نشده" />}
      </Panel>
    </div>
  </>;
}

const rules = [
  { key:'renewal',title:'یادآوری تمدید سرور',detail:'پیش از سررسید زیرساخت'},
  { key:'outage',title:'هشدار قطعی سرویس',detail:'ترجیح نمایشی برای پایش آینده'},
  { key:'stale',title:'وظایف بدون فعالیت',detail:'پس از ۷ روز'},
  { key:'digest',title:'خلاصه روزانه',detail:'ترجیح نمایشی فضای کاری'},
] as const;

const alertMessages: Record<Incident['state'], string> = {
  open:'هشدار دوباره باز شد.', acknowledged:'رسیدگی به هشدار ثبت شد.', snoozed:'هشدار ۲۴ ساعت به تعویق افتاد.',
  resolved:'هشدار حل شد.', dismissed:'هشدار کنار گذاشته شد.',
};

export function Alerts() {
  const { data, projectScope, setProjectScope, change, saving } = useDemo();
  const [filter,setFilter] = useState('open');
  const [priority,setPriority] = useState('');
  const [query,setQuery] = useState('');
  const [selected,setSelected] = useState<string>();
  const [alertError,setAlertError] = useState('');
  const [config,setConfig] = useState(false);
  const scoped = data.incidents.filter(a => !projectScope || a.projectId === projectScope);
  const open = scoped.filter(a => a.state === 'open');
  const items = scoped.filter(a => (!filter || a.state === filter) && (!priority || a.priority === priority) && matches(query,a.title,a.source));
  const alert = data.incidents.find(a => a.id === selected);

  async function updateState(next: Incident['state']) {
    if (!alert) return;
    const snoozedUntil = next === 'snoozed' ? afterHours(24) : undefined;
    const action = alertMessages[next];
    setAlertError('');
    const saved = await change(previous => ({...previous,incidents:previous.incidents.map(a => a.id === alert.id ? {...a,state:next,snoozedUntil} : a)}),
      action,{projectId:alert.projectId,title:action,source:'هشدارها',detail:alert.title});
    if (!saved) { setAlertError('ذخیرهٔ وضعیت هشدار تأیید نشد.'); return; }
    setSelected(undefined);
  }

  function settings() {
    return rules.map(rule => <div className="setting-row" key={rule.key}><div><strong>{rule.title}</strong><small>{rule.detail}</small></div>
      <Switch label={rule.title} checked={data.preferences[rule.key]} onChange={checked => {
        const preferences = {...data.preferences,[rule.key]:checked};
        const saved = savePreferences(preferences);
        change(d => ({...d,preferences}),saved ? 'ترجیح ثبت شد.' : 'ترجیح ثبت شد.');
      }} /></div>);
  }

  return <>
    <Heading title="هشدارها و یادآوری‌ها" subtitle="موارد نیازمند اقدام، سررسیدها و اطلاعات ناقص پروژه">
      <Button variant="primary" icon={Bell} onClick={() => setConfig(true)}>تنظیم یادآوری‌ها</Button>
    </Heading>
    <div className="stack">
      <Metrics entries={[
        {label:'هشدارهای باز',value:open.length,note:'اطلاعات ثبت‌شده',icon:Bell},
        {label:'اولویت بالا',value:open.filter(a => a.priority === 'high').length,note:'نیازمند توجه',icon:CircleAlert},
        {label:'به‌تعویق‌افتاده',value:scoped.filter(a => a.state === 'snoozed').length,note:'تا زمان بازبینی',icon:Clock3},
        {label:'رسیدگی‌شده',value:scoped.filter(a => a.state === 'acknowledged').length,note:'در محدودهٔ انتخاب‌شده',icon:Check,tone:'good'},
      ]} />
      <div className="split">
        <Panel title="موارد نیازمند اقدام">
          <div className="toolbar"><SearchField label="جست‌وجوی هشدار" value={query} onChange={setQuery} /><ProjectFilter value={projectScope} onChange={setProjectScope} />
            <Filter label="وضعیت هشدار" value={filter} onChange={setFilter} options={[{value:'',label:'همه وضعیت‌ها'},...choices(incidentStates)]} />
            <Filter label="اولویت هشدار" value={priority} onChange={setPriority} options={[{value:'',label:'همه اولویت‌ها'},...choices(priorities)]} />
          </div>
          {items.length ? items.map(a => <Row key={a.id} icon={Bell} title={a.title} meta={<>{projectName(data,a.projectId)} · {a.source} · {dateLabel(a.date)}</>}
            end={<Pill tone={priorityTones[a.priority]}>{priorities[a.priority]}</Pill>} onClick={() => {setAlertError('');setSelected(a.id);}} />) : <Empty title="هشداری با این فیلترها پیدا نشد" />}
        </Panel>
        <Panel title="تنظیمات یادآوری">{settings()}<p className="muted mt-3">ارسال تلگرام و ایمیل به تنظیم ارائه‌دهنده و اجرای Worker نیاز دارد.</p></Panel>
      </div>
    </div>
    {alert && <Modal title="بررسی هشدار" onClose={() => setSelected(undefined)}><div className="form-stack">
      <Row icon={Bell} title={alert.title} meta={<>{projectName(data,alert.projectId)} · {alert.source}</>} end={<Pill tone={priorityTones[alert.priority]}>{priorities[alert.priority]}</Pill>} />
      <p className="muted">وضعیت: {incidentStates[alert.state]}{alert.snoozedUntil && ` · تا ${dateLabel(alert.snoozedUntil,{day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'},data.preferences.zone)}`}</p>
      {/^(auto|monitor)-[a-f0-9]{28}$/.test(alert.id) && <NotificationStatus key={alert.id} alert={alert.id} zone={data.preferences.zone} />}
      {alertError && <p className="form-error" role="alert">{alertError}</p>}
      <div className="form-actions">{alert.state !== 'resolved' && alert.state !== 'dismissed' && <>
        {alert.state !== 'acknowledged' && <Button disabled={saving} onClick={() => updateState('acknowledged')}>ثبت رسیدگی</Button>}
        <Button variant="primary" disabled={saving} icon={Check} onClick={() => updateState('resolved')}>حل هشدار</Button>
        <Button disabled={saving} onClick={() => updateState('dismissed')}>کنار گذاشتن هشدار</Button>
      </>}
        {alert.state === 'open' ? <Button disabled={saving} icon={Clock3} onClick={() => updateState('snoozed')}>تعویق ۲۴ ساعته</Button> : <Button disabled={saving} onClick={() => updateState('open')}>بازگشایی هشدار</Button>}
      </div>
    </div></Modal>}
    {config && <Modal title="تنظیم یادآوری‌ها" onClose={() => setConfig(false)}><Callout>ترجیحات در فضای کاری ذخیره می‌شوند. ارسال بیرونی از طریق Worker تلگرام یا ایمیل انجام می‌شود.</Callout>{settings()}
      {data.users[0]?.role === 'Owner' && <NotificationStatus zone={data.preferences.zone} />}
      <div className="modal-footer"><TextLink href="/calendar">ثبت یادآوری در تقویم</TextLink></div>
    </Modal>}
  </>;
}


