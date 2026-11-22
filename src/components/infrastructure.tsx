'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArchiveRestore, CircleAlert, Cpu, Database, FileText, Globe2, HardDrive, KeyRound, MemoryStick, Network, Pencil, Plus, Server, ShieldCheck } from 'lucide-react';
import { dateLabel, docHref, matches, newId, number, percent, projectHref, resourceHref } from '@/lib/format';
import { amountLabel } from '@/lib/money';
import { machineObservationFresh, type MachineObservation } from '@/lib/monitoring';
import { choices, resourceStatuses, resourceTones, resourceTypes } from '@/lib/labels';
import { useDemo } from '@/lib/store';
import type { Resource, SecretReference } from '@/lib/types';
import {vaultLink} from '@/lib/vault-link';
import { ProjectField, ProjectFilter, ResourceForm, SelectOptions, projectName } from './forms';
import { Art, Button, Callout, Empty, Field, Filter, FormActions, Glyph, Heading, LinkButton, Metrics, Modal, Panel, Pill, Row, SearchField, SectionBar, Segments, Table, TextLink, formValues } from './ui';

const resourceIcons = { server:Server, domain:Globe2, database:Database, service:Network };
const resourceArt = { server:'infrastructure/server-rack',domain:'infrastructure/domain',database:'infrastructure/database',service:'infrastructure/cloud-hosting' };
const resourceTabs = [
  {value:'all',label:'همه منابع'}, {value:'server',label:'سرورها'}, {value:'domain',label:'دامنه‌ها'}, {value:'database',label:'دیتابیس‌ها'}, {value:'service',label:'سرویس‌ها'},
] as const;
const resourceCollator = new Intl.Collator('fa-IR', {numeric:true});
const renewalTime = (resource: Resource) => resource.expires ? Date.parse(resource.expires) : Infinity;

function ResourceMeta({ resource }: { resource: Resource }) {
  const { data } = useDemo();
  const parent = data.resources.find(item => item.id === resource.parentId);
  const renewals = data.charges.filter(charge => charge.linkedResourceId === resource.id);
  const items = [
    {label:'نام منبع',value:<bdi>{resource.name}</bdi>},
    {label:'آدرس ثبت‌شده',value:<bdi dir="ltr" className="mono">{resource.address}</bdi>},
    {label:'ارائه‌دهنده',value:<bdi>{resource.provider}</bdi>},
    {label:'محیط',value:<bdi dir="ltr">{resource.environment}</bdi>},
    ...(resource.type === 'server' ? [
      {label:'سیستم‌عامل',value:<bdi>{resource.os || 'ثبت نشده'}</bdi>},
      {label:'پورت SSH',value:<bdi dir="ltr" className="mono">{resource.port ?? '—'}</bdi>},
      {label:'موقعیت دیتاسنتر',value:resource.region ?? 'ثبت نشده'},
    ] : []),
    ...(resource.type !== 'server' && resource.port !== undefined
      ? [{label:'پورت سرویس',value:<bdi dir="ltr" className="mono">{resource.port}</bdi>}] : []),
    ...(parent ? [{label:'منبع والد',value:<Link className="cell-link" href={resourceHref(parent)}><bdi>{parent.name}</bdi></Link>}] : []),
    {label:'پروژه مرتبط',value:<Link className="cell-link" href={projectHref(resource.projectId)}><bdi>{projectName(data,resource.projectId)}</bdi></Link>},
    {label:'تاریخ تمدید',value:resource.expires ? dateLabel(resource.expires,{day:'numeric',month:'long',year:'numeric'}) : <span className="ink-warn">ثبت نشده</span>},
    ...(resource.noticeDays !== undefined ? [{label:'زمان اعلان تمدید',
      value:resource.noticeDays === 0 ? 'روز موعد' : `${number(resource.noticeDays)} روز پیش از موعد`}] : []),
    ...(renewals.length ? [{label:'هزینه‌های دوره‌ای',value:<ul>{renewals.map(charge =>
      <li key={charge.id}>{charge.title} · {amountLabel(charge)} · {dateLabel(charge.nextDue)}</li>)}</ul>}] : []),
    {label:'برچسب‌ها',value:resource.tags.length ? resource.tags.map(tag => <Pill key={tag}><bdi>{tag}</bdi></Pill>) : '—'},
  ];
  return <dl className="form-grid key-values">{items.map(({label,value}) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

export function Infrastructure() {
  const { data, projectScope, setProjectScope } = useDemo();
  const [kind, setKind] = useState<typeof resourceTabs[number]['value']>('all');
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState<Resource>();
  const [query, setQuery] = useState('');
  const [environment, setEnvironment] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('');
  const params = useSearchParams();
  const router = useRouter();
  const active = data.resources.find(r => r.type !== 'server' && r.id === params.get('resource'));
  const scoped = data.resources.filter(r => !projectScope || r.projectId === projectScope || r.linkedProjectIds?.includes(projectScope));
  const items = scoped.filter(r => (kind === 'all' || r.type === kind) && (!environment || r.environment === environment) && (!status || r.status === status) && matches(query,r.name,r.address,r.provider,...r.tags));
  if (sort === 'name') items.sort((a,b) => resourceCollator.compare(a.name,b.name));
  if (sort === 'renewal') items.sort((a,b) => renewalTime(a) - renewalTime(b) || resourceCollator.compare(a.name,b.name));

  return <>
    <Heading title="زیرساخت و سرویس‌ها" subtitle="همه سرورها، دامنه‌ها، پایگاه‌های داده و سرویس‌های متصل">
      <Button variant="primary" icon={Plus} onClick={() => setShow(true)}>افزودن منبع</Button>
    </Heading>
    <Metrics entries={[
      {label:'سرورها',value:scoped.filter(r => r.type === 'server').length,note:'سرورهای ابری و VPS',icon:Server},
      {label:'دامنه‌ها',value:scoped.filter(r => r.type === 'domain').length,note:'دامنه و DNS',icon:Globe2},
      {label:'دیتابیس‌ها',value:scoped.filter(r => r.type === 'database').length,note:'پایگاه‌های داده ثبت‌شده',icon:Database},
      {label:'دسترسی‌های مرتـبط',value:data.secrets.filter(s => !projectScope || s.projectId === projectScope).length,note:'ارجاع به خزانه',icon:ShieldCheck},
    ]} />
    <SectionBar title="فهرست منابع"><Segments label="نوع منبع" value={kind} onChange={setKind} options={resourceTabs} /></SectionBar>
    <div className="toolbar"><SearchField label="جست‌وجوی نام، آدرس یا برچسب" value={query} onChange={setQuery} />
      <ProjectFilter value={projectScope} onChange={setProjectScope} />
      <Filter label="فیلتر محیط" value={environment} onChange={setEnvironment} options={[{value:'',label:'همه محیط‌ها'},...['Production','Staging','Development'].map(value => ({ value,label:value }))]} />
      <Filter label="فیلتر وضعیت منبع" value={status} onChange={setStatus} options={[{value:'',label:'همه وضعیت‌ها'},...choices(resourceStatuses)]} />
      <Filter label="مرتب‌سازی منابع" value={sort} onChange={setSort}
        options={[{value:'',label:'ترتیب ثبت'}, {value:'name',label:'نام منبع'}, {value:'renewal',label:'نزدیک‌ترین تمدید'}]} />
    </div>
    <div className="stack">
      <Panel className="inventory-table"><Table compact label="منابع زیرساخت" rows={expanded ? items : items.slice(0,6)} columns={[
        {label:'نام منبع',render:r => <Link className="cell-identity" href={resourceHref(r)}><Glyph icon={resourceIcons[r.type]} /><span><strong dir="auto">{r.name}</strong><small className="inventory-mobile-type">{resourceTypes[r.type]}</small></span></Link>},
        {label:'پروژه',render:r => <bdi>{projectName(data,r.projectId)}</bdi>},
        {label:'نوع',extra:true,render:r => resourceTypes[r.type]},
        {label:'آدرس ثبت‌شده',render:r => <bdi dir="ltr" className="mono">{r.address}</bdi>},
        {label:'محیط',extra:true,render:r => <bdi>{r.environment}</bdi>},
        {label:'وضعیت',extra:true,render:r => <Pill tone={resourceTones[r.status]}>{resourceStatuses[r.status]}</Pill>},
        {label:'جزئیات',extra:true,render:r => <TextLink href={resourceHref(r)}>مشاهده</TextLink>},
      ]} />
        {items.length > 6 && <div className="table-actions"><span className="muted">{number(expanded ? items.length : 6)} از {number(items.length)} منبع</span>
          <Button variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'نمایش کمتر' : 'نمایش منابع بیشتر'}</Button>
        </div>}
      </Panel>
      <div className="grid-2">
        <Panel title="اطلاعات ناقص" action={<TextLink href="/alerts">مشاهده هشدارها</TextLink>}>
          {scoped.filter(r => r.status === 'missing' || (r.type === 'server' && !r.expires)).map(r => <Row key={r.id} icon={CircleAlert}
            title={r.type === 'server' && !r.expires ? 'تاریخ تمدید سرور مشخص نیست' : 'اطلاعات منبع نیاز به تکمیل دارد'}
            meta={<bdi>{r.name}</bdi>} end={<Pill tone="warn">ناقص</Pill>} href={resourceHref(r)} />)}
          {!scoped.some(r => r.status === 'missing' || (r.type === 'server' && !r.expires)) && <Empty title="اطلاعات ناقصی پیدا نشد" />}
        </Panel>
        <Panel title="نمای پروژه‌ها" action={<TextLink href="/projects">مشاهده پروژه‌ها</TextLink>}>
          {data.projects.filter(p => !projectScope || p.id === projectScope).map(p => <Row key={p.id} title={<bdi>{p.name}</bdi>} href={projectHref(p.id)}
            end={<Pill>{number(scoped.filter(r => r.projectId === p.id || r.linkedProjectIds?.includes(p.id)).length)} منبع</Pill>} />)}
        </Panel>
      </div>
    </div>
    {show && <ResourceForm onClose={() => setShow(false)} projectId={projectScope} initialType={kind === 'all' ? 'server' : kind} />}
    {active && !editing && <Modal title={active.name} onClose={() => router.replace('/infrastructure', {scroll:false})}>
      <div className="form-stack"><div className="flex items-center justify-between"><Art name={resourceArt[active.type]} /><Pill tone={resourceTones[active.status]}>{resourceStatuses[active.status]}</Pill></div>
        <ResourceMeta resource={active} />
        <div><Button icon={Pencil} onClick={() => setEditing(active)}>ویرایش منبع</Button></div>
      </div>
    </Modal>}
    {editing && <ResourceForm resource={editing} onClose={() => setEditing(undefined)} />}
  </>;
}

function VaultMetadata({reference}:{reference:SecretReference}){
  const [status,setStatus]=useState<{status:string;checkedAt:string|null}>({status:'loading',checkedAt:null});
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const route='/api/vault/'+encodeURIComponent(reference.id);
  useEffect(()=>{
    const controller=new AbortController();
    fetch(route,{cache:'no-store',signal:controller.signal}).then(async response=>{
      if (!response.ok) throw new Error('Vault status unavailable');
      const result=await response.json();
      if (!controller.signal.aborted) setStatus(result);
    }).catch(()=>{
      if (!controller.signal.aborted) setStatus({status:'unavailable',checkedAt:null});
    });
    return ()=>controller.abort();
  },[route]);
  async function verify(event:FormEvent<HTMLFormElement>){
    const form=event.currentTarget;
    const get=formValues(event);
    setBusy(true);setError('');
    try{
      const response=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({password:get('password'),totp:get('totp')})});
      if(response.status===403) throw new Error('بررسی به رمز حساب و در صورت فعال بودن، کد تازهٔ MFA نیاز دارد.');
      if(response.status===429) throw new Error('دفعات بررسی زیاد است. کمی بعد دوباره تلاش کنید.');
      if(!response.ok) throw new Error('بررسی فراداده انجام نشد.');
      setStatus(await response.json());
    }catch(error){setError(error instanceof Error?error.message:'بررسی انجام نشد.');}
    finally{setBusy(false);form.reset();}
  }
  const labels:Record<string,string>={loading:'در حال دریافت وضعیت خزانه…',verified:'اتصال برقرار و فراداده تأیید شد',not_configured:'اتصال تنظیم نشده',unknown:'هنوز بررسی نشده یا نتیجه نامشخص است',unavailable:'خزانه در دسترس نیست',permission_denied:'دسترسی به فراداده رد شد',stale:'بررسی قدیمی',not_found:'فراداده فعال پیدا نشد'};
  return <div className="stack">
    <p role="status">{labels[status.status]??'نامشخص'}{status.checkedAt?' · '+dateLabel(status.checkedAt,{day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'}):''}</p>
    {reference.vaultMount && reference.vaultPath && <dl className="form-grid key-values">
      <div><dt>Mount</dt><dd><bdi dir="ltr">{reference.vaultMount}</bdi></dd></div>
      <div><dt>مسیر فراداده</dt><dd><bdi dir="ltr">{reference.vaultPath}</bdi></dd></div>
    </dl>}
    {reference.vaultMount&&<form className="form-stack" onSubmit={verify}>
      <Field label="رمز حساب برای بررسی"><input type="password" name="password" autoComplete="current-password" required /></Field>
      <Field label="کد تازهٔ MFA"><input type="text" name="totp" maxLength={6} inputMode="numeric" autoComplete="one-time-code" /></Field>
      <Button type="submit" disabled={busy || status.status==='loading'}>بررسی فراداده در Vault</Button>
    </form>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}

function ServerMachineMetrics({server}: {server:Resource}) {
  const [observation,setObservation]=useState<MachineObservation|null>();
  const [clock,setClock]=useState(()=>Date.now());
  useEffect(()=>{
    const controller=new AbortController();
    fetch('/api/monitoring?resourceId='+encodeURIComponent(server.id),{cache:'no-store',signal:controller.signal})
      .then(async response=>{
        if (!response.ok) throw new Error('Metrics unavailable');
        const payload=await response.json() as {machineObservations:MachineObservation[]};
        if (!controller.signal.aborted) setObservation(payload.machineObservations[0] ?? null);
      }).catch(()=>{if (!controller.signal.aborted) setObservation(null);});
    const timer=setInterval(()=>setClock(Date.now()),30_000);
    return ()=>{controller.abort();clearInterval(timer);};
  },[server.id]);
  const fresh=observation && observation.state==='observed' && machineObservationFresh(observation.checkedAt,clock)
    ? observation : undefined;
  const note=observation
    ? `${fresh ? 'عامل میزبان' : 'مشاهدهٔ قدیمی'} · ${dateLabel(observation.checkedAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`
    : observation===undefined ? 'در حال دریافت' : 'مشاهده‌ای در دسترس نیست';
  const disk=fresh && fresh.diskUsedBytes!==null && fresh.diskTotalBytes!==null
    ? percent(Math.round(fresh.diskUsedBytes/fresh.diskTotalBytes*100)) : 'نامشخص';
  return <Metrics entries={[
    {label:'وضعیت ثبت',value:resourceStatuses[server.status],note:'وضعیت ثبت دستی',icon:Server},
    {label:'CPU',value:fresh ? percent(Math.round(fresh.cpuPercent)) : 'نامشخص',note,icon:Cpu},
    {label:'RAM',value:fresh ? percent(Math.round(fresh.usedBytes/fresh.totalBytes*100)) : 'نامشخص',note,icon:MemoryStick},
    {label:'Disk',value:disk,note,icon:HardDrive},
  ]}/>;
}

export function ServerDetails({ id }: { id: string }) {
  const { data } = useDemo();
  const [editing, setEditing] = useState(false);
  const [recovery,setRecovery] = useState(false);
  const server = data.resources.find(r => r.type === 'server' && r.id === id);
  if (!server) return <Empty title="سرور پیدا نشد" detail="شناسه منبع را بررسی کنید." action={<LinkButton href="/infrastructure">فهرست زیرساخت</LinkButton>} />;
  const related = data.resources.filter(r => r.parentId === id);
  const docs = data.docs.filter(d => d.projectId === server.projectId);
  const showReferences = data.users[0]?.role === 'Owner';
  return <>
    <Heading title={<bdi>{server.name}</bdi>} subtitle={<>زیرساخت · <bdi>{projectName(data,server.projectId)}</bdi> · مشخصات سرور</>}>
      <Button icon={ArchiveRestore} onClick={() => setRecovery(true)}>راهنکار بازیابی</Button>
      <Button variant="primary" icon={Pencil} onClick={() => setEditing(true)}>ویرایش سرور</Button>
    </Heading>
    <div className="stack">
      <ServerMachineMetrics key={id} server={server} />
      <div className="split">
        <Panel title="مشخصات سرور" action={<Pill><bdi>{server.environment}</bdi></Pill>} className="stack">
          <div className="resource-banner"><Art name="infrastructure/server-rack" size={72} /><div><strong dir="auto">{server.name}</strong><small>مشخصات ثبت‌شده · تأیید نشده</small></div></div>
          <ResourceMeta resource={server} />
          {showReferences && <LinkButton href={`/vault?resource=${encodeURIComponent(id)}`}>ارجاع‌های خزانهٔ این سرور</LinkButton>}
        </Panel>
        <div className="stack">
          <Panel title="سرویس‌های مرتبط" action={<TextLink href="/infrastructure">زیرساخت</TextLink>}>
            {related.length ? related.map(r => <Row key={r.id} icon={resourceIcons[r.type]} title={<bdi>{r.name}</bdi>} meta={<bdi>{r.provider}</bdi>} href={resourceHref(r)} end={<Pill tone={resourceTones[r.status]}>{resourceStatuses[r.status]}</Pill>} />) : <Empty title="سرویس مرتبط ثبت نشده است" />}
          </Panel>
          <Panel title="پشتیبان و راهنماها">
            <Row icon={HardDrive} title="آخرین بازیابی" meta="تأیید نشده" end={<Pill tone="warn">نیازمند بررسی</Pill>} />
            {docs.map(d => <Row key={d.id} icon={FileText} title={d.title} href={docHref(d.id)} meta={d.type} />)}
            {!docs.length && <small className="muted">مستندی برای این سرور ثبت نشده است.</small>}
          </Panel>
        </div>
      </div>
    </div>
    {editing && <ResourceForm resource={server} onClose={() => setEditing(false)} />}
    {recovery && <Modal title="راهنکار بازیابی" onClose={() => setRecovery(false)}><Callout>وضعیت پشتیبان و مستندات پروژه را مرور کنید. بازیابی از این صفحه در دسترس نیست.</Callout>
      {docs.map(d => <Link key={d.id} href={docHref(d.id)} className="item-row item-interactive" onClick={() => setRecovery(false)}>{d.title}</Link>)}
    </Modal>}
  </>;
}

const secretTypes: SecretReference['type'][] = ['SSH Key','API Token','DB Credential','Account'];
function SecretForm({ onClose, projectId, resource }: { onClose: () => void; projectId: string; resource?: Resource }) {
  const { data, change, saving } = useDemo();
  const [activeProject, setActiveProject] = useState(projectId);
  const [error, setError] = useState('');
  const resources = data.resources.filter(item => item.projectId === activeProject || item.linkedProjectIds?.includes(activeProject));
  async function submit(event: FormEvent<HTMLFormElement>) {
    const get = formValues(event);
    if (!get('name') || !get('provider')) { setError('نام ارجاع و محل خزانه را وارد کنید.'); return; }
    const mount = get('mount'), path = get('path'), link = get('link');
    if (link && !vaultLink(link)) { setError('لینک خزانه باید از دامنهٔ رسمی ارائه‌دهنده باشد.'); return; }
    if ((mount || path) && (!mount || !path || get('provider') !== 'HashiCorp Vault')) {
      setError('برای HashiCorp Vault نام ارائه‌دهنده، Mount و مسیر فراداده را وارد کنید.');
      return;
    }
    setError('');
    const item: SecretReference = {
      id:newId('reference'),name:get('name'),projectId:get('project'),type:get('type') as SecretReference['type'],
      vaultProvider:get('provider'),resourceId:get('resource') || undefined,externalRef:link || undefined,
      vaultMount:mount || undefined,vaultPath:path || undefined,
      ...(get('rotation')?{rotationDue:get('rotation')}:{}),
    };
    const saved = await change(data => ({ ...data,secrets:[...data.secrets,item] }), 'فرادادهٔ ارجاع ثبت شد.');
    if (!saved) { setError('ذخیرهٔ ارجاع تأیید نشد.'); return; }
    onClose();
  }
  return <Modal title="افزودن ارجاع" onClose={onClose}><form className="form-stack" onSubmit={submit}>
    <Callout>نام نمایشی و نام خزانهٔ بیرونی را وارد کنید. مقدار محرمانه در این فرم جایگاهی ندارد.</Callout>
    <Field label="عنوان ارجاع"><input autoFocus name="name" required maxLength={70} dir="auto" /></Field>
    <ProjectField initial={projectId} onChange={setActiveProject} />
    <Field label="منبع مرتبط"><select key={activeProject} name="resource" defaultValue={resources.some(item => item.id === resource?.id) ? resource?.id : ''}>
      <option value="">بدون منبع مرتبط</option>
      {resources.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></Field>
    <Field label="نوع ارجاع"><select name="type"><SelectOptions options={secretTypes} /></select></Field>
    <Field label="محل خزانه"><input name="provider" placeholder="HashiCorp Vault / 1Password / Bitwarden / Infisical" required dir="auto" maxLength={80} /></Field>
    <Field label="لینک امن آیتم خزانه (اختیاری)"><input name="link" type="url" dir="ltr" maxLength={500} placeholder="https://start.1password.com/open/..." /></Field>
    <Callout>فقط لینک‌های HTTPS به دامنه‌های رسمی 1Password، Bitwarden یا Infisical پذیرفته می‌شوند. لینک نباید حاوی رمز یا توکن باشد.</Callout>
    <div className="form-grid">
      <Field label="Mount فراداده برای HashiCorp Vault"><input name="mount" dir="ltr" maxLength={80} /></Field>
      <Field label="مسیر فراداده برای HashiCorp Vault"><input name="path" dir="ltr" maxLength={240} /></Field>
      <Field label="موعد چرخش"><input name="rotation" type="date" dir="ltr" /></Field>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <FormActions onClose={onClose} saving={saving} submit="ثبت ارجاع" />
  </form></Modal>;
}

export function Vault() {
  const { data, projectScope, setProjectScope } = useDemo();
  const params = useSearchParams();
  const [query,setQuery] = useState('');
  const [type,setType] = useState('');
  const [show,setShow] = useState(false);
  const [selected,setSelected] = useState<SecretReference>();
  if(data.users[0]?.role!=='Owner')return <Panel title="خزانه دسترسی‌ها"><Callout>مشاهدهٔ ارجاع‌ها نیازمند نقش مالک است.</Callout></Panel>;
  const resource = data.resources.find(item => item.id === params.get('resource'));
  const scope = data.secrets.filter(s => resource ? s.resourceId === resource.id : !projectScope || s.projectId === projectScope);
  const items = scope.filter(s => (!type || s.type === type) && matches(query,s.name,s.vaultProvider));
  return <>
    <Heading title="خزانه دسترسی‌ها" subtitle="فهرست ارجاع‌های پروژه به کلیدها، حساب‌ها و رکوردهای خزانه">
      <Button variant="primary" icon={Plus} onClick={() => setShow(true)}>افزودن ارجاع</Button>
    </Heading>
    <div className="stack">
      <Callout>وضعیت بررسی فراداده را در جزئیات هر ارجاع ببینید. مشاهدهٔ مقدار محرمانه در خود Vault انجام می‌شود.</Callout>
      <Metrics entries={[
        {label:'مراجع امن',value:scope.length,note:'فرادادهٔ ثبت‌شده',icon:ShieldCheck},
        {label:'کلیدهای SSH',value:scope.filter(s => s.type === 'SSH Key').length,note:'ارجاع دسترسی سرورها',icon:KeyRound},
        {label:'توکن‌های API',value:scope.filter(s => s.type === 'API Token').length,note:'ارجاع اتصال سرویس‌ها',icon:Network},
        {label:'نیازمند بازبینی',value:scope.filter(s => !s.lastCheckedAt).length,note:'فاقد تاریخ بررسی',icon:CircleAlert},
      ]} />
      <Panel title="دسترسی‌های ثبت‌شده">
        <div className="toolbar"><SearchField label="جست‌وجوی ارجاع" value={query} onChange={setQuery} />
          {resource ? <><Pill><bdi>{resource.name}</bdi></Pill><TextLink href="/vault">همه ارجاع‌ها</TextLink></>
            : <ProjectFilter value={projectScope} onChange={setProjectScope} />}
          <Filter label="نوع ارجاع" value={type} onChange={setType} options={[{value:'',label:'همه انواع'},...secretTypes.map(value => ({value,label:value}))]} />
        </div>
        <Table label="ارجاع‌های خزانه" rows={items} columns={[
          {label:'عنوان',render:s => <button className="cell-identity cell-link" type="button" onClick={() => setSelected(s)}><Glyph icon={KeyRound} /><strong dir="auto">{s.name}</strong></button>},
          {label:'پروژه',render:s => <bdi>{projectName(data,s.projectId)}</bdi>},
          {label:'نوع',render:s => <bdi dir="ltr">{s.type}</bdi>},
          {label:'محل ارجاع',render:s => <bdi dir="ltr">{s.vaultProvider}</bdi>},
          {label:'آخرین بررسی فراداده',extra:true,render:s => s.lastCheckedAt ? dateLabel(s.lastCheckedAt) : 'نامشخص'},
          {label:'مسیر بررسی',extra:true,render:s => s.vaultMount ? 'فرادادهٔ HashiCorp' : 'ارجاع بیرونی'},
        ]} />
      </Panel>
      <Panel title="قوانین دسترسی"><div className="grid-3">
        {['تأیید هویت برای دسترسی','ثبت عملیات حساس','مجوز مستقل برای هر پروژه'].map(label => <div className="mini-event" key={label}><strong>{label}</strong><small>سیاست برنامه‌ریزی‌شده</small></div>)}
      </div></Panel>
    </div>
    {show && <SecretForm key={resource?.id ?? 'workspace'} projectId={resource?.projectId ?? projectScope} resource={resource} onClose={() => setShow(false)} />}
    {selected && <Modal title="جزئیات ارجاع" onClose={() => setSelected(undefined)}><div className="form-stack">
      <Row title={<bdi>{selected.name}</bdi>} meta={<bdi dir="ltr">{selected.type} · {selected.vaultProvider}</bdi>} icon={KeyRound} />
      <VaultMetadata key={selected.id} reference={selected} />
      {selected.externalRef&&vaultLink(selected.externalRef) ? <a href={vaultLink(selected.externalRef)!} target="_blank" rel="noopener noreferrer" className="cell-link">باز کردن آیتم در خزانه خارجی (احراز هویت توسط خزانه)</a> : null}
    </div></Modal>}
  </>;
}

