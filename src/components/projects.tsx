'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Activity, Archive, ArrowUpLeft, Bell, Check, CircleAlert, Clock3, FolderKanban, FolderOpen, Grid2X2, List, ListTodo, Pencil, Plus, Server, ShieldCheck, Trash2 } from 'lucide-react';
import { dateLabel, docHref, matches, number, percent, projectHref, resourceHref, taskHref } from '@/lib/format';
import { amountLabel } from '@/lib/money';
import { choices, priorities, priorityTones, projectStatuses, projectTones, resourceStatuses, resourceTones, taskStatuses, taskTones } from '@/lib/labels';
import { useDemo, useWorkspaceReady } from '@/lib/store';
import type { Project, Resource, Task } from '@/lib/types';
import { projectCompleteness } from '@/lib/completeness';
import { Art, Button, Empty, Filter, Glyph, Heading, LinkButton, Metrics, Modal, Panel, Pill, Progress, Row, SearchField, SectionBar, Segments, Table, TextLink, visibleLink } from './ui';
import { DocForm, ProjectForm, ResourceForm, TaskForm, projectName } from './forms';
import { ProjectGitHub } from './project-github';

export function ProjectTable({ projects }: { projects: Project[] }) {
  return <Table compact label="فهرست پروژه‌ها" rows={projects} columns={[
    {label:'پروژه',render:p => <Link className="cell-identity" href={projectHref(p.id)}><Glyph icon={FolderOpen} /><span><strong dir="auto">{p.name}</strong><small>{p.subtitle}</small></span></Link>},
    {label:'وضعیت',render:p => <Pill tone={projectTones[p.status]}>{projectStatuses[p.status]}</Pill>},
    {label:'پیشرفت',render:p => <Progress label={`پیشرفت ${p.name}`} value={p.progress} />},
    {label:'اقدام بعدی',extra:true,render:p => p.next},
    {label:'دسترسی',extra:true,render:p => <TextLink href={projectHref(p.id)}>مشاهده</TextLink>},
  ]} />;
}

export function Dashboard() {
  const { data } = useDemo();
  const [quick, setQuick] = useState<'choose' | 'project' | 'task' | null>(null);
  const [displayDate]=useState(()=>dateLabel(new Date().toISOString(),{ weekday:'long',month:'long',day:'numeric',year:'numeric' }));
  const projects = data.projects.filter(p => p.status !== 'archived');
  const open = data.tasks.filter(t => t.status !== 'done');
  const urgent = open.filter(t => t.priority === 'high').slice(0,3);
  const alerts = data.incidents.filter(a => a.state === 'open');
  return <>
    <Heading title="سلام! همه‌چیز اینجاست" subtitle={`${displayDate} · نمای کلی فضای کاری`}>
      <Button variant="primary" icon={Plus} onClick={() => setQuick('choose')}>ثبت اطلاعات</Button>
    </Heading>
    <div className="stack">
      <Metrics entries={[
        {label:'پروژه‌های فعال',value:projects.length,note:`${number(projects.filter(p => p.status === 'building').length)} پروژه در حال توسعه`,icon:FolderKanban},
        {label:'کارهای باقی‌مانده',value:open.length,note:`${number(open.filter(t => t.priority === 'high').length)} کار با اولویت بالا`,icon:ListTodo},
        {label:'منابع ثبت‌شده',value:data.resources.length,note:'سلامت واقعی تأیید نشده',icon:Activity},
        {label:'موارد نیازمند توجه',value:alerts.length,note:`${number(alerts.filter(a => a.priority === 'high').length)} مورد فوری`,icon:CircleAlert},
      ]} />
      <div className="split">
        <Panel title="پروژه‌های اخیر" action={<TextLink href="/projects">مشاهده پروژه‌ها</TextLink>}><ProjectTable projects={projects.slice(0,4)} /></Panel>
        <Panel title="اولویت‌های امروز" action={<TextLink href="/tasks">تمام وظایف</TextLink>}>
          {urgent.map(t => <Row key={t.id} icon={ListTodo} title={t.title} meta={projectName(data,t.projectId)} end={<Pill tone={priorityTones[t.priority]}>مهم</Pill>} href={taskHref(t.id)} />)}
          {!urgent.length && <Empty title="کار فوری باقی نمانده است" />}
        </Panel>
      </div>
      <div className="grid-2">
        <Panel title="سلامت سرویس‌ها" action={<TextLink href="/monitoring">مانیتورینگ</TextLink>} className="health-panel">
          <Empty title="پایش خارجی متصل نیست" detail="برای جلوگیری از نمایش داده مصنوعی، تا اتصال یک Probe معتبر درصد Uptime نشان داده نمی‌شود." action={<TextLink href="/monitoring">مشاهده موجودی</TextLink>}/>
        </Panel>
        <Panel title="یادآوری‌ها و اطلاعات ناقص" action={<TextLink href="/alerts">هشدارها</TextLink>}>
          {alerts.slice(0,3).map(a => <Row key={a.id} icon={Bell} title={a.title} meta={a.source} href="/alerts" end={<span className={`status-dot ink-${priorityTones[a.priority]}`} style={{background:'currentColor'}} />} />)}
          {!alerts.length && <Empty title="هشدار بازی وجود ندارد" />}
        </Panel>
      </div>
      <Panel title="فعالیت اخیر" action={<TextLink href="/activity">تاریخچه فعالیت‌ها</TextLink>}>
        <div className="grid-3">{data.events.slice(0,3).map(e => <div className="mini-event" key={e.id}><strong>{e.title}</strong><small>{projectName(data,e.projectId)} · {dateLabel(e.date)}</small></div>)}</div>
      </Panel>
    </div>
    {quick === 'choose' && <Modal title="ثبت اطلاعات" onClose={() => setQuick(null)}><Row icon={FolderOpen} title="پروژه جدید" onClick={() => setQuick('project')} /><Row icon={ListTodo} title="وظیفه جدید" onClick={() => setQuick('task')} /></Modal>}
    {quick === 'project' && <ProjectForm onClose={() => setQuick(null)} />}
    {quick === 'task' && <TaskForm onClose={() => setQuick(null)} />}
  </>;
}

function ProjectCard({ project }: { project: Project }) {
  return <Link href={projectHref(project.id)} className="panel project-card">
    <div className="project-card-head"><Art name={project.art} size={50} /><Pill tone={projectTones[project.status]} dot>{projectStatuses[project.status]}</Pill></div>
    <div><h3 dir="auto">{project.name}</h3><p>{project.subtitle}</p></div>
    <Progress value={project.progress} label="پیشرفت پروژه" />
    <div className="project-card-end"><span>گام بعدی: {project.next}</span><ArrowUpLeft size={15} aria-hidden="true" /></div>
  </Link>;
}

export function Projects() {
  const { data, projectScope, setProjectScope } = useDemo();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('default');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [show, setShow] = useState(false);
  const projects = data.projects.filter(p => !projectScope || p.id === projectScope);
  const visible = projects.filter(p => (filter ? p.status === filter : p.status !== 'archived') && matches(query,p.name,p.subtitle,p.type));
  if (sort === 'progress') visible.sort((a,b) => b.progress - a.progress);
  if (sort === 'name') visible.sort((a,b) => a.name.localeCompare(b.name,'fa'));
  return <>
    <Heading title="مدیریت پروژه‌ها" subtitle="تمام پروژه‌های نرم‌افزاری، وضعیت توسعه و ارتباطات آن‌ها">
      <Button variant="primary" icon={Plus} onClick={() => setShow(true)}>پروژه جدید</Button>
    </Heading>
    <Metrics entries={[
      {label:'کل پروژه‌ها',value:projects.filter(p => p.status !== 'archived').length,note:'در فضای کاری',icon:FolderKanban},
      {label:'در حال توسعه',value:projects.filter(p => p.status === 'building').length,note:'پروژه‌های در جریان',icon:Clock3},
      {label:'پروژه‌های عملیاتی',value:projects.filter(p => p.status === 'active').length,note:'وضعیت ثبت‌شده',icon:Check},
      {label:'وظایف باز',value:data.tasks.filter(t => t.status !== 'done' && projects.some(p => p.id === t.projectId && p.status !== 'archived')).length,note:'نیازمند پیگیری',icon:ListTodo},
    ]} />
    <SectionBar title="پروژه‌های من"><Segments label="نمای پروژه‌ها" value={view} onChange={setView} options={[{value:'grid',label:'کارت‌ها',icon:Grid2X2},{value:'list',label:'فهرست',icon:List}]} /></SectionBar>
    <div className="toolbar"><SearchField label="جست‌وجوی پروژه" value={query} onChange={setQuery} />
      <Filter label="فیلتر وضعیت" value={filter} onChange={setFilter} options={[{value:'',label:'همه وضعیت‌ها'},...choices(projectStatuses)]} />
      <Filter label="مرتب‌سازی پروژه‌ها" value={sort} onChange={setSort} options={[{value:'default',label:'ترتیب ثبت'},{value:'progress',label:'بیشترین پیشرفت'},{value:'name',label:'نام پروژه'}]} />
      {projectScope && <Button onClick={() => setProjectScope('')}>نمایش همه پروژه‌ها</Button>}
    </div>
    <div className="stack">
      {view === 'grid' && visible.length > 0 && <div className="grid-3">{visible.map(p => <ProjectCard project={p} key={p.id} />)}</div>}
      <Panel title="فهرست کامل پروژه‌ها"><ProjectTable projects={visible} /></Panel>
    </div>
    {show && <ProjectForm onClose={() => setShow(false)} />}
  </>;
}

const projectTabs = [
  {value:'overview',label:'نمای کلی'}, {value:'tasks',label:'وظایف'}, {value:'resources',label:'زیرساخت'},
  {value:'docs',label:'مستندات'}, {value:'activity',label:'تاریخچه'}, {value:'finance',label:'هزینه‌ها'},
] as const;

function ProjectTaskRows({ tasks }: { tasks: Task[] }) {
  if (!tasks.length) return <Empty title="وظیفه‌ای برای این پروژه ثبت نشده است" />;
  return tasks.map(t => <Row key={t.id} icon={ListTodo} title={t.title} meta={<bdi>{t.id}</bdi>} href={taskHref(t.id)}
    end={<Pill tone={t.status !== 'done' && t.priority === 'high' ? 'bad' : taskTones[t.status]}>{t.status !== 'done' && t.priority === 'high' ? `اولویت ${priorities[t.priority]}` : taskStatuses[t.status]}</Pill>} />);
}
function ProjectResourceRows({ resources }: { resources: Resource[] }) {
  if (!resources.length) return <Empty title="منبعی به این پروژه متصل نشده است" />;
  return resources.map(r => <Row key={r.id} icon={Server} title={<bdi>{r.name}</bdi>} meta={<bdi dir="ltr">{r.address}</bdi>}
    href={resourceHref(r)} end={<Pill tone={resourceTones[r.status]}>{resourceStatuses[r.status]}</Pill>} />);
}
export function ProjectDetails({ id }: { id: string }) {
  const { data, change, saving, projectScope, setProjectScope } = useDemo();
  const ready = useWorkspaceReady();
  const router = useRouter();
  const [tab, setTab] = useState<typeof projectTabs[number]['value']>('overview');
  const [modal, setModal] = useState<'edit' | 'task' | 'resource' | 'doc' | 'archive' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const project = data.projects.find(p => p.id === id);
  if (!project) return <Empty title="پروژه پیدا نشد" detail="شناسه پروژه را بررسی کنید." action={<LinkButton href="/projects">فهرست پروژه‌ها</LinkButton>} />;
  const tasks = data.tasks.filter(t => t.projectId === id);
  const resources = data.resources.filter(r => r.projectId === id || r.linkedProjectIds?.includes(id));
  const docs = data.docs.filter(d => d.projectId === id);
  const events = data.events.filter(e => e.projectId === id);
  const expenses = data.expenses.filter(e => e.projectId === id);
  const archived = project.status === 'archived';
  const isOwner = data.users[0]?.role === 'Owner';
  const canContribute = !archived && (isOwner || data.users[0]?.role === 'Developer');
  const coverage=projectCompleteness(data,project);

  function closeModal() {
    if (saving) return;
    setError('');
    setModal(null);
  }

  async function archive() {
    setError('');
    const message = archived ? 'پروژه از بایگانی بازگردانده شد.' : 'پروژه بایگانی شد.';
    const saved = await change(previous => ({ ...previous, projects:previous.projects.map(p => p.id === id ? { ...p,status:p.status === 'archived' ? p.archivedFrom ?? 'building' : 'archived',archivedFrom:p.status === 'archived' ? undefined : p.status } : p) }), message,
      { projectId:id,title:message,source:'پروژه‌ها' });
    if (!saved) { setError('تغییر وضعیت پروژه تأیید نشد.'); return; }
    if (!archived && projectScope === id) setProjectScope('');
    setModal(null);
  }

  async function deleteProject() {
    setError('');
    const saved = await change(previous => ({ ...previous, projects:previous.projects.filter(item => item.id !== id) }),
      'پروژه حذف شد.');
    if (!saved) {
      setError('حذف تأیید نشد. اگر پروژه رکورد یا منبع مشترک دارد، ابتدا ارتباط آن را بررسی کنید.');
      return;
    }
    if (projectScope === id) setProjectScope('');
    router.replace('/projects');
  }
  return <>
    <Heading title={<bdi>{project.name}</bdi>} subtitle={`پروژه · ${project.subtitle}`}>
      {canContribute && <Button icon={Plus} onClick={() => setModal('task')}>افزودن وظیفه</Button>}
      {isOwner && <Button variant="primary" icon={Pencil} onClick={() => setModal('edit')}>ویرایش پروژه</Button>}
    </Heading>
    <div className="stack">
      <Panel className="project-cover">
        <div><Pill tone={projectTones[project.status]} dot>{projectStatuses[project.status]}</Pill>
          <h2><bdi>{project.coverTitle}</bdi></h2><p>{project.description || project.subtitle}</p>
        </div><Art name={project.art} size={112} />
      </Panel>
      <Metrics entries={[
        {label:'پیشرفت پروژه',value:percent(project.progress),note:'پیشرفت ثبت‌شده توسط کاربر',icon:FolderKanban},
        {label:'وظایف باز',value:tasks.filter(t => t.status !== 'done').length,note:`${number(tasks.filter(t => t.priority === 'high' && t.status !== 'done').length)} مورد با اولویت بالا`,icon:ListTodo},
        {label:'منابع لینک‌شده',value:resources.length,note:'سرویس، دامنه و زیرساخت',icon:Server},
        {label:'مدارک ثبت‌شده',value:docs.length,note:'مستندات پروژه',icon:ShieldCheck},
      ]} />
      <div className="detail-tabs"><Segments label="بخش‌های پروژه" value={tab} onChange={setTab} options={projectTabs} /></div>
      {tab === 'overview' && <>
        <Panel title="کامل بودن اطلاعات پروژه" action={<Pill tone={coverage.percent===100?'good':'warn'}>{number(coverage.percent)}٪ پوشش اطلاعات دستی</Pill>}>
          <div className="grid-2">
            {coverage.items.map(check=><Link key={check.id} href={check.href} className="item-row item-interactive">
              <Glyph icon={check.complete?Check:CircleAlert}/><span className="row-copy"><strong>{check.label}</strong><small>{check.detail}</small></span>
              <Pill tone={check.complete?'good':'warn'}>{check.complete?'ثبت شده':'ناقص'}</Pill>
            </Link>)}
          </div>
          <p className="muted mt-3">این درصد فقط کامل‌بودن فراداده ثبت‌شده را نشان می‌دهد؛ صحت Backup، دسترسی Vault و سلامت سرورها هنوز تأیید نمی‌شود.</p>
        </Panel>
        <div className="split">
          <Panel title="وظایف در حال انجام" action={<Button variant="ghost" onClick={() => setTab('tasks')}>مشاهده وظایف</Button>}>
            <ProjectTaskRows tasks={tasks.filter(t => t.status !== 'done').slice(0,4)} />
          </Panel>
          <Panel title="منابع متصل" action={<Button variant="ghost" onClick={() => setTab('resources')}>زیرساخت</Button>}><ProjectResourceRows resources={resources.slice(0,3)} /></Panel>
        </div>
        <Panel title="تاریخچه و تصمیم‌های اخیر" action={<Button variant="ghost" onClick={() => setTab('activity')}>همه فعالیت‌ها</Button>}>
          {events.length ? <div className="grid-3">{events.slice(0,3).map(e => <div key={e.id} className="mini-event"><strong>{e.title}</strong><small>{e.source} · {dateLabel(e.date)}</small></div>)}</div> : <Empty title="رویدادی ثبت نشده است" />}
        </Panel>
        <ProjectGitHub key={id} projectId={id} />
      </>}
      {tab === 'tasks' && <Panel title="وظایف پروژه"><ProjectTaskRows tasks={tasks} /></Panel>}
      {tab === 'resources' && <Panel title="منابع متصل" action={isOwner && !archived && <Button icon={Plus} onClick={() => setModal('resource')}>افزودن منبع</Button>}><ProjectResourceRows resources={resources} /></Panel>}
      {tab === 'docs' && <Panel title="مستندات پروژه" action={canContribute && <Button icon={Plus} onClick={() => setModal('doc')}>سند جدید</Button>}>{docs.length ? docs.map(d => <Row key={d.id} icon={FolderOpen} title={d.title} href={docHref(d.id)} end={<Pill>{d.type}</Pill>} />) : <Empty title="سندی ثبت نشده است" />}</Panel>}
      {tab === 'activity' && <Panel title="تاریخچه پروژه">{events.length ? events.map(e => <Row key={e.id} icon={Activity} title={e.title} meta={`${e.actor} · ${e.source} · ${dateLabel(e.date)}`} end={undefined} />) : <Empty title="رویدادی ثبت نشده است" />}</Panel>}
      {tab === 'finance' && <Panel title="هزینه‌های پروژه"><Table label="هزینه‌های پروژه" rows={expenses} columns={[
        {label:'شرح',render:e => e.title}, {label:'مبلغ',render:e => amountLabel(e)}, {label:'تاریخ',render:e => dateLabel(e.date)}, {label:'دسترسی',render:() => visibleLink('/finance','همه هزینه‌ها')},
      ]} /></Panel>}
      {isOwner && <div className="flex flex-wrap gap-2">
        <Button variant={archived ? 'soft' : 'danger'} icon={Archive} disabled={!ready} onClick={() => setModal('archive')}>{archived ? 'بازگردانی پروژه' : 'بایگانی پروژه'}</Button>
        {archived && <Button variant="danger" icon={Trash2} disabled={!ready} onClick={() => setModal('delete')}>حذف پروژه</Button>}
      </div>}
    </div>
    {modal === 'edit' && <ProjectForm project={project} onClose={() => setModal(null)} />}
    {modal === 'task' && <TaskForm projectId={id} onClose={() => setModal(null)} />}
    {modal === 'resource' && <ResourceForm projectId={id} openServer={false} onClose={() => setModal(null)} />}
    {modal === 'doc' && <DocForm projectId={id} onClose={() => setModal(null)} />}
    {modal === 'archive' && <Modal title={archived ? 'بازگردانی پروژه' : 'بایگانی پروژه'} onClose={closeModal}>
      <p className="muted">{archived ? 'پروژه در فهرست جاری دوباره نمایش داده می‌شود.' : 'پروژه از فهرست جاری به فیلتر بایگانی منتقل می‌شود.'}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions mt-4"><Button variant={archived ? 'primary' : 'danger'} disabled={saving} onClick={archive}>{archived ? 'بازگردانی' : 'تأیید بایگانی'}</Button><Button disabled={saving} onClick={closeModal}>انصراف</Button></div>
    </Modal>}
    {modal === 'delete' && <Modal title="حذف پروژه" onClose={closeModal}>
      <p className="muted">این کار پروژهٔ بایگانی‌شدهٔ {project.name} را برای همیشه حذف می‌کند. سرور فقط پروژهٔ بدون رکورد وابسته یا منبع مشترک را حذف می‌کند.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions mt-4"><Button variant="danger" disabled={saving} onClick={deleteProject}>تأیید حذف پروژه</Button><Button disabled={saving} onClick={closeModal}>انصراف</Button></div>
    </Modal>}
  </>;
}

