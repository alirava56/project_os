'use client';

import { useState, type FormEvent } from 'react';
import { Download, Plus } from 'lucide-react';
import { csv, dateLabel, download, newId, today } from '@/lib/format';
import { contractReconciliation, installmentBalances, invoiceBalance, invoicePaymentState } from '@/lib/invoice-ledger';
import { amountLabel, formatMoney, inputAmount, parseAmount } from '@/lib/money';
import { useDemo } from '@/lib/store';
import type { CurrencyUnit, Invoice, InvoiceInstallment, Payment } from '@/lib/types';
import { ProjectField } from './forms';
import { Button, Empty, Field, FormActions, Modal, Panel, Pill, Table, formValues } from './ui';

const directions={receivable:'دریافتنی',payable:'پرداختنی'};
const zero=BigInt(0);
const paymentLabels={void:'باطل',paid:'پرداخت کامل ثبت شده',overdue:'سررسید گذشته',partial:'پرداخت جزئی',unpaid:'پرداخت‌نشده'};

function InvoiceForm({projectId,onClose}:{projectId:string;onClose:()=>void}) {
  const {data,change,saving}=useDemo();
  const [selectedProject,setSelectedProject]=useState(projectId);
  const [currency,setCurrency]=useState<CurrencyUnit>('TOMAN');
  const [count,setCount]=useState(0);
  const [error,setError]=useState('');
  async function submit(event:FormEvent<HTMLFormElement>) {
    const get=formValues(event);
    const currency=get('currency') as CurrencyUnit;
    const amount=parseAmount(get('amount'),currency);
    if (!amount) {setError('مبلغ فاکتور باید مثبت و متناسب با ارز انتخاب‌شده باشد.');return;}
    const installments:InvoiceInstallment[]=[];
    for(let index=0;index<count;index++){
      const installment=parseAmount(get('installment-amount-'+index),currency);
      if (!installment) {setError('مبلغ هر قسط باید مثبت و متناسب با ارز فاکتور باشد.');return;}
      installments.push({dueOn:get('installment-date-'+index),amount:installment});
    }
    installments.sort((a,b)=>a.dueOn.localeCompare(b.dueOn));
    if (installments.length && installments.reduce((total,item)=>total+BigInt(item.amount),zero)!==BigInt(amount)) {
      setError('جمع قسط‌ها باید با مبلغ فاکتور برابر باشد.');return;
    }
    const invoice:Invoice={id:newId('invoice'),projectId:get('project'),reference:get('reference'),title:get('title'),
      direction:get('direction') as Invoice['direction'],amount,currency,amountUnit:'minor',
      issuedOn:get('issuedOn'),dueOn:get('dueOn'),state:'open',contractId:get('contract')||undefined,installments:installments.length ? installments : undefined};
    setError('');
    if (!await change(data=>({...data,invoices:[...data.invoices,invoice]}),'فاکتور ثبت شد.')) {
      setError('ثبت فاکتور تأیید نشد. شمارهٔ فاکتور، تاریخ‌ها و اقساط را بررسی کنید.');return;
    }
    onClose();
  }
  return <Modal title="فاکتور جدید" onClose={onClose}><form className="form-stack" onSubmit={submit}>
    <Field label="عنوان فاکتور"><input name="title" required maxLength={160}/></Field>
    <div className="form-grid">
      <ProjectField initial={projectId} onChange={setSelectedProject}/>
      <Field label="قرارداد مرتبط (اختیاری)"><select key={selectedProject+'-'+currency} name="contract"><option value="">بدون قرارداد</option>
        {data.contracts.filter(item=>item.projectId===selectedProject && item.currency===currency).map(item=><option key={item.id} value={item.id}>{item.title}</option>)}
      </select></Field>
      <Field label="شمارهٔ فاکتور"><input name="reference" required maxLength={100} dir="auto"/></Field>
      <Field label="نوع فاکتور"><select name="direction"><option value="receivable">دریافتنی</option><option value="payable">پرداختنی</option></select></Field>
      <Field label="ارز فاکتور"><select name="currency" value={currency} onChange={event=>setCurrency(event.target.value as CurrencyUnit)}><option value="TOMAN">تومان</option><option value="IRR">ریال</option><option value="USD">دلار</option></select></Field>
      <Field label="مبلغ فاکتور"><input name="amount" inputMode="decimal" required dir="ltr" maxLength={16}/></Field>
      <Field label="تاریخ صدور (میلادی)"><input name="issuedOn" type="date" required dir="ltr" defaultValue={today()}/></Field>
      <Field label="موعد فاکتور (میلادی)"><input name="dueOn" type="date" required dir="ltr" defaultValue={today()}/></Field>
    </div>
    {Array.from({length:count},(_,index)=><div className="form-grid" key={index}>
      <Field label={`موعد قسط ${index+1} (میلادی)`}><input name={'installment-date-'+index} type="date" required dir="ltr"/></Field>
      <Field label={`مبلغ قسط ${index+1}`}><input name={'installment-amount-'+index} inputMode="decimal" required dir="ltr" maxLength={16}/></Field>
    </div>)}
    <div className="form-actions">
      <Button icon={Plus} disabled={count>=24||saving} onClick={()=>setCount(value=>value+1)}>افزودن قسط</Button>
      {count>0 && <Button disabled={saving} onClick={()=>setCount(value=>value-1)}>حذف آخرین قسط</Button>}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <FormActions onClose={onClose} saving={saving} submit="ثبت فاکتور"/>
  </form></Modal>;
}

function PaymentForm({invoice,remaining,onClose}:{invoice:Invoice;remaining:bigint;onClose:()=>void}) {
  const {change,saving}=useDemo();
  const [error,setError]=useState('');
  async function submit(event:FormEvent<HTMLFormElement>) {
    const get=formValues(event);
    const amount=parseAmount(get('amount'),invoice.currency);
    if (!amount || BigInt(amount)>remaining) {setError('مبلغ پرداخت باید مثبت و حداکثر برابر مانده باشد.');return;}
    const record:Payment={id:newId('payment'),projectId:invoice.projectId,invoiceId:invoice.id,reference:get('reference'),
      currency:invoice.currency,amountUnit:'minor',amount,paidOn:get('paidOn')};
    setError('');
    if (!await change(data=>({...data,payments:[...data.payments,record]}),'پرداخت ثبت شد.')) {
      setError('ثبت پرداخت تأیید نشد. شناسهٔ تکراری یا تغییر ماندهٔ فاکتور را بررسی کنید.');return;
    }
    onClose();
  }
  return <Modal title="ثبت پرداخت فاکتور" onClose={onClose}><form className="form-stack" onSubmit={submit}>
    <p className="muted">ماندهٔ {invoice.reference} · {formatMoney(remaining,invoice.currency)}</p>
    <Field label="شناسهٔ پرداخت"><input name="reference" required maxLength={100} dir="auto"/></Field>
    <Field label="مبلغ پرداخت"><input name="amount" inputMode="decimal" required dir="ltr" maxLength={16}/></Field>
    <Field label="تاریخ پرداخت (میلادی)"><input name="paidOn" type="date" required dir="ltr" defaultValue={today()}/></Field>
    {error && <p className="form-error" role="alert">{error}</p>}
    <FormActions onClose={onClose} saving={saving} submit="ثبت پرداخت"/>
  </form></Modal>;
}

export function InvoiceLedger({projectId}:{projectId:string}) {
  const {data,change,saving}=useDemo();
  const owner=data.users[0]?.role==='Owner';
  const [creating,setCreating]=useState(false);
  const [selected,setSelected]=useState<string>();
  const [paying,setPaying]=useState(false);
  const [voiding,setVoiding]=useState(false);
  const [voidError,setVoidError]=useState('');
  const grouped=new Map<string,Payment[]>();
  for(const payment of data.payments) {
    const entries=grouped.get(payment.invoiceId) ?? [];
    entries.push(payment);
    grouped.set(payment.invoiceId,entries);
  }
  const invoices=data.invoices.filter(invoice=>!projectId||invoice.projectId===projectId)
    .map(invoice=>({...invoice,...invoiceBalance(invoice,grouped.get(invoice.id) ?? [])}));
  const summaries=new Map<CurrencyUnit,{receivable:bigint;payable:bigint;net:bigint}>();
  for(const invoice of invoices) {
    if (invoice.state==='void') continue;
    const currency=invoice.currency;
    const group=summaries.get(currency) ?? {receivable:zero,payable:zero,net:zero};
    group[invoice.direction]+=invoice.remaining;
    group.net+=invoice.direction==='receivable' ? invoice.paid : -invoice.paid;
    summaries.set(currency,group);
  }
  const active=invoices.find(invoice=>invoice.id===selected);
  const contracts=data.contracts.filter(item=>!projectId||item.projectId===projectId);
  function close() {
    setPaying(false);
    setVoiding(false);
    setVoidError('');
    setSelected(undefined);
  }
  async function voidInvoice(invoice:Invoice) {
    if (await change(data=>({...data,invoices:data.invoices.map(item=>item.id===invoice.id
      ? {...item,state:'void'} : item)}),'فاکتور باطل شد.')) setVoiding(false);
    else setVoidError('ابطال فاکتور تأیید نشد. مانده و وضعیت فاکتور را دوباره بررسی کنید.');
  }
  function exportInvoices() {
    download('projectos-invoices.csv',csv([
      ['شماره','عنوان','نوع','ارز','مبلغ','مانده (واحد جزء)','موعد'],
      ...invoices.map(invoice=>[invoice.reference,invoice.title,directions[invoice.direction],invoice.currency,
        inputAmount(invoice),invoice.remaining.toString(),invoice.dueOn]),
    ]),'text/csv;charset=utf-8');
  }

  return <>
    <Panel title="فاکتورها و پرداخت‌ها" action={<div className="flex flex-wrap gap-2">
      {invoices.length>0 && <Button icon={Download} onClick={exportInvoices}>خروجی فاکتورها</Button>}
      {owner && <Button icon={Plus} onClick={()=>setCreating(true)}>فاکتور جدید</Button>}
    </div>}>
      {summaries.size>0 && <dl className="form-grid key-values">
        {[...summaries].map(([currency,group])=><div key={currency}><dt><bdi>{currency}</bdi></dt>
          <dd>ماندهٔ دریافتنی · {formatMoney(group.receivable,currency)}</dd>
          <dd>ماندهٔ پرداختنی · {formatMoney(group.payable,currency)}</dd>
          <dd>خالص دریافت و پرداخت فاکتورها · {formatMoney(group.net,currency)}</dd>
        </div>)}
      </dl>}
      {invoices.length ? <Table label="فاکتورهای ثبت‌شده" rows={invoices} columns={[
        {label:'فاکتور',render:invoice=><button className="cell-link" type="button" onClick={()=>setSelected(invoice.id)}>{invoice.title}</button>},
        {label:'نوع',render:invoice=>directions[invoice.direction]},
        {label:'مبلغ',render:invoice=>amountLabel(invoice)},
        {label:'مانده',render:invoice=>invoice.state==='void'?'—':formatMoney(invoice.remaining,invoice.currency)},
        {label:'موعد',extra:true,render:invoice=>dateLabel(invoice.dueOn)},
        {label:'وضعیت',extra:true,render:invoice=><Pill>{paymentLabels[invoicePaymentState(invoice,invoice.paid,today())]}</Pill>},
      ]}/> : <Empty title="فاکتوری ثبت نشده است"/>}
    </Panel>
    <Panel title="تطبیق قرارداد و فاکتور">
      {contracts.length ? <Table label="تطبیق قرارداد و فاکتور" rows={contracts.map(contract=>({
        ...contract,...contractReconciliation(contract,invoices,data.payments),
      }))} columns={[
        {label:'قرارداد',render:item=>item.title},
        {label:'جمع فاکتور',render:item=>formatMoney(item.invoiced,item.currency)},
        {label:'پرداخت ثبت‌شده',render:item=>formatMoney(item.paid,item.currency)},
        {label:'ماندهٔ فاکتورها',render:item=>formatMoney(item.remaining,item.currency)},
        {label:'اختلاف با قرارداد',render:item=>item.count===0?'بدون فاکتور':item.difference===zero?'منطبق':formatMoney(item.difference,item.currency)},
      ]}/> : <Empty title="قراردادی برای تطبیق وجود ندارد"/>}
    </Panel>
    {creating && <InvoiceForm projectId={projectId} onClose={()=>setCreating(false)}/>}
    {active && (paying ? <PaymentForm invoice={active} remaining={active.remaining} onClose={()=>setPaying(false)}/>
      : voiding ? <Modal title="ابطال فاکتور" onClose={()=>{setVoiding(false);setVoidError('');}}>
        <div className="form-stack">
          <p>فاکتور {active.reference} باطل و سابقهٔ آن حفظ می‌شود.</p>
          {voidError && <p className="form-error" role="alert">{voidError}</p>}
          <Button variant="danger" disabled={saving} onClick={()=>voidInvoice(active)}>تأیید ابطال</Button>
        </div>
      </Modal> : <Modal title={active.title} onClose={close}><div className="form-stack">
        <p className="muted">{active.reference} · {directions[active.direction]} · {active.state==='void'
          ? 'باطل' : 'مانده ' + formatMoney(active.remaining,active.currency)}</p>
        {active.state==='open' && <ul>{installmentBalances(active,active.paid).map(item=><li key={item.dueOn}>
          {dateLabel(item.dueOn)} · {item.remaining===zero?'پرداخت‌شده':item.dueOn<today()?'سررسید گذشته':'در انتظار پرداخت'} · ماندهٔ قسط {formatMoney(item.remaining,active.currency)}
        </li>)}</ul>}
        {(grouped.get(active.id) ?? []).map(payment=><p key={payment.id}><bdi>{payment.reference}</bdi> · {amountLabel(payment)} · {dateLabel(payment.paidOn)}</p>)}
        {owner && active.state==='open' && active.remaining>zero && <Button icon={Plus} onClick={()=>setPaying(true)}>ثبت پرداخت</Button>}
        {owner && active.state==='open' && active.paid===zero && <Button onClick={()=>setVoiding(true)}>ابطال فاکتور</Button>}
      </div></Modal>)}
  </>;
}
