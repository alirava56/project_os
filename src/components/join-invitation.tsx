'use client';
import {useState,type FormEvent} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import { useWorkspaceReady } from '@/lib/store';
export function JoinInvitation(){
  const router=useRouter();
  const ready=useWorkspaceReady();
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);setError('');
    const payload=Object.fromEntries(new FormData(event.currentTarget));
    try{
      const res=await fetch('/api/auth/accept-invite',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(!res.ok)throw Error('کد دعوت معتبر نیست، منقضی شده یا قبلاً استفاده شده است.');
      router.replace((await res.json()).enrollmentRequired ? '/mfa-enroll' : '/dashboard');router.refresh();
    }catch(e){setError(e instanceof Error?e.message:'خطای ارتباطی');setBusy(false);}
  }
  return <main className="auth-layout"><section className="auth-form"><div className="auth-form-inner">
    <h1>پیوستن به ProjectOS</h1><p className="muted">کد دعوت را فقط از مالک Workspace دریافت کن. اگر از قبل حساب دارای ورود دومرحله‌ای داری، کد آن را هم وارد کن.</p>
    <form method="post" className="form-stack" onSubmit={submit}>
      <label>کد دعوت<input name="token" required minLength={43} maxLength={43} dir="ltr" autoComplete="off" /></label>
      <label>ایمیل دعوت‌شده<input name="email" type="email" required dir="ltr" autoComplete="email" /></label>
      <label>نام نمایشی<input name="displayName" required maxLength={80} /></label>
      <label>رمز عبور (برای حساب جدید یا موجود)<input name="password" type="password" autoComplete="current-password" minLength={12} required /></label>
      <label>کد شش‌رقمی دومرحله‌ای (فقط حساب موجود دارای MFA)<input name="totp" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} dir="ltr" autoComplete="one-time-code" /></label>
      <label>کد بازیابی (جایگزین کد دومرحله‌ای)<input name="recoveryCode" maxLength={22} dir="ltr" autoComplete="off" /></label>
      {error&&<p role="alert" className="form-error">{error}</p>}
      <button className="btn btn-primary" disabled={!ready || busy} type="submit">{busy?'در حال ثبت…':'ایجاد حساب و ورود'}</button>
    </form><p className="muted">حساب داری؟ <Link href="/login">ورود</Link></p>
  </div></section></main>;
}
