'use client';
import { amountLabel, inputAmount, minorUnits, parseAmount, summaryByCurrency, totalsByCurrency } from '@/lib/money';

import { useState, type FormEvent } from 'react';
import { CalendarDays, ChartNoAxesCombined, CircleAlert, CircleCheck, CreditCard, Download, FileText, FolderKanban, Layers, Plus, ReceiptText, Server, Wallet } from 'lucide-react';
import { csv, dateLabel, download, matches, newId, percent, resourceHref, today } from '@/lib/format';
import { useDemo } from '@/lib/store';
import { allocationId } from '@/lib/shared-cost';
import type { Expense, RecurringCharge, ContractRecord, RevenueEntry, CurrencyUnit } from '@/lib/types';
import { Bars, Donut, Trend } from './charts';
import { ExchangeRates } from './exchange-rates';
import { InvoiceLedger } from './invoice-ledger';
import { ProjectField, ProjectFilter, SelectOptions, projectName } from './forms';
import { Button, Callout, Empty, Field, Filter, FormActions, Heading, Metrics, Modal, Panel, Pill, Progress, Row, SearchField, SectionBar, Table, TextLink, formValues } from './ui';

const categories: Expense['category'][] = ['زیرساخت','دامنه','پشتیبان‌گیری','اشتراک'];

function ExpenseForm({ onClose, initial, projectId }: { onClose: () => void; initial?: Expense; projectId: string }) {
  const { change, saving } = useDemo();
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    const get = formValues(event);
    if (!get('name')) { setError('شرح هزینه را وارد کنید.'); return; }
    const currency=get('currency') as CurrencyUnit;
    const amount=parseAmount(get('amount'),currency);
    if(amount===undefined||amount<1){setError('مبلغ یا اعشار با ارز انتخابی سازگار نیست.');return;}
    const expense: Expense = { id:initial?.id ?? newId('expense'), title:get('name'), projectId:get('project'), category:get('category') as Expense['category'], amount,currency,amountUnit:'minor', date:get('date'), status:get('status') as Expense['status'] };
    setError('');
    const saved = await change(data => ({ ...data,expenses:initial ? data.expenses.map(e => e.id === initial.id ? expense : e) : [expense,...data.expenses] }),
      'هزینه ذخیره شد.',{ projectId:expense.projectId, title:initial ? 'هزینه ویرایش شد' : 'هزینه ثبت شد',detail:expense.title,source:'مالی' });
    if (!saved) { setError('ذخیرهٔ هزینه تأیید نشد.'); return; }
    onClose();
  }
  return <Modal title={initial ? 'ویرایش هزینهٔ' : 'هزینه جدید'} onClose={onClose}><form className="form-stack" onSubmit={submit}>
    <Field label="شرح هزینه"><input autoFocus name="name" required maxLength={100} defaultValue={initial?.title} /></Field>
    <ProjectField initial={initial?.projectId ?? projectId} />
    <div className="form-grid">
      <Field label="دسته‌بندی"><select name="category" defaultValue={initial?.category}><SelectOptions options={categories} /></select></Field>
      <Field label="واحد ارز"><select name="currency" defaultValue={initial?.currency??'TOMAN'}><option value="TOMAN">تومان</option><option value="IRR">ریال</option><option value="USD">دلار</option></select></Field>
      <Field label="مبلغ"><input dir="ltr" name="amount" inputMode="decimal" maxLength={16} required defaultValue={initial?inputAmount(initial):undefined} /></Field>
      <Field label="تاریخ (میلادی)"><input dir="ltr" type="date" name="date" required defaultValue={initial?.date ?? today()} /></Field>
      <Field label="وضعیت پرداخت"><select name="status" defaultValue={initial?.status}><option value="upcoming">پیش رو</option><option value="paid">پرداخت‌شده</option></select></Field>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <FormActions onClose={onClose} saving={saving} submit="ذخیره هزینه" />
  </form></Modal>;
}

function SharedCostForm({onClose}:{onClose:()=>void}) {
  const {data}=useDemo();
  const [reference]=useState(()=>crypto.randomUUID());
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const resources=data.resources.filter(resource=>resource.linkedProjectIds?.some(id=>id!==resource.projectId));
  async function submit(event:FormEvent<HTMLFormElement>) {
    const get=formValues(event);
    const currency=get('currency') as CurrencyUnit;
    const amount=parseAmount(get('amount'),currency);
    if (!amount) {setError('مبلغ باید مثبت و متناسب با ارز باشد.');return;}
    setSaving(true);setError('');
    try {
      const response=await fetch('/api/shared-costs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        reference,resourceId:get('resource'),title:get('title'),amount,currency,date:get('date'),
      })});
      if (response.ok) {window.location.reload();return;}
      setError(response.status===409?'ثبت قبلی یا تغییر هم‌زمان پیدا شد. صفحه را تازه کنید.':'ثبت سهم هزینه تأیید نشد.');
    } catch {setError('ثبت سهم هزینه تأیید نشد.');}
    finally {setSaving(false);}
  }
  return <Modal title="تخصیص هزینهٔ مشترک" onClose={onClose}><form className="form-stack" onSubmit={submit}>
    <Field label="منبع مشترک"><select required name="resource"><option value="">انتخاب منبع</option>
      {resources.map(resource=><option key={resource.id} value={resource.id}>{resource.name}</option>)}
    </select></Field>
    <Field label="شرح هزینه"><input name="title" maxLength={160} required/></Field>
    <Field label="واحد ارز"><select name="currency"><SelectOptions options={['TOMAN','IRR','USD']}/></select></Field>
    <Field label="مبلغ کل"><input name="amount" inputMode="decimal" required dir="ltr"/></Field>
    <Field label="تاریخ (میلادی)"><input name="date" type="date" required defaultValue={today()} dir="ltr"/></Field>
    <p className="muted">مبلغ یک‌بار ثبت و به‌طور مساوی بین پروژه‌های مرتبط تقسیم می‌شود.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <FormActions onClose={onClose} saving={saving} submit="ثبت تخصیص"/>
  </form></Modal>;
}

export function Finance() {
  const { data, projectScope, setProjectScope } = useDemo();
  const canWrite = data.users[0]?.role === 'Owner';
  const [category,setCategory] = useState('');
  const [status,setStatus] = useState('');
  const [query,setQuery] = useState('');
  const [chartCurrency,setChartCurrency]=useState<CurrencyUnit>('TOMAN');
  const [from,setFrom] = useState('');
  const [to,setTo] = useState('');
  const [show,setShow] = useState(false);
  const [allocating,setAllocating]=useState(false);
  const [edit,setEdit] = useState<Expense>();
  const [newFinance,setNewFinance]=useState<'charge'|'contract'|'revenue'|null>(null);
  const invalidRange = !!(from && to && from > to);
  const items = data.expenses.filter(e => (!projectScope || e.projectId === projectScope) && (!category || e.category === category) && (!status || e.status === status)
    && (!from || e.date >= from) && (!to || e.date <= to) && matches(query,e.title,e.category)).sort((a,b) => b.date.localeCompare(a.date));
  const chartItems=items.filter(item=>(item.currency??'TOMAN')===chartCurrency);
  const chartValue=(value:bigint)=>Number(value)/(chartCurrency==='USD'?100:1);
  const monthTotals = new Map<string,number>();
  [...chartItems].reverse().forEach(e => {
    const key = dateLabel(e.date,{month:'short',year:'2-digit'});
    monthTotals.set(key,(monthTotals.get(key) ?? 0) + chartValue(minorUnits(e)));
  });
  const bars = Array.from(monthTotals, ([label,value]) => ({label,value})).slice(-12);
  const split = categories.map(label => ({label,value:chartItems.filter(e=>e.category===label).reduce((total,e)=>total+chartValue(minorUnits(e)),0)})).filter(e => e.value);

  return <>
    <Heading title="هزینه‌ها و قراردادها" subtitle="ثبت هزینه‌های  زیرساخت، اشتراک‌ها و تمدید هر پروژه">
      {canWrite && <Button variant="primary" icon={Plus} onClick={() => setShow(true)}>هزینه جدید</Button>}
      {canWrite && data.resources.some(resource=>resource.linkedProjectIds?.length) && <Button onClick={()=>setAllocating(true)}>تخصیص هزینهٔ مشترک</Button>}
    </Heading>
    <Metrics entries={[
      {label:'مجموع هزینه‌های',value:summaryByCurrency(items),note:'براساس فیلترهای جاری',icon:Wallet},
      {label:'هزینه زیرساخت',value:summaryByCurrency(items.filter(e=>e.category==='زیرساخت')),note:'سرورها و میزبانی',icon:Server},
      {label:'اشتراک‌ها',value:items.filter(e => e.category === 'اشتراک').length,note:'اقلام اشتراک',icon:CreditCard},
      {label:'پرداخت‌های پیش رو',value:items.filter(e => e.status === 'upcoming').length,note:'سررسیدهای',icon:CalendarDays},
    ]} />
    <SectionBar title="فیلتر هزینه‌ها" />
    <div className="toolbar finance-filters"><SearchField label="جست‌وجوی هزینه" value={query} onChange={setQuery} /><ProjectFilter value={projectScope} onChange={setProjectScope} />
      <Filter label="دسته‌بندی هزینه" value={category} onChange={setCategory} options={[{value:'',label:'همه دسته‌ها'},...categories.map(value => ({value,label:value}))]} />
      <Filter label="وضعیت پرداخت" value={status} onChange={setStatus} options={[{value:'',label:'همه پرداخت‌ها'},{value:'paid',label:'پرداخت‌شده'},{value:'upcoming',label:'پیش رو'}]} />
      <Field label="ارز نمودارها"><select value={chartCurrency} onChange={e=>setChartCurrency(e.target.value as CurrencyUnit)}>
        <option value="TOMAN">تومان</option><option value="IRR">ریال</option><option value="USD">دلار</option>
      </select></Field>
      <Field label="از تاریخ (میلادی)"><input type="date" value={from} onInput={e => setFrom(e.currentTarget.value)} dir="ltr" /></Field>
      <Field label="تا تاریخ (میلادی)"><input type="date" value={to} onInput={e => setTo(e.currentTarget.value)} dir="ltr" /></Field>
    </div>
    {invalidRange ? <Panel><p className="form-error" role="alert">تاریخ پایان باید برابر یا پس از تاریخ شروع باشد.</p></Panel> : <div className="stack">
      <div className="split">
        <Panel title="روند هزینه‌ها" action={<TextLink href="/reports">گزارش‌ها</TextLink>}>
          {bars.length ? <Bars entries={bars} label="مجموع هزینه‌های به تفکیک ماه" /> : <Empty title="داده‌ای در این بازه وجود ندارد" />}
        </Panel>
        <Panel title="توزیع هزینه‌های">{split.length ? <Donut entries={split} display={summaryByCurrency(chartItems)} /> : <Empty title="هزینه‌ای پیدا نشد" />}</Panel>
      </div>
      <Panel title="اشتراک‌های دوره‌ای و موعد تمدید">
        {canWrite && <div className="flex justify-end"><Button onClick={()=>setNewFinance('charge')} icon={Plus}>ثبت اشتراک دوره‌ای</Button></div>}
        {data.charges.length?<Table label="اشتراک‌های واقعی ثبت‌شده" rows={data.charges.filter(c=>!projectScope||c.projectId===projectScope)} columns={[
          {label:'اشتراک',render:c=>c.title},{label:'دوره',render:c=>c.period},{label:'مبلغ',render:c=>amountLabel(c)},
          {label:'منبع',render:c=>{
            const resource = data.resources.find(resource => resource.id === c.linkedResourceId);
            return resource ? <TextLink href={resourceHref(resource)}>{resource.name}</TextLink> : '—';
          }},
          {label:'تمدید بعدی',render:c=>dateLabel(c.nextDue)},{label:'وضعیت',render:c=><Pill tone={c.status==='active'?'good':'neutral'}>{c.status==='active'?'فعال':'متوقف'}</Pill>}
        ]}/>:<Empty title="اشتراک دوره‌ای ثبت نشده است" />}
      </Panel>
      <Panel title="قراردادهای پروژه">
        {canWrite && <div className="flex justify-end"><Button onClick={()=>setNewFinance('contract')} icon={Plus}>ثبت قرارداد</Button></div>}
        {data.contracts.length?<Table label="قراردادها" rows={data.contracts.filter(c=>!projectScope||c.projectId===projectScope)} columns={[
          {label:'قرارداد',render:c=>c.title},{label:'مشتری',render:c=>c.client},{label:'مبلغ',render:c=>amountLabel(c)},
          {label:'پایان',render:c=>dateLabel(c.end)},{label:'وضعیت',render:c=>c.state}
        ]}/>:<Empty title="قراردادی ثبت نشده است" />}
      </Panel>
      <Panel title="درآمدهای ثبت‌شده">
        {canWrite && <div className="flex justify-end"><Button onClick={()=>setNewFinance('revenue')} icon={Plus}>ثبت درآمد</Button></div>}
        {data.revenues.length?<Table label="درآمدهای واقعی ثبت‌شده" rows={data.revenues.filter(c=>!projectScope||c.projectId===projectScope)} columns={[
          {label:'شرح',render:c=>c.title},{label:'مبلغ',render:c=>amountLabel(c)},
          {label:'تاریخ',render:c=>dateLabel(c.date)},{label:'وضعیت',render:c=>c.status==='received'?'دریافت‌شده':'در انتظار'}
        ]}/>:<Empty title="درآمدی ثبت نشده است" />}
      </Panel>
      <InvoiceLedger projectId={projectScope}/>
      <ExchangeRates projectId={projectScope}/>
      <Panel title="فهرست پرداخت‌ها و تمدیدها"><Table label="پرداخت‌های" rows={items} columns={[
        {label:'شرح',render:e => allocationId.test(e.id) ? e.title+' · سهم هزینهٔ مشترک' : canWrite
          ? <button className="cell-link" type="button" onClick={() => setEdit(e)}>{e.title}</button> : e.title},
        {label:'پروژه',render:e => <bdi>{projectName(data,e.projectId)}</bdi>},
        {label:'نوع',render:e => e.category}, {label:'مبلغ',render:e => amountLabel(e)}, {label:'تاریخ',render:e => dateLabel(e.date)},
        {label:'وضعیت',render:e => <Pill tone={e.status === 'paid' ? 'good' : 'warn'}>{e.status === 'paid' ? 'پرداخت‌شده' : 'پیش رو'}</Pill>},
      ]} /></Panel>
    </div>}
    {canWrite && allocating && <SharedCostForm onClose={()=>setAllocating(false)}/>}
    {canWrite && show && <ExpenseForm projectId={projectScope} onClose={() => setShow(false)} />}
    {canWrite && edit && <ExpenseForm projectId={projectScope} initial={edit} onClose={() => setEdit(undefined)} />}
    {canWrite && newFinance && <AdditionalFinanceForm kind={newFinance} projectId={projectScope} onClose={()=>setNewFinance(null)} />}
  </>;
}

function AdditionalFinanceForm({kind,projectId,onClose}:{kind:'charge'|'contract'|'revenue';projectId:string;onClose:()=>void}){
  const {data,change,saving}=useDemo();
  const [selectedProject,setSelectedProject]=useState(projectId);
  const [error,setError]=useState('');
  const title={charge:'اشتراک دوره‌ای',contract:'قرارداد',revenue:'درآمد'}[kind];
  const resources = kind === 'charge' && selectedProject
    ? data.resources.filter(resource => resource.projectId === selectedProject || resource.linkedProjectIds?.includes(selectedProject))
    : [];
  async function submit(event:FormEvent<HTMLFormElement>){
    const get=formValues(event);
    const currency=get('currency') as CurrencyUnit;
    const amount=parseAmount(get('amount'),currency);
    if(amount===undefined){setError('مبلغ یا اعشار با ارز انتخابی سازگار نیست.');return;}
    if(kind==='contract'&&get('end')<get('start')){setError('تاریخ پایان قرارداد نمی‌تواند پیش از شروع باشد.');return;}
    setError('');
    const common={id:newId(kind),projectId:get('project'),title:get('title'),amount,currency,amountUnit:'minor' as const};
    let saved: boolean;
    if(kind==='charge'){
      const charge:RecurringCharge={...common,provider:get('provider'),period:get('period') as RecurringCharge['period'],
        nextDue:get('nextDue'),status:'active',linkedResourceId:get('resource') || undefined};
      saved = await change(prev=>({...prev,charges:[...prev.charges,charge]}),'اشتراک ثبت شد.',{projectId:charge.projectId,title:'ثبت اشتراک',source:'مالی'});
    }else if(kind==='contract'){
      const contract:ContractRecord={...common,client:get('client'),start:get('start'),end:get('end'),state:'active'};
      saved = await change(prev=>({...prev,contracts:[...prev.contracts,contract]}),'قرارداد ثبت شد.',{projectId:contract.projectId,title:'ثبت قرارداد',source:'مالی'});
    }else{
      const revenue:RevenueEntry={...common,date:get('date'),status:get('status') as RevenueEntry['status']};
      saved = await change(prev=>({...prev,revenues:[...prev.revenues,revenue]}),'درآمد ثبت شد.',{projectId:revenue.projectId,title:'ثبت درآمد',source:'مالی'});
    }
    if (!saved) { setError('ثبت اطلاعات مالی تأیید نشد.'); return; }
    onClose();
  }
  return <Modal title={`ثبت ${title}`} onClose={onClose}><form onSubmit={submit} className="form-stack">
    <Field label="عنوان"><input name="title" maxLength={160} required /></Field>
    <ProjectField initial={projectId} onChange={setSelectedProject}/>
    <div className="form-grid">
      <Field label="مبلغ (دلار تا دو رقم اعشار)"><input name="amount" maxLength={16} inputMode="decimal" required dir="ltr" /></Field>
      <Field label="واحد ارز"><select name="currency" defaultValue="TOMAN"><option value="TOMAN">تومان</option><option value="IRR">ریال</option><option value="USD">دلار</option></select></Field>
    </div>
    {kind==='charge'&&<><Field label="ارائه‌دهنده"><input name="provider" maxLength={120} required /></Field>
      <Field label="منبع مرتبط"><select key={selectedProject} name="resource">
        <option value="">بدون منبع مرتبط</option>
        {resources.map(resource => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
      </select></Field>
      <Field label="دوره پرداخت"><select name="period"><option value="monthly">ماهانه</option><option value="quarterly">سه‌ماهه</option><option value="yearly">سالانه</option></select></Field>
      <Field label="موعد بعدی (میلادی)"><input type="date" name="nextDue" defaultValue={today()} required dir="ltr" /></Field></>}
    {kind==='contract'&&<><Field label="نام مشتری"><input name="client" maxLength={160} required /></Field>
      <Field label="شروع (میلادی)"><input name="start" type="date" defaultValue={today()} dir="ltr" required /></Field>
      <Field label="پایان (میلادی)"><input name="end" type="date" defaultValue={today()} dir="ltr" required /></Field></>}
    {kind==='revenue'&&<><Field label="تاریخ (میلادی)"><input name="date" type="date" defaultValue={today()} dir="ltr" required /></Field>
      <Field label="وضعیت"><select name="status"><option value="received">دریافت‌شده</option><option value="outstanding">در انتظار</option></select></Field></>}
    <Callout>اطلاعات مالی و نرخ تبدیل به‌صورت دستی ثبت می‌شوند. تأیید بانکی و صدور فاکتور رسمی به سرویس بیرونی نیاز دارند.</Callout>
    {error && <p className="form-error" role="alert">{error}</p>}
    <FormActions onClose={onClose} saving={saving} submit={`ثبت ${title}`} />
  </form></Modal>;
}

const periods = [{value:'all',label:'همه موعدها'},{value:'current',label:'ماه جاری'}];
export function Reports() {
  const { data, projectScope, setProjectScope, notice } = useDemo();
  const [range,setRange] = useState('all');
  const time = range === 'current' ? dateLabel(today(),{month:'long',year:'numeric'}) : '';
  const within = (date: string) => !time || dateLabel(date,{month:'long',year:'numeric'}) === time;
  const projects = data.projects.filter(p => p.status !== 'archived' && (!projectScope || p.id === projectScope));
  const tasks = data.tasks.filter(t => projects.some(p => p.id === t.projectId) && within(t.due));
  const expenses = data.expenses.filter(e => projects.some(p => p.id === e.projectId) && within(e.date));
  const missing = data.resources.filter(r => projects.some(p => p.id === r.projectId) && r.status !== 'registered');
  const rates = projects.map(p => ({
    project:p.name,
    value:Math.min(100,Math.round(data.docs.filter(d => d.projectId === p.id).length / 3 * 100)),
  }));
  const rate = tasks.length ? Math.round(tasks.filter(t => t.status === 'done').length / tasks.length * 100) : 0;
  const slots = [...new Set(tasks.map(t => t.due))].sort();
  const trend = slots.map(day => tasks.filter(t => t.status === 'done' && t.due <= day).length);
  function exportReport() {
    const rows: (string | number)[][] = [
      ['شاخص','مقدار'],['بازه',periods.find(p => p.value === range)?.label ?? ''],['پروژه‌های فعال',projects.length],
      ['وظایف تکمیل‌شده (درصد)',rate],['منابع نیازمند بازبینی',missing.length],...Array.from(totalsByCurrency(expenses),([unit,minor])=>['هزینه در واحد پایه · '+unit,minor.toString()]),
      ...rates.map(({project,value}) => [`پوشش سند · ${project}`,value]),
    ];
    download('projectos-report.csv',csv(rows),'text/csv;charset=utf-8');
    notice('گزارش آمادهٔ دانلود شد.');
  }
  return <>
    <Heading title="گزارش‌ها و تحلیل" subtitle="پیشرفت وظایف، هزینه‌ها و کامل بودن اطلاعات پروژه‌ها">
      <Button variant="primary" icon={Download} onClick={exportReport}>خروجی گزارش</Button>
    </Heading>
    <div className="stack">
      <Metrics entries={[
        {label:'پروژه‌های فعال',value:projects.length,note:'در محدودهٔ پروژه',icon:FolderKanban},
        {label:'وظایف انجام‌شده',value:percent(rate),note:'بر اساس موعد در بازه',icon:CircleCheck},
        {label:'هزینه‌های',value:summaryByCurrency(expenses),note:'جمع بازه انتخابی',icon:ReceiptText},
        {label:'منابع نیازمند بررسی',value:missing.length,note:'بررسی فراداده',icon:CircleAlert},
      ]} />
      <div className="control-group"><ProjectFilter value={projectScope} onChange={setProjectScope} /><Filter label="بازه گزارش" value={range} onChange={setRange} options={periods} /></div>
      <div className="grid-2">
        <Panel title="روند وظایف تکمیل‌شده" action={<TextLink href="/tasks">وظایف</TextLink>}>
          {slots.length > 1 ? <Trend values={trend} label="تعداد تجمعی کارهای تکمیل‌شده بر اساس موعد" start={dateLabel(slots[0])} end={dateLabel(slots.at(-1)!)} /> :
            <Empty title="دادهٔ کافی برای نمایش روند وجود ندارد" detail="بازه یا پروژهٔ دیگری را انتخاب کنید." />}
        </Panel>
        <Panel title="پوشش مستندات پروژه‌ها" action={<TextLink href="/docs">مستندات</TextLink>}>
          {rates.length ? <div className="stack">{rates.map(r => <Progress key={r.project} value={r.value} label={r.project} />)}<small className="muted">هدف برای هر پروژه ۳ سند است.</small></div> :
            <Empty title="پروژه‌ای در این محدوده وجود ندارد" />}
        </Panel>
      </div>
      <Panel title="پیشنهادهای بهبود کیفیت اطلاعات">
        {missing.length ? missing.map(r => <Row key={r.id} icon={Layers} title={`بازبینی اطلاعات ${r.name}`} meta={projectName(data,r.projectId)}
          href={r.type === 'server' ? `/infrastructure/servers/${r.id}` : `/infrastructure?resource=${r.id}`} end={<Pill tone="warn">نیازمند بررسی</Pill>} />) :
          <Empty title="مورد پیشنهادی وجود ندارد" />}
        {!tasks.length && <Row icon={ChartNoAxesCombined} title="داده‌ای از وظایف در بازهٔ انتخابی وجود ندارد" />}
        {!rates.some(r => r.value) && <Row icon={FileText} title="ثبت مستندات پروژه" href="/docs" />}
      </Panel>
    </div>
  </>;
}
