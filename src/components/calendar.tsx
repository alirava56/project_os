'use client';

import { useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Flag, ListTodo, Plus } from 'lucide-react';
import { dateLabel, localDate, number, taskHref, today } from '@/lib/format';
import { useDemo } from '@/lib/store';
import { wallClock } from '@/lib/reminder-time';
import type { Reminder } from '@/lib/types';
import { ProjectFilter, ReminderForm, projectName } from './forms';
import { Button, Empty, Heading, IconButton, Metrics, Modal, Panel, Pill, Row, Segments } from './ui';

const days = ['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه','پنجشنبه','جمعه'];
const addDays = (date: Date, count: number) => new Date(date.getFullYear(),date.getMonth(),date.getDate() + count,12);
const asDate = (value: string) => new Date(value + 'T12:00:00');
const calendarPart = new Intl.DateTimeFormat('en-US-u-ca-persian', { day:'numeric' });
function firstDay(date: Date) {
  const day = Number(calendarPart.formatToParts(date).find(part => part.type === 'day')?.value ?? 1);
  return addDays(date, 1 - day);
}
const beforeWeek = (date: Date) => (date.getDay() + 1) % 7;

export function Calendar() {
  const { data, projectScope, setProjectScope } = useDemo();
  const [cursor, setCursor] = useState(()=>today());
  const [mode,setMode] = useState<'month' | 'week'>('month');
  const [selection, setSelection] = useState<string | null>(null);
  const [create, setCreate] = useState<string | null>(null);
  const [editing,setEditing] = useState<Reminder>();
  const canEdit = data.users[0]?.role !== 'Viewer';
  const anchor = asDate(cursor);
  const startOfMonth = firstDay(anchor);
  const afterMonth = firstDay(addDays(startOfMonth,32));
  const start = mode === 'month' ? addDays(startOfMonth,-beforeWeek(startOfMonth)) : addDays(anchor,-beforeWeek(anchor));
  const count = mode === 'month' ? Math.ceil((Math.round((afterMonth.getTime() - start.getTime()) / 86400000)) / 7) * 7 : 7;
  const events = [
    ...data.tasks.map(t => ({id:t.id,title:t.title,due:t.due,kind:'وظیفه',projectId:t.projectId,href:taskHref(t.id),reminder:undefined})),
    ...data.reminders.map(r => ({...r,reminder:r,href:undefined})),
    ...data.resources.flatMap(r => r.expires ? [{id:r.id,title:`تمدید ${r.name}`,due:r.expires,kind:'تمدید',projectId:r.projectId,href:undefined,reminder:undefined}] : []),
  ].filter(e => !projectScope || projectScope === e.projectId).map(e => ({...e,
    day:e.due.includes('T') ? wallClock(e.reminder?.zone ?? data.preferences.zone,new Date(e.due)).slice(0,10) : e.due,
  })).sort((a,b) => a.day.localeCompare(b.day));
  const nextEvents = events.filter(e => e.day >= cursor).slice(0,5);
  const monthEvents = events.filter(e => e.day >= localDate(startOfMonth) && e.day < localDate(afterMonth));
  const move = (direction: number) => setCursor(localDate(mode === 'week' ? addDays(anchor, direction * 7) :
    direction > 0 ? afterMonth : firstDay(addDays(startOfMonth,-1))));

  return <>
    <Heading title="تقویم و برنامه‌ریزی" subtitle="موعد تحویل کارها، تمدید سرویس‌ها و رویدادهای پروژه‌ها">
      {canEdit && <Button variant="primary" icon={Plus} onClick={() => setCreate(cursor)}>رویداد جدید</Button>}
    </Heading>
    <div className="stack">
      <Metrics entries={[
        {label:'رویدادهای ماه',value:monthEvents.length,note:'ماه انتخاب‌شده',icon:CalendarDays},
        {label:'موعدهای تمدید',value:monthEvents.filter(e => e.kind === 'تمدید').length,note:'در اطلاعات ثبت‌شده',icon:Flag},
        {label:'کارهای برنامه‌ریزی‌شده',value:monthEvents.filter(e => e.kind === 'وظیفه').length,note:'با تاریخ تحویل',icon:ListTodo},
      ]} />
      <div className="split">
        <Panel title={dateLabel(cursor,{month:'long',year:'numeric'})} action={<div className="control-group">
          <IconButton icon={ChevronRight} label={mode === 'month' ? 'ماه قبل' : 'هفته قبل'} onClick={() => move(-1)} />
          <Button onClick={() => setCursor(today())}>امروز</Button>
          <IconButton icon={ChevronLeft} label={mode === 'month' ? 'ماه بعد' : 'هفته بعد'} onClick={() => move(1)} />
        </div>}>
          <div className="toolbar"><Segments label="نمای تقویم" value={mode} onChange={setMode} options={[{value:'month',label:'ماه'},{value:'week',label:'هفته'}]} /><ProjectFilter value={projectScope} onChange={setProjectScope} /></div>
          <div className="calendar-grid">
            {days.map(day => <div title={day} key={day} className="calendar-day-name"><span>{day}</span><abbr title={day}>{day[0]}</abbr></div>)}
            {Array.from({length:count},(_,index) => {
              const date = addDays(start,index);
              const value = localDate(date);
              const daily = events.filter(e => e.day === value);
              const outside = date < startOfMonth || date >= afterMonth;
              return <button type="button" key={value} className={`calendar-cell ${outside ? 'outside' : ''} ${value === cursor ? 'selected' : ''}`}
                aria-label={`${dateLabel(value,{day:'numeric',month:'long',year:'numeric'})}، ${number(daily.length)} رویداد`} onClick={() => setSelection(value)}>
                <span>{dateLabel(value,{day:'numeric'})}</span>
                {daily.slice(0,2).map(e => <span className={`calendar-event ${e.kind === 'تمدید' ? 'is-renewal' : ''}`} key={e.id}>{e.title}</span>)}
                {daily.length > 2 && <small className="calendar-more">+{number(daily.length - 2)}</small>}
              </button>;
            })}
          </div>
        </Panel>
        <Panel title="رویدادهای پیش‌رو">
          {nextEvents.length ? nextEvents.map(e => <Row key={e.id} icon={Clock3} title={e.title} meta={<bdi>{projectName(data,e.projectId)}</bdi>}
            end={<Pill>{dateLabel(e.due)}</Pill>} href={e.href} onClick={e.href ? undefined : () => setSelection(e.day)} />) : <Empty title="رویدادی پس از این تاریخ وجود ندارد" />}
        </Panel>
      </div>
    </div>
    {selection && <Modal title={dateLabel(selection,{day:'numeric',month:'long',year:'numeric'})} onClose={() => setSelection(null)}>
      {events.filter(e => e.day === selection).map(e => <Row key={e.id} icon={CalendarDays} title={e.title}
        meta={e.reminder?.paused ? e.kind + ' · متوقف‌شده' : e.kind} href={e.href}
        onClick={canEdit && e.reminder ? () => { setEditing(e.reminder); setSelection(null); } : undefined} />)}
      {!events.some(e => e.day === selection) && <Empty title="رویدادی در این روز ثبت نشده است" />}
      {canEdit && <div className="modal-footer"><Button variant="primary" icon={Plus} onClick={() => { setCreate(selection); setSelection(null); }}>افزودن رویداد در این روز</Button></div>}
    </Modal>}
    {create && <ReminderForm due={create} projectId={projectScope} onClose={() => setCreate(null)} />}
    {editing && <ReminderForm reminder={editing} onClose={() => setEditing(undefined)} />}
  </>;
}
