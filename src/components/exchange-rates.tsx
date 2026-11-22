'use client';

import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { convertAtRate, parseRate } from '@/lib/exchange-rate';
import { dateLabel, newId } from '@/lib/format';
import { currencies, formatMoney, parseAmount } from '@/lib/money';
import { useDemo } from '@/lib/store';
import type { CurrencyUnit, ExchangeRate } from '@/lib/types';
import { ProjectField, projectName } from './forms';
import { Button, Empty, Field, FormActions, Modal, Panel, formValues } from './ui';

function RateForm({projectId,onClose}:{projectId:string;onClose:()=>void}) {
  const {change,saving}=useDemo();
  const [error,setError]=useState('');
  async function submit(event:FormEvent<HTMLFormElement>) {
    const get=formValues(event);
    const from=get('from') as CurrencyUnit,to=get('to') as CurrencyUnit;
    const rate=parseRate(get('rate'));
    const date=new Date(get('observedAt')+'Z');
    if (from===to || !rate || !Number.isFinite(date.getTime()) || date.getTime()>Date.now()) {
      setError('ارزهای متفاوت، نرخ مثبت و زمان مشاهدهٔ معتبر وارد کنید.');return;
    }
    const quote:ExchangeRate={id:newId('rate'),projectId:get('project'),from,to,rate:rate.text,
      source:get('source'),observedAt:date.toISOString()};
    setError('');
    if (!await change(data=>({...data,exchangeRates:[...data.exchangeRates,quote]}),'نرخ تبدیل ثبت شد.')) {
      setError('ثبت نرخ تبدیل تأیید نشد.');return;
    }
    onClose();
  }
  return <Modal title="ثبت نرخ تبدیل" onClose={onClose}><form className="form-stack" onSubmit={submit}>
    <ProjectField initial={projectId}/>
    <div className="form-grid">
      <Field label="ارز مبدأ"><select name="from" defaultValue="USD" dir="ltr">
        {currencies.map(currency=><option key={currency}>{currency}</option>)}
      </select></Field>
      <Field label="ارز مقصد"><select name="to" defaultValue="TOMAN" dir="ltr">
        {currencies.map(currency=><option key={currency}>{currency}</option>)}
      </select></Field>
      <Field label="نرخ برای یک واحد ارز مبدأ"><input name="rate" inputMode="decimal" dir="ltr" maxLength={23} required/></Field>
      <Field label="زمان مشاهده (میلادی، UTC)"><input name="observedAt" type="datetime-local" dir="ltr" required/></Field>
    </div>
    <Field label="نام منبع و شناسهٔ مرجع"><input name="source" maxLength={160} required dir="auto"/></Field>
    {error && <p className="form-error" role="alert">{error}</p>}
    <FormActions onClose={onClose} saving={saving} submit="ذخیرهٔ نرخ"/>
  </form></Modal>;
}

export function ExchangeRates({projectId}:{projectId:string}) {
  const {data}=useDemo();
  const [creating,setCreating]=useState(false);
  const [picked,setPicked]=useState('');
  const [clock]=useState(()=>Date.now());
  const [refreshing,setRefreshing]=useState(false);
  const [refreshError,setRefreshError]=useState('');
  async function refresh() {
    setRefreshing(true);setRefreshError('');
    try {
      const response=await fetch('/api/exchange-rates/refresh',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({projectId})});
      if (response.ok) {window.location.reload();return;}
      setRefreshError(response.status===429?'سقف دریافت نرخ پر شده است. بعداً دوباره تلاش کنید.':'دریافت خودکار در دسترس نیست.');
    } catch {setRefreshError('دریافت خودکار در دسترس نیست.');}
    finally {setRefreshing(false);}
  }
  const [draft,setDraft]=useState({quoteId:'',amount:''});
  const quotes=data.exchangeRates.filter(quote=>!projectId||quote.projectId===projectId)
    .sort((a,b)=>b.observedAt.localeCompare(a.observedAt));
  const selected=quotes.find(quote=>quote.id===picked) ?? quotes[0];
  const amount=selected?.id===draft.quoteId ? draft.amount : '';
  const sourceAmount=selected?parseAmount(amount,selected.from):undefined;
  const converted=selected&&sourceAmount!==undefined?convertAtRate(BigInt(sourceAmount),selected):undefined;
  const describe=(quote:ExchangeRate)=>quote.from+' → '+quote.to+' · '+projectName(data,quote.projectId)+' · '+quote.source;
  return <>
    <Panel title="تبدیل ارز با نرخ ثبت‌شده" action={data.users[0]?.role==='Owner'
      && <div className="control-group"><Button icon={Plus} onClick={()=>setCreating(true)}>ثبت نرخ تبدیل</Button>
        {projectId && <Button disabled={refreshing} onClick={refresh}>{refreshing?'در حال دریافت…':'دریافت USD به IRR'}</Button>}</div>}>
      {refreshError && <p className="form-error" role="alert">{refreshError}</p>}
      {selected ? <div className="form-stack">
        <Field label="نرخ ثبت‌شده"><select value={selected.id} onChange={event=>{setPicked(event.currentTarget.value);setDraft({quoteId:'',amount:''});}}>
          {quotes.map(quote=><option key={quote.id} value={quote.id}>{describe(quote)} · {dateLabel(quote.observedAt,
            {dateStyle:'medium',timeStyle:'short'},data.preferences.zone)}</option>)}
        </select></Field>
        <dl className="form-grid key-values">
          <div><dt>نرخ مشاهده‌شده</dt><dd><bdi>{selected.rate} {selected.to} / {selected.from}</bdi></dd></div>
          <div><dt>منبع ثبت‌شده</dt><dd><bdi>{selected.source}</bdi></dd></div>
          <div><dt>زمان مشاهده</dt><dd><time dateTime={selected.observedAt}>
            {dateLabel(selected.observedAt,{dateStyle:'medium',timeStyle:'short'},data.preferences.zone)}
          </time></dd></div>
          {selected.receivedAt && <div><dt>زمان دریافت</dt><dd>{dateLabel(selected.receivedAt,{dateStyle:'medium',timeStyle:'short'},data.preferences.zone)}</dd></div>}
        </dl>
        {clock-Date.parse(selected.observedAt)>48*60*60_000 && <p className="muted">این نرخ قدیمی است.</p>}
        <Field label={'مبلغ برای تبدیل ('+selected.from+')'}><input value={amount} onChange={event=>setDraft({quoteId:selected.id,amount:event.currentTarget.value})}
          inputMode="decimal" dir="ltr" maxLength={16}/></Field>
        <output aria-live="polite">برآورد با نرخ انتخاب‌شده · {converted===undefined?'—':formatMoney(converted,selected.to)}</output>
      </div> : <Empty title="نرخی برای تبدیل ثبت نشده است"/>}
    </Panel>
    {creating && <RateForm projectId={projectId} onClose={()=>setCreating(false)}/>}
  </>;
}
