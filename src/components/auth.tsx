'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, Eye, EyeOff, FolderKanban, Layers2, ListTodo, Server, Sparkles } from 'lucide-react';
import { newId, projectHref, today } from '@/lib/format';
import { savePreferences, useDemo, useWorkspaceReady } from '@/lib/store';
import type { Project, Task } from '@/lib/types';
import { SelectOptions } from './forms';
import { Mark } from './shell';
import { Art, Button, Callout, Field, Heading, IconButton, Panel, Pill, Row, formValues } from './ui';

export function Login() {
  const ready=useWorkspaceReady();
  const [passwordVisible,setPasswordVisible]=useState(false);
  const [useRecovery,setUseRecovery]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function signIn(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);setError('');
    const fd=new FormData(event.currentTarget);
    try{
      const response=await fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(fd))});
      if(!response.ok)throw new Error('ایمیل یا رمز معتبر نیست، یا حساب موقتاً قفل شده است.');
      window.location.assign((await response.json()).enrollmentRequired ? '/mfa-enroll' : '/dashboard');
    }catch(e){setError(e instanceof Error?e.message:'خطای ارتباطی');setBusy(false);}
  }
  return <main className="auth-layout"><div className="auth-form"><div className="auth-form-inner">
    <div className="flex items-center justify-between"><Mark /><Pill dot>فضای کاری خصوصی</Pill></div>
    <Heading title="ورود به فضای کاری" subtitle="دسترسی فقط با حساب ایجادشده در راه‌اندازی اولیه امکان‌پذیر است." />
    <form method="post" onSubmit={signIn} className="form-stack">
      <Field label="ایمیل"><input name="email" type="email" dir="ltr" autoComplete="username" required /></Field>
      <div className="password-field"><Field label="رمز عبور"><input name="password" type={passwordVisible?'text':'password'} autoComplete="current-password" dir="ltr" required /></Field>
        <IconButton icon={passwordVisible?EyeOff:Eye} label="نمایش یا پنهان‌کردن رمز" onClick={()=>setPasswordVisible(!passwordVisible)}/></div>
      {useRecovery ?
        <Field label="کد بازیابی یک‌بارمصرف"><input name="recoveryCode" type="text" dir="ltr" maxLength={22} autoComplete="off" placeholder="Recovery code" /></Field> :
        <Field label="کد تأیید دومرحله‌ای (در صورت فعال‌بودن)"><input name="totp" type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} dir="ltr" autoComplete="one-time-code" placeholder="123456" /></Field>}
      <label className="check-row"><input type="checkbox" checked={useRecovery} onChange={e=>setUseRecovery(e.target.checked)} />استفاده از کد بازیابی به‌جای Authenticator</label>
      {error&&<p role="alert" className="form-error">{error}</p>}
      <Button type="submit" variant="primary" icon={ArrowLeft} disabled={!ready || busy}>{busy?'در حال ورود…':'ورود امن'}</Button>
    </form>
    <p className="muted auth-join">اگر هنوز حسابی ثبت نشده، <Link href="/setup" className="cell-link">راه‌اندازی مالک اولیه</Link> را انجام دهید.</p>
    <p className="muted">کدهای بازیابی فقط هنگام فعال‌سازی ورود دومرحله‌ای نمایش داده می‌شوند. برای بازیابی بدون رمز عبور یا بازیابی حسابِ بدون کد، فرایند خودکار وجود ندارد.</p>
  </div></div><div className="auth-art"><div className="auth-orbit" aria-hidden="true"><div><Layers2 /></div></div>
    <b dir="ltr">Project<span>OS</span></b><p>پروژه‌ها و زیرساخت در یک فضای کاری خصوصی.</p><small dir="ltr">PROJECTOS · PRIVATE PREVIEW</small>
  </div></main>;
}

const steps = ['فضای کاری','پروژه اول','بازبینی'];
export function Onboarding() {
  const router = useRouter();
  const { data,change,saving } = useDemo();
  const [step,setStep] = useState(0);
  const [workspace,setWorkspace] = useState(data.preferences.workspace);
  const [role,setRole] = useState('توسعه‌دهنده مستقل');
  const [name,setName] = useState('');
  const [type,setType] = useState('وب‌سایت');
  const [description,setDescription] = useState('');
  const [sampleTask,setSampleTask] = useState(false);
  const [error,setError] = useState('');

  async function advance(event: FormEvent<HTMLFormElement>) {
    const get = formValues(event);
    if (step === 0 && !get('workspace')) {setError('نام فضای کاری را وارد کنید.');return;}
    if (step === 1 && !get('name')) {setError('نام پروژه را وارد کنید.');return;}
    setError('');
    if (step < 2) {setStep(step + 1);return;}
    const id = newId('project');
    const project: Project = {id,name:name.trim(),coverTitle:name.trim(),subtitle:type,description:description.trim(),type,
      status:'building',progress:0,next:'مرور برنامه تحویل',art:'navigation/projects'};
    const tasks: Task[] = sampleTask ? [{id:newId('task'),title:'مرور برنامه تحویل',projectId:id,due:today(),owner:data.users[0]?.id ?? '',
      status:'todo',priority:'medium',description:'موارد آغاز پروژه را با تیم مرور کنید.',checklist:[],comments:[],dependencies:[]}] : [];
    const preferences = {...data.preferences,workspace:workspace.trim()};
    savePreferences(preferences);
    const saved = await change(previous => ({...previous,preferences,projects:[...previous.projects,project],tasks:[...previous.tasks,...tasks]}),
      'فضای کاری و پروژه ثبت شدند.',
      {projectId:id,title:'راه‌اندازی پروژه',source:'پروژه‌ها'});
    if (!saved) { setError('ذخیرهٔ فضای کاری تأیید نشد.'); return; }
    router.push(projectHref(id));
  }

  return <>
    <Heading title="راه‌اندازی ProjectOS" subtitle="یک فضای کاری بسازید و اولین پروژه را اضافه کنید." />
    <div className="split">
      <Panel className="onboarding-panel">
        <ol className="steps">{steps.map((title,index) => <li key={title} aria-current={step === index ? 'step' : undefined} className={step >= index ? 'reached' : ''}><span>{step > index ? <Check size={13} aria-hidden="true" /> : index + 1}</span>{title}</li>)}</ol>
        <h2>{['به ProjectOS خوش آمدید','مشخصات پروژه اول','بازبینی و ساخت فضای کاری'][step]}</h2>
        <form className="form-stack" onSubmit={advance} key={step}>
          {step === 0 && <>
            <Field label="نام فضای کاری"><input autoFocus required name="workspace" maxLength={65} value={workspace} onChange={e => setWorkspace(e.target.value)} dir="auto" /></Field>
            <Field label="نقش شما"><select value={role} onChange={e => setRole(e.target.value)}><SelectOptions options={['توسعه‌دهنده مستقل','مدیر پروژه','عضو تیم']} /></select></Field>
          </>}
          {step === 1 && <>
            <Field label="نام پروژه"><input autoFocus required name="name" value={name} onChange={e => setName(e.target.value)} maxLength={75} dir="auto" /></Field>
            <Field label="نوع پروژه"><select value={type} onChange={e => setType(e.target.value)}><SelectOptions options={['وب‌سایت','محصول نرم‌افزاری','زیرساخت','سایر']} /></select></Field>
            <Field label="توضیح پروژه"><textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} maxLength={400} /></Field>
            <label className="check-row"><input type="checkbox" checked={sampleTask} onChange={e => setSampleTask(e.target.checked)} />افزودن یک وظیفهٔ نمونه</label>
          </>}
          {step === 2 && <div>
            <Row icon={Layers2} title={workspace.trim()} meta={role} />
            <Row icon={FolderKanban} title={name.trim()} meta={<>{type} · {sampleTask ? 'با یک وظیفهٔ نمونه' : 'بدون وظیفهٔ اولیه'}</>} />
          </div>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="form-actions"><Button type="submit" variant="primary" icon={ArrowLeft} disabled={saving}>{['ادامه و افزودن پروژه','مرور اطلاعات','ایجاد پروژه'][step]}</Button>
            {step > 0 && <Button onClick={() => {setStep(step - 1);setError('');}}>بازگشت</Button>}</div>
        </form>
      </Panel>
      <Panel title="چه چیزهایی را مدیریت می‌کنید؟">
        <div className="account-art"><Art name="navigation/dashboard" size={72} /></div>
        <Row icon={FolderKanban} title="پروژه‌ها و وظایف" meta="پیشرفت، موعد و چک‌لیست‌ها" />
        <Row icon={Server} title="زیرساخت و دسترسی‌ها" meta="سرور، دامنه و ارجاع خزانه" />
        <Row icon={ListTodo} title="هشدارها و یادآوری‌ها" meta="تمدید سرویس‌ها و اطلاعات ناقص" />
        <Row icon={Sparkles} title="مستندات پروژه" meta="راهنماها، تصمیم‌ها و نسخه‌ها" />
        <Callout>از اطلاعات واقعی غیرحساس استفاده کنید. رمز، توکن و کلید خصوصی را وارد نکنید.</Callout>
      </Panel>
    </div>
  </>;
}
