# اتصال‌های ProjectOS

اتصال‌ها با تنظیمات سرور و Workspace یا Project مشخص فعال می‌شوند. در این تحویل دسترسی بیرونی با حساب Staging اپراتور لازم است. از رمز Production استفاده نکنید.

## Vault

`PROJECTOS_VAULT_WORKSPACE`، `PROJECTOS_VAULT_ORIGIN` و `PROJECTOS_VAULT_MOUNTS` را به میزبان HTTPS و Mountهای مجاز محدود کنید. `PROJECTOS_VAULT_PREFIXES` محدودیت محلی اختیاری با قالب `mount/prefix` و جداکنندهٔ ویرگول است. `PROJECTOS_VAULT_TOKEN` باید فقط حق خواندن `<mount>/metadata/<prefix>/*` در KV v2 را داشته باشد. دسترسی مسیر `data` لازم نیست. مالک با رمز و عامل دوم فعال می‌تواند فراداده را بررسی کند. API تنها وضعیت، زمان و شمارهٔ نسخهٔ فراداده را ذخیره می‌کند. نبود فرادادهٔ فعال، قطع سرویس، رد دسترسی، اتصال تنظیم‌نشده و بررسی منقضی در رابط وضعیت جداگانه دارند. پاسخ KV v2 محدود و اعتبار گواهی HTTPS با زنجیرهٔ اعتماد Node بررسی می‌شود. برای گواهی داخلی، CA سازمان را در زمان راه‌اندازی فرایند با `NODE_EXTRA_CA_CERTS` معرفی کنید. توکن را در تنظیمات خصوصی همان فرایند قرار دهید. [قرارداد HashiCorp KV v2](https://developer.hashicorp.com/vault/api-docs/secret/kv/kv-v2)

## اعلان و زمان‌بندی

`PROJECTOS_NOTIFICATION_WORKSPACE` ارسال را به یک Workspace محدود می‌کند. دو کانال جداگانه فعال می‌شوند. Telegram از `PROJECTOS_TELEGRAM_BOT_TOKEN` و `PROJECTOS_TELEGRAM_CHAT_ID` استفاده می‌کند. پیام پیش‌فرض فقط زمان را دارد. برای گروه خصوصی تأییدشده، تنظیم `PROJECTOS_TELEGRAM_PROJECT_DETAILS=enabled` عنوان هشدار و نام پروژه را به متن ساده اضافه می‌کند. ایمیل Resend با `PROJECTOS_RESEND_API_KEY`، `PROJECTOS_EMAIL_FROM` و `PROJECTOS_EMAIL_TO` تنظیم می‌شود. از فرستندهٔ تأییدشده و گیرندهٔ آزمایشی استفاده کنید. متن و HTML ایمیل عمومی‌اند و نام پروژه و عنوان خصوصی را منتقل نمی‌کنند. [Telegram Bot API](https://core.telegram.org/bots/api) · [قرارداد Resend](https://resend.com/docs/api-reference/emails/send-email)

ارسال موفق در رابط «پذیرفته‌شده توسط ارائه‌دهنده» است. محدودیت نرخ و خطای موقت به تلاش مجدد با فاصلهٔ حداقل اعلام‌شده منتهی می‌شوند. حداکثر پنج تلاش در مهلت همان روز محلی انجام می‌شود. Timeout، قطع ارتباط یا توقف پردازشگر بعد از شروع درخواست می‌تواند نتیجهٔ ارسال را نامعلوم بگذارد. در این حالت ارسال خودکار دیگری انجام نمی‌شود. Resend برای تلاش‌های مجدد کلید ثابت دارد. Telegram تضمین تحویل دقیقاً یک‌بار ندارد. [کلید Idempotency در Resend](https://resend.com/docs/dashboard/emails/idempotency-keys)

`PROJECTOS_REMINDER_OFFSETS` پیش‌فرض `14,7,3,1,0` دارد. یک موعد UTC ابتدا به روز محلی در zone موردنظر تبدیل می‌شود. زمان‌بندی تکرار روزانه، هفتگی و تقویمی ماهانه یا سالانه را دارد. قراردادها و چرخش Vault می‌توانند سررسید بسازند. Digest در صورت داشتن موعد باز، روزانه یک کلید ثابت دارد. در تقویم می‌توان موعد، ساعت محلی، تکرار و توقف یادآوری را تنظیم کرد. در «هشدارها و یادآوری‌ها» زمان پذیرش و تلاش بعدی برای هر کانال نمایش داده می‌شود. گزینهٔ تنظیمات یادآوری‌ها آخرین اجرای ثبت‌شدهٔ هر پردازشگر را برای مالک همان Workspace نشان می‌دهد.

### اجرای محلی با PostgreSQL

۱. یک پایگاه آزمایشی Loopback آماده کنید. با حساب مالک طرح، `npm run db:migrate` و سپس دستورهای اختصاص نقش در `schema/postgres/grant-runtime.sql`، `grant-reminder.sql` و `grant-delivery.sql` را مطابق راهنمای PostgreSQL اجرا کنید. وب، زمان‌بند و تحویل با سه حساب مجزا اجرا می‌شوند.

۲. در محیط خصوصی Worker مقدار `PROJECTOS_LOCAL_REMINDER_DATABASE_URL` و شناسهٔ `PROJECTOS_NOTIFICATION_WORKSPACE` را تنظیم کنید. برای تحویل بیرونی، `PROJECTOS_LOCAL_DELIVERY_DATABASE_URL`، تنظیمات کانال و `PROJECTOS_TELEGRAM_NOTIFICATIONS=enabled` یا `PROJECTOS_EMAIL_NOTIFICATIONS=enabled` را نیز تنظیم کنید. بدون فعال‌سازی کانال، زمان‌بند فقط اعلان درون برنامه می‌سازد. آزمون محلی ارائه‌دهندگان بدون ارسال بیرونی از `npm run test:core` و سناریوی PostgreSQL Browser اجرا می‌شود.

۳. برنامه را در یک ترمینال و `npm run workers:local` را در ترمینال جدا اجرا کنید. فاصلهٔ پیش‌فرض ۳۰ ثانیه است و با `PROJECTOS_LOCAL_WORKER_INTERVAL_MS` تغییر می‌کند. خروجی هر چرخه، وضعیت زمان‌بند و تحویل را نشان می‌دهد. با Ctrl+C چرخهٔ جدید شروع نمی‌شود و عملیات فعال فرصت پایان دارد. روی یک Workspace تنظیم کانال یکسان نگه داشته می‌شود. قفل Workspace و Lease صف میان پردازشگرها در PostgreSQL اعمال می‌شوند.

۴. در تقویم یک یادآوری بسازید، در «هشدارها» آن را باز کنید و وضعیت کانال را ببینید. برای آزمون خطا و تلاش مجدد با سرویس ساختگی، سناریوی `restricted PostgreSQL reminder workers` در مجموعهٔ Playwright را اجرا کنید. سناریوی Vault در همین مجموعه به گواهی آزمایشی Loopback با IP SAN برای `127.0.0.1` و مسیرهای `PROJECTOS_TEST_TLS_KEY` و `PROJECTOS_TEST_TLS_CERT` نیاز دارد. CI گواهی موقت خود را می‌سازد.

## GitHub

`PROJECTOS_GITHUB_PROJECTS` آرایهٔ JSON از اشیای `{workspaceId,projectId,repository}` است. Allowlist قبلی `PROJECTOS_GITHUB_REPOS` باید با این نگاشت جایگزین شود تا هر مخزن دامنهٔ روشنی داشته باشد. با توکن خواندنی محدود به مخازن آزمایشی، مالک می‌تواند Overview، نمونهٔ Issue و Release و وضعیت آخرین Deployment را به‌روز کند. محدودیت نرخ زمان Retry دارد. Webhook معتبر با بدنهٔ HMAC و کلید `PROJECTOS_GITHUB_WEBHOOK_SECRET` به‌صورت idempotent ثبت می‌شود و خواندن را در انتظار Refresh قرار می‌دهد. بعد از دریافت رویداد، همگام‌سازی از پنل قابل اجراست. [اعتبارسنجی GitHub Webhook](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)

صفحهٔ پروژه نمونهٔ تاریخ‌دار Commitها، شاخه‌ها، Pull Requestها و Issueهای باز را نشان می‌دهد. «همگام‌سازی» نمونهٔ اخیر و «دریافت سابقه» حداکثر ۳۰ قلم در هر نوع را بررسی می‌کند. اجرای بعدی نمونهٔ جاری را به‌روز می‌کند. مجوز خواندن Contents، Pull requests، Issues و Deployment را برای همان مخازن بررسی کنید. [Commit API](https://docs.github.com/en/rest/commits/commits#list-commits) · [Branch API](https://docs.github.com/en/rest/branches/branches#list-branches) · [Pull Request API](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests)

## نرخ ارز و هزینهٔ مشترک

دریافت نرخ در صفحهٔ مالی، پس از انتخاب پروژه، از طرف مالک فضا اجرا می‌شود. آداپتر `USD → IRR` به `PROJECTOS_CURRENCYAPI_ENABLED=enabled` و کلید سمت سرور `PROJECTOS_CURRENCYAPI_KEY` نیاز دارد. نرخ دستی در کنار آن در دسترس است. ارز و زمان نرخ از پاسخ بررسی می‌شوند. ثبت نرخ دارای زمان دریافت است و تازگی با زمان اعلام‌شدهٔ منبع سنجیده می‌شود. استعلام ناموفق نرخ قبلی را تغییر نمی‌دهد. [قرارداد CurrencyAPI](https://currencyapi.com/docs/latest/)

تخصیص مساوی هزینه در تراکنش Workspace به‌صورت یک ردیف مالی به ازای هر پروژه ثبت می‌شود. باقیماندهٔ تقسیم به ترتیب ثابت شناسهٔ پروژه توزیع می‌شود. جمع Workspace ردیف‌های سهم را یک‌بار می‌شمارد. تغییر روابط منبع، سهم‌های ثبت‌شده را بازنویسی نمی‌کند.

## پایش و حافظه پروژه

Worker HTTPS روی `PROJECTOS_MONITOR_HOSTS` و `PROJECTOS_MONITOR_WORKSPACE` محدود است. عامل میزبان فقط از مسیر امن `/api/monitoring/observations` گزارش می‌دهد و به شناسهٔ منابع مجاز محدود می‌شود. برای فعال‌سازی اندازه‌گیری دیسک، `PROJECTOS_AGENT_DISK_PATH` را روی مسیر فایل‌سیستم در همان میزبان تنظیم کنید. عامل فقط ظرفیت و مصرف را ارسال می‌کند. نام مسیر در دادهٔ پایش ثبت نمی‌شود. وضعیت تازه، قدیمی و نامشخص و منبع مشاهده مشخص است. پنل بودجهٔ خطا، نمونه‌های HTTPS در ۹۶ بازهٔ ۱۵ دقیقه‌ای کامل را بررسی می‌کند. چند خطا در یک بازه فقط یک بار شمرده می‌شوند. بازهٔ بی‌مشاهده از محاسبهٔ نرخ نمونه کنار می‌رود و پوشش ناقص به‌عنوان قبولی هدف نمایش داده نمی‌شود. پایش VPN و SLA چندنقطه‌ای به اتصال آزمایشی جداگانه نیاز دارد.

حافظهٔ پروژه به‌صورت محلی از داده مجاز استخراج می‌شود. ارسال گزیده به مدل صرفاً پس از فعال‌سازی دو تنظیم Server-side و رضایت همان درخواست مالک برای پروژه مشخص ممکن است. سرور تنها گزیدهٔ عینی با شناسهٔ منبع معتبر را نمایش می‌دهد. آزمون ارائه‌دهندهٔ واقعی در این تحویل انجام نشده است.
