import { validRecordId } from '../record-contract';
import type { DemoData } from '../types';
import { emptyData } from '../empty-data';
import { parseRate } from '../exchange-rate';
import { suspiciousInRecord } from './credential-guard';
import {vaultLink} from '../vault-link';

type Rule = {type:'string'|'number'|'boolean'|'strings'|'checklist'|'comments'|'installments'; max?:number; values?:readonly string[]; optional?:boolean};
const s=(max=200,optional=false,values?:readonly string[]):Rule=>({type:'string',max,optional,values});
const n=(max=1e12,optional=false):Rule=>({type:'number',max,optional});
const str=(max=30):Rule=>({type:'strings',max});
const currencies=['TOMAN','IRR','USD'] as const;
const ruleSets={
  projects:{id:s(100),name:s(100),subtitle:s(150),coverTitle:s(150),description:s(4000),status:s(30,false,['building','review','active','archived']),archivedFrom:s(30,true,['building','review','active']),type:s(70),progress:n(100),next:s(400),art:s(100)},
  tasks:{id:s(100),title:s(200),projectId:s(100),status:s(20,false,['todo','doing','blocked','review','done']),priority:s(20,false,['low','medium','high']),owner:s(100),due:s(32),noticeDays:n(60,true),description:s(10000),checklist:{type:'checklist',max:200},comments:{type:'comments',max:500},dependencies:str(80)},
  resources:{id:s(100),name:s(160),projectId:s(100),type:s(24,false,['server','domain','database','service']),address:s(350),environment:s(50,false,['Production','Staging','Development']),status:s(25,false,['registered','review','missing']),provider:s(160),region:s(120,true),os:s(120,true),port:n(65535,true),expires:s(32,true),noticeDays:n(60,true),parentId:s(100,true),tags:str(20),linkedProjectIds:str(100)},
  secrets:{id:s(100),name:s(160),projectId:s(100),resourceId:s(100,true),type:s(30,false,['SSH Key','API Token','Account','DB Credential']),
    vaultProvider:s(160),lastCheckedAt:s(32,true),externalRef:s(500,true),vaultMount:s(80,true),vaultPath:s(240,true),rotationDue:s(32,true)},
  reminders:{id:s(100),title:s(180),projectId:s(100),due:s(32),kind:s(20,false,['جلسه','تمدید','یادآوری']),
    repeat:s(20,true,['none','daily','weekly','monthly','yearly']),zone:s(100,true),noticeDays:n(60,true),paused:{type:'boolean',optional:true}},
  incidents:{id:s(100),title:s(200),projectId:s(100),priority:s(20,false,['high','medium','low']),source:s(140),date:s(32),state:s(20,false,['open','acknowledged','snoozed','resolved','dismissed']),snoozedUntil:s(32,true)},
  expenses:{id:s(100),title:s(160),projectId:s(100),category:s(30,false,['زیرساخت','دامنه','پشتیبان‌گیری','اشتراک']),amount:n(1e12),currency:s(10,true,['TOMAN','IRR','USD']),amountUnit:s(10,true,['minor']),date:s(32),status:s(20,false,['paid','upcoming'])},
  charges:{id:s(100),projectId:s(100),title:s(160),provider:s(120),amount:n(1e12),currency:s(10,false,['TOMAN','IRR','USD']),amountUnit:s(10,true,['minor']),period:s(20,false,['monthly','quarterly','yearly']),nextDue:s(32),status:s(15,false,['active','paused']),linkedResourceId:s(100,true)},
  contracts:{id:s(100),projectId:s(100),title:s(160),client:s(160),start:s(32),end:s(32),amount:n(1e12),currency:s(10,false,['TOMAN','IRR','USD']),amountUnit:s(10,true,['minor']),state:s(15,false,['draft','active','completed'])},
  revenues:{id:s(100),projectId:s(100),title:s(160),amount:n(1e12),currency:s(10,false,['TOMAN','IRR','USD']),amountUnit:s(10,true,['minor']),date:s(32),status:s(20,false,['received','outstanding'])},
  docs:{id:s(100),title:s(180),projectId:s(100),type:s(30,false,['Runbook','Technical Design','Decision Record','Checklist','Release Notes']),body:s(100000),revision:n(1e6),updated:s(32)},
  invoices:{id:s(100),projectId:s(100),reference:s(100),title:s(160),direction:s(16,false,['receivable','payable']),contractId:s(100,true),
    amount:n(1e12),currency:s(10,false,['TOMAN','IRR','USD']),amountUnit:s(10,false,['minor']),issuedOn:s(10),dueOn:s(10),
    state:s(12,false,['open','void']),installments:{type:'installments',max:24,optional:true}},
  payments:{id:s(100),projectId:s(100),invoiceId:s(100),reference:s(100),amount:n(1e12),
    currency:s(10,false,['TOMAN','IRR','USD']),amountUnit:s(10,false,['minor']),paidOn:s(10)},
  exchangeRates:{id:s(100),projectId:s(100),from:s(10,false,currencies),to:s(10,false,currencies),
    rate:s(32),source:s(160),observedAt:s(24),receivedAt:s(24,true)},
} as const;
type Collection=keyof typeof ruleSets;
type LedgerCollection='invoices'|'payments'|'exchangeRates';
export type CanonicalState=Pick<DemoData,Exclude<Collection,LedgerCollection>|'preferences'> & Partial<Pick<DemoData,LedgerCollection>>;
export class ValidationError extends Error {constructor(public reason:string){super(reason);}}
function bad(message:string):never { throw new ValidationError(message); }
function plain(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;}
function text(value:unknown,max:number,optional:boolean=false,values?:readonly string[]) {
  if(value===undefined && optional)return undefined;
  if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value))bad('Invalid text field');
  if(values&&!values.includes(value))bad('Invalid enum value');
  return value;
}
function parseField(value:unknown,rule:Rule) {
  if(value===undefined&&rule.optional)return undefined;
  if(rule.type==='string')return text(value,rule.max??200,rule.optional,rule.values);
  if(rule.type==='number') {
    if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>(rule.max??1e12))bad('Invalid number');
    return value;
  }
  if(rule.type==='boolean'){
    if(typeof value!=='boolean')bad('Invalid boolean');
    return value;
  }
  if(!Array.isArray(value)||value.length>(rule.max??100))bad('Invalid array');
  if(rule.type==='strings'){
    if(value.some(v=>typeof v!=='string'||v.length>100))bad('Invalid array member');
    return [...new Set(value)];
  }
  if(rule.type==='checklist')return value.map(v=>{
    if(!plain(v)||Object.keys(v).some(k=>!['label','checked'].includes(k))||typeof v.checked!=='boolean')bad('Invalid checklist');
    return {label:text(v.label,500),checked:v.checked};
  });
  if(rule.type==='comments')return value.map(v=>{
    if(!plain(v)||Object.keys(v).some(k=>!['text','date'].includes(k)))bad('Invalid comment');
    const date=text(v.date,32);
    checkDate(date);
    return {text:text(v.text,2000),date};
  });
  if(rule.type==='installments')return value.map(v=>{
    if(!plain(v)||Object.keys(v).some(k=>!['dueOn','amount'].includes(k)))bad('Invalid invoice installment');
    const dueOn=text(v.dueOn,10);
    checkDate(dueOn);
    if(typeof v.amount!=='number'||!Number.isSafeInteger(v.amount)||v.amount<=0||v.amount>1e12)bad('Invalid installment amount');
    return {dueOn,amount:v.amount};
  });
  return bad('Unrecognized field');
}
export function parseRecord<Kind extends Collection>(kind: Kind, item: unknown): DemoData[Kind][number] {
  if (!plain(item)) bad('Invalid record');
  const keys = ruleSets[kind] as Record<string, Rule>;
  if (Object.keys(item).some(key => !Object.hasOwn(keys, key))) bad('Unrecognized field in ' + kind);
  const clean: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(keys)) {
    const field = parseField(item[key], rule);
    if (field !== undefined) clean[key] = field;
  }
  if (!validRecordId(clean.id)) bad('Invalid record id');
  if (clean.noticeDays !== undefined && !Number.isSafeInteger(clean.noticeDays)) bad('Invalid notification lead days');
  if (suspiciousInRecord(clean)) bad('Possible credential in unencrypted workspace field. Store it in your external vault instead.');
  switch (kind) {
    case 'tasks': checkDate(clean.due); break;
    case 'reminders':
      checkDate(clean.due);
      if (clean.zone !== undefined) {
        try { new Intl.DateTimeFormat('fa-IR', { timeZone: clean.zone as string }); }
        catch { bad('Invalid reminder timezone'); }
      }
      break;
    case 'resources':
      checkAddress(clean.address as string);
      if (clean.expires) checkDate(clean.expires);
      else if (clean.noticeDays !== undefined) bad('Renewal notice requires a due date');
      if (clean.port !== undefined && (!Number.isInteger(clean.port) || Number(clean.port) < 1)) bad('Invalid resource port');
      break;
    case 'incidents':
      checkDate(clean.date);
      if (clean.snoozedUntil) checkDate(clean.snoozedUntil);
      break;
    case 'docs':
      checkDate(clean.updated);
      if (!Number.isSafeInteger(clean.revision) || Number(clean.revision) < 1) bad('Invalid document revision');
      break;
    case 'payments':
      if (!validRecordId(clean.invoiceId)) bad('Invalid invoice reference');
      checkDate(clean.paidOn);
      break;
    case 'exchangeRates': {
      const rate=parseRate(clean.rate as string);
      const source=(clean.source as string).trim();
      const observedAt=clean.observedAt as string;
      checkDate(observedAt);
      if (clean.from===clean.to || !rate || !source || !observedAt.includes('T') || Date.parse(observedAt)>Date.now()) {
        bad('Exchange rates require distinct currencies, a positive decimal, a named source and an observed UTC time');
      }
      if (clean.receivedAt!==undefined) {
        const receivedAt=clean.receivedAt as string;
        checkDate(receivedAt);
        if (!receivedAt.includes('T') || Date.parse(receivedAt)<Date.parse(observedAt) || Date.parse(receivedAt)>Date.now()) {
          bad('Invalid exchange rate receipt timestamp');
        }
        clean.receivedAt=new Date(receivedAt).toISOString();
      }
      clean.rate=rate.text;
      clean.source=source;
      clean.observedAt=new Date(observedAt).toISOString();
      break;
    }
    case 'invoices': {
      if (clean.contractId !== undefined && !validRecordId(clean.contractId)) bad('Invalid invoice contract');
      checkDate(clean.issuedOn);
      checkDate(clean.dueOn);
      const issued=clean.issuedOn as string, due=clean.dueOn as string;
      if (due<issued) bad('Invoice due date precedes issue date');
      const installments=clean.installments as DemoData['invoices'][number]['installments'];
      if (installments?.length) {
        let prior='';
        let total=BigInt(0);
        for (const item of installments) {
          if (item.dueOn<issued || item.dueOn>due || item.dueOn<=prior) bad('Installments require distinct ordered dates within the invoice period');
          prior=item.dueOn;
          total+=BigInt(item.amount);
        }
        if (!Number.isSafeInteger(clean.amount) || total!==BigInt(clean.amount as number)) bad('Installments must sum to the invoice amount');
      }
      break;
    }
    case 'expenses':
    case 'revenues': checkDate(clean.date); break;
    case 'charges': checkDate(clean.nextDue); break;
    case 'contracts':
      checkDate(clean.start);
      checkDate(clean.end);
      if (Date.parse(clean.end as string) < Date.parse(clean.start as string)) bad('Contract end before start');
      break;
    case 'secrets':
      if (clean.lastCheckedAt) checkDate(clean.lastCheckedAt);
      if (clean.rotationDue) checkDate(clean.rotationDue);
      if (clean.vaultMount !== undefined || clean.vaultPath !== undefined) {
        if (clean.vaultProvider !== 'HashiCorp Vault' || typeof clean.vaultMount !== 'string'
          || typeof clean.vaultPath !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(clean.vaultMount)
          || !clean.vaultPath.split('/').every(part => /^[a-zA-Z0-9_-]+$/.test(part))) bad('Invalid metadata locator');
      }
      if (clean.externalRef && !vaultLink(clean.externalRef as string)) {
        bad('External vault link must belong to an approved vault hostname (HTTPS)');
      }
      break;
  }
  if (Object.hasOwn(clean, 'amount') && !Number.isSafeInteger(clean.amount)) bad('Monetary amounts must be integer minor units');
  if (kind==='invoices' || kind==='payments') {
    const reference=(clean.reference as string).trim();
    if (!reference || Number(clean.amount)<=0) bad('Ledger records require a reference and positive amount');
    clean.reference=reference;
  }
  return clean as unknown as DemoData[Kind][number];
}

function parseCollection<Kind extends Collection>(value: unknown, kind: Kind, limit: number): DemoData[Kind] {
  if (!Array.isArray(value) || value.length > limit) bad('Invalid ' + kind + ' collection');
  const ids = new Set<string>();
  const records = value.map(item => {
    const record = parseRecord(kind, item);
    if (ids.has(record.id)) bad('Duplicate record id');
    ids.add(record.id);
    return record;
  });
  return records as DemoData[Kind];
}

// Kahn's algorithm avoids unbounded recursion on long dependency chains.
export function validateGraph(edges: ReadonlyMap<string, readonly string[]>, name: string) {
  const incoming = new Map(Array.from(edges.keys(), id => [id, 0]));
  for (const refs of edges.values()) {
    for (const ref of refs) {
      const degree = incoming.get(ref);
      if (degree === undefined) bad('Invalid reference in ' + name);
      incoming.set(ref, degree + 1);
    }
  }
  const ready = Array.from(incoming).filter(([, degree]) => degree === 0).map(([id]) => id);
  let seen = 0;
  while (ready.length) {
    const id = ready.pop()!;
    seen++;
    for (const ref of edges.get(id) ?? []) {
      const degree = incoming.get(ref)! - 1;
      incoming.set(ref, degree);
      if (!degree) ready.push(ref);
    }
  }
  if (seen !== edges.size) bad('Cycle in ' + name);
}
function checkDate(date:unknown) {
  if(typeof date!=='string')bad('Date must be YYYY-MM-DD or UTC ISO string');
  const match=/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?Z)?$/.exec(date);
  if(!match)bad('Date must be YYYY-MM-DD or UTC ISO string');
  const [,year,month,day,hour,minute,second,millis]=match;
  const y=Number(year),m=Number(month),d=Number(day);
  const leap=y%4===0&&(y%100!==0||y%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(y<1||m<1||m>12||d<1||d>days[m-1])bad('Invalid calendar date');
  if(hour!==undefined&&(Number(hour)>23||Number(minute)>59||Number(second??0)>59||Number(millis??0)>999))bad('Invalid UTC time');
}
function checkAddress(address:string) {
  // Metadata only — no outbound network request is performed by ProjectOS.
  if(!address||address.length>350||/\s/.test(address)||/[<>"'\\]/.test(address))bad('Invalid resource address');
  if(/^[a-z]+:\/\//i.test(address)){
    let url:URL;try{url=new URL(address);}catch{bad('Invalid resource URL');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)bad('Unsupported URL');
  }else if(address.includes('@')||address.includes('://'))bad('Credential-containing address is prohibited');
}
export function parsePreferences(value:unknown):DemoData['preferences']{
  if(!plain(value))bad('Invalid preferences');
  const defaults=emptyData.preferences;
  const allowed=Object.keys(defaults);
  if(Object.keys(value).some(k=>!allowed.includes(k)))bad('Unexpected preference');
  if(suspiciousInRecord(value))bad('Possible credential in workspace preferences');
  return {
    workspace:text(value.workspace,80) as string,displayName:text(value.displayName,80) as string,
    theme:text(value.theme,10,false,['dark','dim']) as 'dark'|'dim',
    language:text(value.language,15,false,['fa','fa-latin']) as 'fa'|'fa-latin',
    zone:text(value.zone,20,false,['Asia/Tehran','UTC']) as 'Asia/Tehran'|'UTC',
    digest:parseField(value.digest,{type:'boolean'}) as boolean,
    renewal:parseField(value.renewal,{type:'boolean'}) as boolean,
    outage:parseField(value.outage,{type:'boolean'}) as boolean,
    stale:parseField(value.stale,{type:'boolean'}) as boolean,
  };
}
export function parseState(value:unknown):CanonicalState {
  if(!plain(value))bad('State must be an object');
  const keys=[...Object.keys(ruleSets),'preferences','events','users','integrations'];
  if(Object.keys(value).some(k=>!keys.includes(k)))bad('Unexpected top-level property');
  const state={
    projects:parseCollection(value.projects,'projects',1000),
    tasks:parseCollection(value.tasks,'tasks',10000),
    resources:parseCollection(value.resources,'resources',10000),
    secrets:parseCollection(value.secrets,'secrets',2000),
    reminders:parseCollection(value.reminders,'reminders',10000),
    incidents:parseCollection(value.incidents,'incidents',10000),
    expenses:parseCollection(value.expenses,'expenses',20000),
    charges:parseCollection(value.charges,'charges',5000),
    contracts:parseCollection(value.contracts,'contracts',5000),
    revenues:parseCollection(value.revenues,'revenues',10000),
    docs:parseCollection(value.docs,'docs',5000),
    ...(value.invoices===undefined ? {} : {invoices:parseCollection(value.invoices,'invoices',10000)}),
    ...(value.payments===undefined ? {} : {payments:parseCollection(value.payments,'payments',20000)}),
    ...(value.exchangeRates===undefined ? {} : {exchangeRates:parseCollection(value.exchangeRates,'exchangeRates',10000)}),
    preferences:parsePreferences(value.preferences),
  } as unknown as CanonicalState;
  const projects = new Set(state.projects.map(project => project.id));
  const resources = new Set(state.resources.map(resource => resource.id));
  for (const kind of ['tasks','resources','secrets','reminders','incidents','expenses','charges','contracts','revenues','docs','invoices','payments','exchangeRates'] as const)
    for (const record of state[kind] ?? []) if (!projects.has(record.projectId)) bad('Unknown project in ' + kind);
  for (const resource of state.resources)
    if (resource.linkedProjectIds?.some(id => !projects.has(id))) bad('Invalid shared resource project');
  for (const charge of state.charges)
    if (charge.linkedResourceId && !resources.has(charge.linkedResourceId)) bad('Invalid charge resource reference');
  for (const reference of state.secrets)
    if (reference.resourceId && !resources.has(reference.resourceId)) bad('Invalid Vault resource reference');
  validateGraph(new Map(state.resources.map(resource => [resource.id, resource.parentId ? [resource.parentId] : []])), 'resource parents');
  validateGraph(new Map(state.tasks.map(task => [task.id, task.dependencies])), 'task dependencies');
  return state;
}
