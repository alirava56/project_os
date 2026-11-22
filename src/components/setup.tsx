'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useWorkspaceReady } from '@/lib/store';
import { Button, Field, Heading, Panel } from './ui';
import { Mark } from './shell';
export function Setup(){
  const ready=useWorkspaceReady();
  const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  async function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault();setError('');setBusy(true);
    const fd=new FormData(e.currentTarget);
    try {
      const response=await fetch('/api/auth/setup',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(fd))});
      if(!response.ok)throw new Error('توکن راه‌اندازی یا اطلاعات حساب معتبر نیست، یا قبلاً حساب ساخته شده است.');
      window.location.assign((await response.json()).enrollmentRequired ? '/mfa-enroll' : '/onboarding');
    }catch(err){setError(err instanceof Error?err.message:'امکان ایجاد حساب وجود ندارد.');setBusy(false);}
  }
  return <main className="auth-layout"><div className="auth-form"><div className="auth-form-inner"><Mark />
    <Heading title="راه‌اندازی ProjectOS" subtitle="این مرحله فقط یک بار برای ساخت مالک اولیه اجرا می‌شود. توکن را از متغیر محیطی PROJECTOS_SETUP_TOKEN دریافت کنید." />
    <Panel><form method="post" onSubmit={submit} className="form-stack">
      <Field label="توکن راه‌اندازی"><input name="setupToken" dir="ltr" type="password" autoComplete="off" required /></Field>
      <Field label="نام"><input name="displayName" maxLength={80} required /></Field>
      <Field label="ایمیل حساب"><input name="email" type="email" dir="ltr" autoComplete="username" required /></Field>
      <Field label="نام فضای کاری"><input name="workspace" maxLength={80} defaultValue="فضای کاری شخصی" required /></Field>
      <Field label="رمز قدرتمند (حداقل ۱۲ نویسه)"><input name="password" type="password" dir="ltr" autoComplete="new-password" minLength={12} maxLength={128} required /></Field>
      {error&&<p role="alert" className="form-error">{error}</p>}
      <Button type="submit" variant="primary" disabled={!ready || busy}>{busy?'در حال ایجاد حساب…':'ایجاد فضای کاری امن'}</Button>
    </form></Panel>
    <Link className="cell-link" href="/login">بازگشت به ورود</Link>
  </div></div><div className="auth-art"><b dir="ltr">Project<span>OS</span></b><p>راه‌اندازی اولیه، فقط در محیط خصوصی.</p></div></main>;
}
