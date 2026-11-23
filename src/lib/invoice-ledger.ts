import { minorUnits } from './money';
import type { ContractRecord, Invoice, Payment } from './types';

export function invoiceBalance(invoice: Invoice, payments: readonly Payment[]) {
  const paid=payments.filter(payment=>payment.invoiceId===invoice.id && payment.projectId===invoice.projectId && payment.currency===invoice.currency)
    .reduce((total,payment)=>total+BigInt(payment.amount),BigInt(0));
  return {paid,remaining:BigInt(invoice.amount)-paid};
}

export function installmentBalances(invoice: Invoice, paid: bigint) {
  let budget=paid;
  const schedule=invoice.installments?.length ? invoice.installments : [{dueOn:invoice.dueOn,amount:invoice.amount}];
  return schedule.map(installment=>{
    const amount=BigInt(installment.amount);
    const applied=budget<amount ? budget : amount;
    budget-=applied;
    return {...installment, remaining:amount-applied};
  });
}

export function invoicePaymentState(invoice: Invoice, paid: bigint, today: string) {
  if (invoice.state==='void') return 'void';
  const balances=installmentBalances(invoice,paid);
  if (balances.every(item=>item.remaining===BigInt(0))) return 'paid';
  if (balances.some(item=>item.remaining>BigInt(0) && item.dueOn<today)) return 'overdue';
  return paid>BigInt(0) ? 'partial' : 'unpaid';
}

export function contractReconciliation(contract: ContractRecord, invoices: readonly Invoice[], payments: readonly Payment[]) {
  const linked=invoices.filter(invoice=>invoice.contractId===contract.id && invoice.projectId===contract.projectId
    && invoice.currency===contract.currency && invoice.state==='open');
  const totals=linked.reduce((result,invoice)=>{
    const balance=invoiceBalance(invoice,payments);
    return {invoiced:result.invoiced+BigInt(invoice.amount),paid:result.paid+balance.paid,remaining:result.remaining+balance.remaining};
  },{invoiced:BigInt(0),paid:BigInt(0),remaining:BigInt(0)});
  return {...totals,count:linked.length,difference:minorUnits(contract)-totals.invoiced};
}
