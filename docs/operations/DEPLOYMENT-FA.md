# راهنمای اجرای ProjectOS در محیط خصوصی

## آماده‌سازی

- Node.js 22.18 به بالا، نصب تمیز وابستگی‌ها و اجرای همهٔ تست‌های نسخه را انجام دهید.
- برای تست بین‌سرویسی از PostgreSQL جداگانه و دادهٔ ساختگی استفاده کنید. Local SQLite برای توسعه و ورودی Migration در نظر گرفته شده است.
- `PROJECTOS_DATABASE_URL` و کلید MFA را در Secret Manager میزبان تزریق کنید. اتصال PostgreSQL خارج از loopback اعتبار TLS را بررسی می‌کند. در صورت استفاده از CA سازمان، PEM آن را با `PROJECTOS_PG_CA` در اختیار Runtime قرار دهید.
- نقش اجرای Migration اسکیمای SQL را بسازد. نقش Runtime دسترسی DDL یا UPDATE/DELETE روی جدول `audit_events` نداشته باشد. بکاپ با نقش خواندنی روی دیتابیس اختصاصی اجرا شود. پس از تغییر مجوزها، تست‌های محیط Staging را با نقش واقعی اجرا کنید.
- دامنهٔ HTTPS واقعی را دقیقاً برابر Origin مرورگر و بدون مسیر یا اسلش انتهایی در `PROJECTOS_PUBLIC_ORIGIN` قرار دهید. Proxy reverse باید TLS و محدودیت اندازهٔ بدنه را اعمال کند. برای فعال‌سازی `PROJECTOS_TRUST_CLIENT_IP` به Proxyای نیاز است که هدر ورودی `X-ProjectOS-Client-IP` را حذف و نشانی معتبر خودش را جایگزین کند. در نبود این تنظیم، برنامه محدودیت مشترک ورود اعمال می‌کند.
- `PROJECTOS_SETUP_TOKEN` تنها برای راه‌اندازی است. پس از ساخت مالک حذف شود. در استقرار خارج از loopback اولویت اقدام بعد، ثبت MFA است. نشست در انتظار MFA به API فضای کاری دسترسی ندارد.

```shell
npm ci --include=optional
npm run db:migrate
npm run build
npm run start -- --hostname 127.0.0.1 --port 3000
```

با `GET /api/health` سلامت لایهٔ دیتابیس را از روی کد ۲۰۰ یا ۵۰۳ بررسی کنید. این Endpoint دادهٔ عضویت یا جزئیات اتصال را برنمی‌گرداند. از بیرون، reverse proxy سلامت واقعی سرویس را پایش کند. برای Workerها `deployment/systemd/` الگوی Timer دارد. فایل محیط Worker باید همان دیتابیس را هدف بگیرد و حساب‌های آزمایشی مجزا داشته باشد.

## تأیید قبل از Cutover

### نقش اتصال برنامه

پس از Migration، مدیر PostgreSQL یک نقش ورود تازه و اختصاصی بدون عضویت در نقش‌های دیگر بسازد. گذرواژه را در Secret Manager تنظیم کند. اسکریپت زیر با اتصال مالک اسکیمای آزمایشی اجرا می‌شود. مقدار `runtime_role` نام نقش است.

```shell
psql "service=projectos_staging_migrator" -X -v runtime_role=projectos_app -f schema/postgres/grant-runtime.sql
```

پس از Migration 009 و پیش از فعال‌کردن حساب وب، کلید تصادفی ۳۲ بایتی مستقل را به‌شکل ۶۴ رقم هگز در Secret Manager قرار دهید. با اتصال مالک schema و همین مقدار در `PROJECTOS_DB_SCOPE_KEY`، فرمان `node scripts/provision-db-scope.mjs` را اجرا کنید. همان مقدار را به محیط وب بدهید. کلید در Backup قرار نمی‌گیرد. پس از Restore آن را دوباره Provision کنید. نصب Migration و چرخش کلید را در پنجرهٔ توقف نوشتن انجام دهید.

در Cutover برای فرایندهای وب و Worker مقدار `PROJECTOS_DATABASE_MODE=postgres` را فعال کنید. سلامت وب در این حالت، مجوز حساب عملیاتی و تطبیق کلید امضای Scope را هم بررسی می‌کند. حساب Migration فقط برای فرمان‌های نصب و نگهداری استفاده می‌شود. Workerها باید با Workspace و حساب اختصاصی خود شروع شوند.

برای ارسال اعلان، برای هر Workspace یک نقش ورود جدید بسازید و از حساب مهاجرت برای اجرای فرمان زیر استفاده کنید. اتصال آن نقش را فقط به فرایند `npm run notifications:deliver` بدهید.

```shell
psql "service=projectos_staging_migrator" -X -v delivery_role=projectos_delivery_alpha -v workspace_id=alpha -f schema/postgres/grant-delivery.sql
```

در Restore روی کلاستر تازه، نقش‌های ارجاع‌شده در Policyها را پیش از Restore با همان نام ایجاد کنید. GRANTها در آرشیو ثبت نمی‌شوند. پیش از اجرای مجدد Worker همان فرمان را با Workspace تأییدشده دوباره اجرا کنید.

برای HTTPS و زمان‌بند هم برای هر Workspace یک حساب اختصاصی بسازید و از اتصال مالک schema فرمان مربوط را اجرا کنید.

```shell
psql "service=projectos_staging_migrator" -X -v monitor_role=projectos_monitor_alpha -v workspace_id=alpha -f schema/postgres/grant-monitor.sql
psql "service=projectos_staging_migrator" -X -v reminder_role=projectos_reminder_alpha -v workspace_id=alpha -f schema/postgres/grant-reminder.sql
```

هر فرایند `npm run monitors` و `npm run reminders` به Connection String حساب خودش نیاز دارد. حساب پایش فقط Workspace ثبت‌شده را پوشش می‌دهد و محدودیت میزبان HTTPS در تنظیمات فرایند بررسی می‌شود. زمان‌بند برای موعد چرخش صرفاً شناسه، پروژه و تاریخ را از تابع PostgreSQL دریافت می‌کند. برای چند Workspace، نمونهٔ فرایند و حساب را جداگانه تنظیم کنید. دادهٔ ثبت نقش‌ها در Backup نیست و بعد از Restore دوباره Provision می‌شود.

حساب وب اجازهٔ تغییر رکوردهای عملیاتی و افزودن رویداد ممیزی و نسخهٔ سند را دارد. نگهداری و پاک‌سازی دوره‌ای، Worker و Backup با حساب‌های جداگانه اجرا می‌شوند. اسکریپت برای نقش تازه طراحی شده است و مجوزهای مستقیم قبلی یا مجوزهای عمومی سفارشی محیط را بازنشانی نمی‌کند. نتیجهٔ تفکیک نقش روی Staging باید با حساب واقعی همان محیط بررسی شود.

تست‌های CI، SCA و CodeQL، مجوزهای نقش واقعی PostgreSQL، Migration، بازیابی از صفر، رصد زمان‌بندی، عملکرد و دسترس‌پذیری را در محیط هدف اجرا کنید. قطع نگه‌داشتن نوشتن تا پایان Smoke، امکان بازگشت به ورودی SQLite را حفظ می‌کند. اطلاعات پایدار آمادهٔ بهره‌برداری نیازمند Backup مستقل و تمرین بازیابی است. [راهنمای Migration](../migrations/SQLITE-TO-POSTGRES-FA.md)
