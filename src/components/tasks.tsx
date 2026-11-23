'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AlertCircle, CalendarDays, Check, ChevronDown, Clock3, LayoutGrid, Link2, List, ListTodo, MessageSquare, Pencil, Plus } from 'lucide-react';
import { dateLabel, matches, now, number, projectHref, taskHref } from '@/lib/format';
import { choices, priorities, priorityTones, taskStatuses, taskTones } from '@/lib/labels';
import { useDemo } from '@/lib/store';
import type { Task, TaskStatus } from '@/lib/types';
import { ProjectFilter, TaskForm, projectName } from './forms';
import { Button, Empty, Field, Filter, Heading, LinkButton, Metrics, Panel, Pill, Row, SearchField, SectionBar, Segments, Table } from './ui';

const statuses = Object.keys(taskStatuses) as TaskStatus[];
const initialColumnSize = 3;
const priorityOrder = { high:0, medium:1, low:2 };

function TaskCard({ task }: { task: Task }) {
  const { data } = useDemo();
  const owner = data.users.find(u => u.id === task.owner)?.name ?? 'بدون مسئول';
  return <Link className="task-card" href={taskHref(task.id)}>
    <Pill><bdi>{projectName(data,task.projectId)}</bdi></Pill>
    <strong>{task.title}</strong><p>{task.description || 'بدون شرح'}</p>
    <div className="task-card-end"><span className={`ink-${priorityTones[task.priority]}`}>اولویت {priorities[task.priority]}</span><span>{owner} · {dateLabel(task.due)}</span></div>
  </Link>;
}

export function Tasks() {
  const { data, projectScope, setProjectScope } = useDemo();
  const [view, setView] = useState<'kanban' | 'list'>('kanban');
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('');
  const [expanded, setExpanded] = useState<Partial<Record<TaskStatus, boolean>>>({});
  const [create, setCreate] = useState<TaskStatus | null>(null);
  const scoped = data.tasks.filter(t => !projectScope || t.projectId === projectScope);
  const visible = scoped.filter(t => (!priority || t.priority === priority) && (!status || t.status === status) && matches(query,t.title,t.id,t.description));
  if (sort === 'due') visible.sort((a,b) => a.due.localeCompare(b.due));
  if (sort === 'priority') visible.sort((a,b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  return <>
    <Heading title="مدیریت وظایف" subtitle="تسک‌ها، باگ‌ها و تصمیم‌های باقی‌مانده از تمام پروژه‌ها">
      <Button variant="primary" icon={Plus} onClick={() => setCreate('todo')}>وظیفه جدید</Button>
    </Heading>
    <Metrics entries={[
      {label:'وظایف باز',value:scoped.filter(t => t.status !== 'done').length,note:`در ${number(new Set(scoped.map(t => t.projectId)).size)} پروژه`, icon:ListTodo},
      {label:'در حال انجام',value:scoped.filter(t => t.status === 'doing').length,note:'در جریان کار',icon:Clock3},
      {label:'اولویت بالا',value:scoped.filter(t => t.status !== 'done' && t.priority === 'high').length,note:'نیازمند رسیدگی',icon:AlertCircle},
      {label:'تکمیل‌شده',value:scoped.filter(t => t.status === 'done').length,note:'وضعیت ثبت‌شده',icon:Check,tone:'good'},
    ]} />
    <SectionBar title="برد وظایف"><Segments label="نمای وظایف" value={view} onChange={setView} options={[{value:'kanban',label:'نمای کانبان',icon:LayoutGrid},{value:'list',label:'نمای فهرست',icon:List}]} /></SectionBar>
    <div className="toolbar">
      <SearchField label="جست‌وجوی وظیفه" value={query} onChange={setQuery} />
      <ProjectFilter value={projectScope} onChange={setProjectScope} />
      <Filter label="فیلتر اولویت" value={priority} onChange={setPriority} options={[{value:'',label:'همه اولویت‌ها'},...choices(priorities)]} />
      <Filter label="فیلتر وضعیت" value={status} onChange={setStatus} options={[{value:'',label:'همه وضعیت‌ها'},...choices(taskStatuses)]} />
      <Filter label="مرتب‌سازی وظایف" value={sort} onChange={setSort} options={[{value:'',label:'ترتیب ثبت'},{value:'due',label:'نزدیک‌ترین موعد'},{value:'priority',label:'بالاترین اولویت'}]} />
    </div>
    {view === 'kanban' ? <div className="grid-3 kanban">{statuses.filter(key => !status || key === status).map(key => {
      const items = visible.filter(t => t.status === key);
      const display = expanded[key] || query.trim() ? items : items.slice(0, initialColumnSize);
      return <Panel key={key} className="kanban-column">
        <div className="kanban-title"><h2><span className={`status-dot ink-${taskTones[key]}`} style={{background:'currentColor'}} />{taskStatuses[key]}</h2>
          <small>{number(items.length)} وظیفه</small></div>
        {display.map(t => <TaskCard key={t.id} task={t} />)}
        {!items.length && <Empty title="وظیفه‌ای در این وضعیت نیست" />}
        <div className="control-group">
          <Button variant="ghost" icon={Plus} onClick={() => setCreate(key)}>افزودن وظیفه</Button>
          {!query.trim() && items.length > initialColumnSize && <Button variant="ghost" aria-expanded={!!expanded[key]}
            onClick={() => setExpanded(old => ({ ...old,[key]:!old[key] }))}>
            {expanded[key] ? 'نمایش کمتر' : `نمایش ${number(items.length - initialColumnSize)} وظیفهٔ دیگر`}
          </Button>}
        </div>
      </Panel>;
    })}</div> : <Panel title="فهرست وظایف"><Table label="فهرست وظایف" rows={visible} columns={[
      {label:'وظیفه',render:t => <Link className="cell-link" href={taskHref(t.id)}>{t.title}</Link>},
      {label:'پروژه',render:t => <bdi>{projectName(data,t.projectId)}</bdi>},
      {label:'وضعیت',render:t => <Pill tone={taskTones[t.status]}>{taskStatuses[t.status]}</Pill>},
      {label:'اولویت',render:t => <Pill tone={priorityTones[t.priority]}>{priorities[t.priority]}</Pill>},
      {label:'مسئول',extra:true,render:t => data.users.find(u => u.id === t.owner)?.name ?? '—'},
      {label:'موعد',render:t => dateLabel(t.due)},
    ]} /></Panel>}
    {create && <TaskForm onClose={() => setCreate(null)} projectId={projectScope} status={create} />}
  </>;
}

export function TaskDetails({ id }: { id: string }) {
  const { data, change, notice } = useDemo();
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState('');
  const [posting, setPosting] = useState(false);
  const task = data.tasks.find(t => t.id === id);
  if (!task) return <Empty title="وظیفه پیدا نشد" detail="شناسه وظیفه را بررسی کنید." action={<LinkButton href="/tasks">فهرست وظایف</LinkButton>} />;
  const item = task;
  const completed = item.checklist.filter(check => check.checked).length;
  const events = data.events.filter(e => e.projectId === item.projectId && e.source === 'وظایف' && (e.detail.includes(item.id) || e.detail.includes(item.title)));

  function update(updateTask: (previous: Task) => Task, message: string, eventTitle?: string) {
    return change(previous => ({ ...previous, tasks:previous.tasks.map(t => t.id === item.id ? updateTask(t) : t) }),
      message, eventTitle ? {projectId:item.projectId,title:eventTitle,detail:`${item.id} · ${item.title}`,source:'وظایف'} : undefined);
  }
  async function post(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (posting) return;
    const submitted = comment;
    const text = submitted.trim();
    if (!text) { notice('متن یادداشت را وارد کنید.'); return; }
    const date = now();
    setPosting(true);
    try {
      const saved = await update(t => ({ ...t, comments:[...t.comments,{text,date}] }), 'یادداشت ثبت شد.', 'یادداشت وظیفه ثبت شد');
      if (saved) setComment(current => current === submitted ? '' : current);
    } finally { setPosting(false); }
  }

  return <>
    <Heading title={item.title} subtitle={<><Link className="cell-link" href={projectHref(item.projectId)}><bdi>{projectName(data,item.projectId)}</bdi></Link> · <bdi dir="ltr">{item.id}</bdi></>}>
      <label className="status-control"><ChevronDown aria-hidden="true" size={14} /><select aria-label="تغییر وضعیت وظیفه" value={item.status}
        onChange={e => {
          const value = e.target.value as TaskStatus;
          update(t => ({ ...t,status:value }), 'وضعیت وظیفه تغییر کرد.', `وضعیت وظیفه به «${taskStatuses[value]}» تغییر کرد`);
        }}>{statuses.map(key => <option key={key} value={key}>{taskStatuses[key]}</option>)}</select></label>
      <Button variant="primary" icon={Pencil} onClick={() => setEditing(true)}>ویرایش وظیفه</Button>
    </Heading>
    <div className="split">
      <Panel className="stack">
        <div className="flex items-center justify-between gap-2"><Pill tone={taskTones[item.status]} dot>{taskStatuses[item.status]}</Pill><Pill tone={priorityTones[item.priority]}>اولویت {priorities[item.priority]}</Pill></div>
        <div className="task-description"><h2>شرح وظیفه</h2><p>{item.description || 'هنوز شرحی برای این وظیفه ثبت نشده است.'}</p></div>
        <section>
          <div className="panel-heading"><h2>چک‌لیست پذیرش</h2><small className="muted">{number(completed)} از {number(item.checklist.length)} مورد</small></div>
          {item.checklist.length ? item.checklist.map((check,index) => <label className="check-row task-check" key={check.label}><input type="checkbox" checked={check.checked} onChange={e => {
            const checked = e.target.checked;
            update(t => ({...t,checklist:t.checklist.map((c,i) => i === index ? {...c,checked} : c)}),'چک‌لیست به‌روزرسانی شد.');
          }} />{check.label}</label>) : <p className="muted">چک‌لیستی ثبت نشده است.</p>}
        </section>
        <section className="stack"><h2 className="section-title">یادداشت‌ها</h2>
          {item.comments.map((comment,index) => <Row key={index} title={comment.text} meta={dateLabel(comment.date)} icon={MessageSquare} />)}
          <form className="form-stack" onSubmit={post}><Field label="یادداشت جدید"><textarea name="comment" value={comment}
            onChange={event=>setComment(event.target.value)} rows={3} required maxLength={500} placeholder="نتیجهٔ بررسی یا تصمیم مرتبط را ثبت کنید…" /></Field>
            <div><Button type="submit" icon={Plus} disabled={posting}>ثبت یادداشت</Button></div>
          </form>
        </section>
      </Panel>
      <div className="stack">
        <Panel title="اطلاعات وظیفه">
          <Row icon={ListTodo} title="پروژه" meta={<bdi>{projectName(data,item.projectId)}</bdi>} href={projectHref(item.projectId)} />
          <Row icon={CalendarDays} title="موعد" meta={dateLabel(item.due,{day:'numeric',month:'long',year:'numeric'})} />
          <Row icon={Check} title="مسئول" meta={data.users.find(u => u.id === item.owner)?.name ?? 'بدون مسئول'} />
          <h3 className="section-title mt-3">وابستگی‌ها</h3>
          {item.dependencies.length ? item.dependencies.map(dependency => <Row key={dependency} icon={Link2} title={data.tasks.find(t => t.id === dependency)?.title ?? dependency} href={taskHref(dependency)} />) : <p className="muted mt-2">وابستگی ثبت نشده است.</p>}
        </Panel>
        <Panel title="تاریخچه">
          {events.length ? <ol className="timeline">{events.slice(0,5).map(e => <li key={e.id}><strong>{e.title}</strong><small>{e.actor} · {dateLabel(e.date)}</small></li>)}</ol> : <Empty title="رویدادی ثبت نشده است" />}
        </Panel>
      </div>
    </div>
    {editing && <TaskForm task={item} onClose={() => setEditing(false)} />}
  </>;
}
