# گزارش نهایی تحویل ProjectOS

## ادامهٔ Gate B از `88d48a9`

- Baseline شاخهٔ تمیز `main` با GitHub منطبق بود. `npm run test:core` با ۴۷/۴۷ پاس شد. شواهد مرورگر و CI مبنا در گزارش پایین ثبت‌اند.
- `schema/postgres/grant-runtime.sql` و آزمون `scripts/postgres.test.cjs` نقش ورود مجزای وب را پوشش می‌دهند. نسخهٔ سند و ممیزی فقط خواندنی و افزودنی‌اند. دسترسی نقش به DDL و دفتر Migration رد می‌شود.
- `npm run test:postgres` روی PostgreSQL 17.12 آزمایشی پاس شد. `npm run test:postgres-http` نیز با اتصال خود برنامه از طریق نقش محدود و اجرای احراز هویت، دعوت، رکوردها و خواندن مجوزمحور پاس شد. حساب مدیر فقط برای آماده‌سازی و بررسی Fixture استفاده شد.
- Gate B همچنان **FAIL** است. RLS، نرمال‌سازی کامل مدل، نقش‌های Worker و تمرین Cutover در Staging بازند. Gateهای C تا E بر اساس شواهد موجود پابرجا هستند و حکم انتشار **NO-GO** است.

## ادامهٔ توسعه در ۲۰ نوامبر ۲۰۲۶

| قابلیت | وضعیت | شواهد |
|---|---|---|
| ساخت و ویرایش پروژه، ثبت VPS، دو دامنه، دیتابیس، دو وظیفه و Runbook از رابط فارسی | `IMPLEMENTED_AND_VERIFIED` | `npm run test:project-lifecycle`، هر سه پروژهٔ آزمایشی NovaGuard، باشگاه و MOKMOK موفق در Chrome و PostgreSQL 17.12 محلی. مرورگر تازه پس از Restart و ورود مجدد، داده‌ها و ارتباط والد دیتابیس را نشان داد. |
| بایگانی با تأیید سرور و حذف از صفحهٔ پروژه | `IMPLEMENTED_AND_VERIFIED` | `npm run test:smoke`، Chrome با ۱۶ نتیجهٔ موفق. حذف پروژهٔ خالی بایگانی‌شده موفق بود. درخواست حذف پروژهٔ دارای منبع مشترک رد شد و هر دو رکورد باقی ماندند. |
| هزینهٔ تمدید منبع مشترک و مرتب‌سازی منابع بر اساس نام یا موعد تمدید | `IMPLEMENTED_AND_VERIFIED` | ثبت ۱۲٫۵۰ دلار با مقدار دقیق ۱۲۵۰ سنت، بازیابی خطای فرم و رد ارجاع نامعتبر در هر دو API نوشتن. بعد از لغو اشتراک‌گذاری، عضو محدود هزینه را می‌بیند و شناسهٔ منبع در پاسخ حذف می‌شود. |
| ورود واقعی و راه‌اندازی سه‌مرحله‌ای، RTL و Responsive | `IMPLEMENTED_AND_VERIFIED` | آزمون ورود دموی تاریخی با بررسی ورود ناموفق و موفق، عدم ماندگاری رمز در Browser Storage، و ذخیرهٔ فضای کاری و وظیفهٔ اختیاری جایگزین شد. هر ۶ آزمون تاریخی RTL، ۲۱ صفحه را در عرض ۳۶۰، ۳۹۰، ۷۶۸، ۱۰۲۴، ۱۴۴۰ و ۱۹۲۰ بررسی می‌کنند. |
| دکمه‌های منو هنگام بارگیری | `IMPLEMENTED_AND_VERIFIED` | آزمون Chrome بارگیری JavaScript را عمداً متوقف کرد. دکمهٔ حساب تا آمادگی صفحه غیرفعال بود و پس از آماده‌شدن، منو را باز کرد. Prefetch خودکار ناوبری اصلی کاهش یافت. |
| ارجاع SSH Key به VPS در فاز ۲ | `IMPLEMENTED_AND_VERIFIED` | فرم مالک، مسیر دسترسی از جزئیات سرور، ذخیرهٔ فراداده، رد پروژهٔ نامرتبط و فیلد رمز خام، جلوگیری از حذف منبع دارای ارجاع و محدودیت خواندن Viewer آزموده شد. آزمون PostgreSQL حفظ ارتباط را در Migration و Restore تأیید کرد. |
| تأیید اتصال Vault در Staging | `BLOCKED_EXTERNAL` | آزمون قرارداد Mock از قبل سبز بود. بررسی اتصال واقعی و مجوز کاربر در Vault بیرونی باز است. |
| یادآوری و چرخهٔ هشدار در فاز ۳ | `IMPLEMENTED_AND_VERIFIED` | زمان اعلان از صفر تا ۶۰ روز در فرم‌های منبع، وظیفه و یادآوری ثبت می‌شود. قطع فرایند پس از Claim، لغو نوبت قبلی هنگام تغییر موعد و پذیرش فقط نوبت جدید با ارائه‌دهندهٔ شبیه‌سازی‌شده بررسی شد. همان لغو و ساخت نوبت روی PostgreSQL و رابط Snooze، Dismiss و Resolve در مرورگر تأیید شد. |
| تحویل تلگرام و ایمیل و Timer در Staging | `BLOCKED_EXTERNAL` | پذیرش محلی Mock ثبت شد. تأیید حساب ارائه‌دهنده و اجرای زمان‌بندی‌شده در محیط آزمایشی باز است. |
| گزارش دیسک و جزئیات سرور در فاز ۴ | `IMPLEMENTED_AND_VERIFIED` | عامل میزبان با نمونهٔ فایل‌سیستم محلی و HTTPS شبیه‌سازی‌شده آزموده شد. `test:postgres-http` پذیرش عامل، رد مجوز و دادهٔ ناقص و خواندن مجوزمحور را تأیید کرد. Migration 004 و Restore دادهٔ قدیمی و جدید را حفظ کردند. Chrome نمایش درصد تازه و پنهان‌کردن درصد قدیمی را تأیید کرد. |
| مرور فعالیت و دریافت سابقهٔ GitHub | `IMPLEMENTED_AND_VERIFIED` | مرور Commit، Branch، Pull Request و Issue در صفحهٔ پروژه و نمایش وضعیت قدیمی آزموده شدند. Mock سقف سه صفحه، حذف اقلام تکراری و پالایش پاسخ را بررسی کرد. آزمون HTTP با PostgreSQL خواندن مجاز Viewer و رد همگام‌سازی آن را تأیید کرد. اعتبارسنجی اتصال با حساب بیرونی Staging باز است. |
| فاکتور، اقساط، ثبت پرداخت و خروجی مالی | `IMPLEMENTED_AND_VERIFIED` | فرم فارسی، ثبت ۱۰۰٫۰۰ دلار در دو قسط، ثبت ۶۰٫۰۰ دلار و ماندهٔ دقیق ۴۰٫۰۰ دلار، رد شناسهٔ تکراری، ابطال فاکتور بدون پرداخت، CSV و محدودیت کاربر خارج از پروژه در Playwright تأیید شدند. Migration 005 و `test:postgres` ثبت هم‌زمان، ارز ناسازگار، اضافه‌پرداخت و جلوگیری از حذف پرداخت را آزمودند. تطبیق پرداخت با قرارداد باز است. |
| ثبت نرخ تبدیل با منبع و زمان | `IMPLEMENTED_AND_VERIFIED` | Migration 006، ثبت دستی مالک، ذخیرهٔ منبع و زمان UTC، محاسبه و گردکردن با BigInt، نمایش برآورد مجوزمحور و بازیابی پس از Restore آزموده شدند. دریافت خودکار نرخ و تطبیق نرخ با صورتحساب پرداخت بیرونی بازند. |
| ادامهٔ کار پروژه و استناد به رویداد | `IMPLEMENTED_AND_VERIFIED` | API فعالیت اخیر و قدم بعدی ثبت‌شده یا وظیفهٔ قابل پیگیری پروژه را با زمان و لینک برمی‌گرداند. حالت ادامهٔ کار در سرور اجرا می‌شود. آزمون HTTP روی PostgreSQL، نبود ارسال بیرونی، رد پروژه و رویداد غیرمجاز و دسترسی به رویداد از لینک استناد را تأیید کرد. جست‌وجوی معنایی و ارزیابی مدل در حساب Staging بازند. |
| اعتبارسنجی آفلاین آرشیو و بازیابی فاکتور و پرداخت | `IMPLEMENTED_AND_VERIFIED` | `npm run verify:postgres-backup` اصالت، جدول‌های لازم و خواندن داده‌های آرشیو را بررسی می‌کند. در `test:postgres` آرشیو ناقص و دادهٔ نامعتبر رد شدند. یک Restore جداگانه پرداخت و وضعیت ابطال فاکتور را از Backup بازیابی کرد. |
| آزمون‌های تاریخی روی ورود واقعی و دیتابیس ایزوله | `IMPLEMENTED_AND_VERIFIED` | هر ۱۳ سناریو در `npm run test:workflows` با Chrome پاس شدند. آزمون‌ها جست‌وجو، ناوبری موبایل، پروژه، وظیفه، منبع، Vault، تقویم، پایش، هشدار، مالی، سند، فعالیت و دعوت را پوشش می‌دهند. اجرای جداگانه در CI فعال است. |
| فیلتر زمانی و تلاش مجدد پایش و ثبت اتمیک فعالیت با وظیفه | `IMPLEMENTED_AND_VERIFIED` | فیلتر فقط مشاهدات دریافتی دارای زمان را نمایش می‌دهد. وضعیت قدیمی و خطای دریافت در مرورگر با پاسخ آزمایشی بررسی شدند. `test:postgres-http` ثبت رویداد و وظیفه، رد ورودی نامعتبر و محدودیت خواندن وظیفه را تأیید کرد. |
| پذیرش سه سناریوی اصلی فاز ۱ | `IMPLEMENTED_AND_VERIFIED` | NovaGuard، باشگاه و MOKMOK در آزمون ثبت داده، بازخوانی، Restart و ورود دوباره موفق بودند. پوشش عمومی رابط در Gate E ثبت شده است. |

`npm ci --include=optional`، `npm run lint`، `npm run build` با TypeScript، ۴۲ تست هسته و آزمون‌های محلی `test:postgres` و `test:postgres-http` موفق بودند. مجموعهٔ ۲۷‌تایی در Chrome و Firefox سبز شد. WebKit ابتدا یکی از آزمون‌های RTL را با خطای Prefetch هنگام جابه‌جایی اجباری ثبت کرد. آزمون مرور هر مسیر را به سند جدا منتقل کرد و مسیر ۳۹۰ پیکسل در دو اجرای پی‌درپی موفق شد. ۱۳ آزمون تاریخی Workflow همچنان از الگوی دمو استفاده می‌کنند و برای این نسخه تأیید نشده‌اند.

در ادامهٔ فاز ۳، `test:core` با ۴۳ نتیجهٔ موفق، `test:smoke` در Chrome با ۲۸ نتیجهٔ موفق، `test:postgres` با یک نتیجهٔ موفق و `test:project-lifecycle` با سه نتیجهٔ موفق اجرا شدند. ارسال زمان‌بندی‌شده به مقصد بیرونی در این اجرا بررسی نشد.

[CI یادآوری](https://github.com/alirava56/progect_os/actions/runs/44697863581) موفق شد. پس از تغییرات GitHub، Build، TypeScript و ESLint موفق بودند. Chrome هر ۳۰ سناریو و Core هر ۴۵ آزمون را پاس کردند. `test:postgres` و `test:postgres-http` محلی نیز موفق بودند.

در [CI پایش](https://github.com/alirava56/progect_os/actions/runs/44698634854)، Windows، Ubuntu و CodeQL موفق بودند و خواندن فهرست آرشیو PostgreSQL 16 شکست خورد. تست بازیابی اکنون فهرست یک آرشیو کاملاً آزمایشی را با ابزار رسمی مستقل بررسی می‌کند تا منشأ شکست بعدی مشخص شود.

اجرای [CI نسخهٔ مبنا](https://github.com/alirava56/progect_os/actions/runs/44632719901) و [CI آزمون‌های تاریخی](https://github.com/alirava56/progect_os/actions/runs/44641957900) در بازیابی PostgreSQL 16 خطا دادند. [اجرای فاز ۱](https://github.com/alirava56/progect_os/actions/runs/44634151927)، [اجرای هزینه و دسترسی](https://github.com/alirava56/progect_os/actions/runs/44635325658) و [اجرای ارجاع Vault](https://github.com/alirava56/progect_os/actions/runs/44642856467) در Windows، Ubuntu، CodeQL و آزمایش‌های PostgreSQL موفق بودند.

در [CI یکپارچه‌سازی GitHub](https://github.com/alirava56/progect_os/actions/runs/44699504089)، ابزار `pg_restore` صفر بایت محتوای رمزگشایی‌شده گزارش داد. `pg_dump` می‌توانست پیش از اتصال خوانندهٔ رمزنگار خارج شود. در `scripts/postgres-archive.mjs` خواندن جریان بلافاصله شروع می‌شود و فایل خالی منتشر نمی‌شود. `test:postgres` محلی بررسی مستقل فهرست اشیای آرشیو و Restore را پاس کرد. مجموعهٔ قبلی WebKit با ۳۰/۳۰ پاس شد و Firefox در ۲۹/۳۰ روی انتظار برای درخواست‌های پس‌زمینه متوقف شد. انتظار پایان Prefetch اکنون به WebKit محدود است و عرض ۱۴۴۰ در Firefox دو بار موفق شد. وضعیت انتشار **NO-GO** است. جدول زیر سند اجرای ۱۹ نوامبر است.

Job یکپارچهٔ Migration و بازیابی PostgreSQL 16 پس از اصلاح جریان موفق شد. [CI اصلاح Backup](https://github.com/alirava56/progect_os/actions/runs/44700733566)

نسخهٔ فاکتور Build، TypeScript و ESLint را پاس کرد. `test:smoke` در Chrome با ۳۱/۳۱، `test:core` با ۴۶/۴۶، `test:postgres` با یک نتیجه و `test:postgres-http` با آزمون HTTP روی PostgreSQL 17.12 موفق بودند. فایل‌های اصلی `src/components/invoice-ledger.tsx`، `src/lib/server/db.ts`، `src/lib/server/validation.ts`، `schema/postgres/005_invoice_records.sql` و `tests/release.spec.ts` هستند.

هر چهار Job نسخهٔ مالی روی Windows، Ubuntu، PostgreSQL 16 و CodeQL موفق شدند. [CI فاکتور و پرداخت](https://github.com/alirava56/progect_os/actions/runs/44701353073)

نسخهٔ ادامهٔ کار و بازیابی، ۳۲/۳۲ سناریوی Smoke را در هر یک از Chrome، Firefox و WebKit پاس کرد. هر چهار Job میزبانی‌شدهٔ نسخهٔ اعتبارسنجی آرشیو موفق شدند. [CI ادامهٔ کار](https://github.com/alirava56/progect_os/actions/runs/44702381273) · [CI اعتبارسنجی آرشیو](https://github.com/alirava56/progect_os/actions/runs/44702551197)

در نسخهٔ Workflow کامل، Chrome و Firefox هر کدام ۴۵/۴۵ و WebKit ۴۲/۴۵ نتیجه داشتند. هر چهار Job CI همراه با ۱۳ Workflow پاس شدند. سه شکست WebKit مربوط به بازگرداندن فوکوس جست‌وجو، اعمال فیلتر تاریخ بعد از ثبت هزینه و آمادگی فرم دعوت بودند. پس از اصلاح، هر سه سناریو به‌همراه نرخ تبدیل در اجرای هدفمند WebKit پاس شدند. [CI Workflow کامل](https://github.com/alirava56/progect_os/actions/runs/44703496614)

### بازآزمایی روی نسخهٔ انتشار خصوصی

- Commit سورس `0f81568` همراه با ساخت Migration 006 در GitHub Actions چهار Job موفق داشت. Windows و Ubuntu نصب تمیز، TypeScript، ESLint، Core، بررسی وابستگی، Build، Smoke و ۱۳ Workflow را اجرا کردند. PostgreSQL 16 آزمون Migration، Backup، Restore، HTTP و سه چرخهٔ ماندگاری پروژه را پاس کرد. CodeQL هم اجرا شد. [اجرای CI](https://github.com/alirava56/progect_os/actions/runs/44705562774)
- `npx playwright test --config=playwright.config.ts --browser=chromium`، همان فرمان با `--browser=firefox` و همان فرمان با `--browser=webkit`، هر کدام ۴۶/۴۶ نتیجهٔ موفق داشتند. مجموعه شامل ۳۳ Smoke/Release و ۱۳ Workflow است. ۲۱ مسیر فارسی در شش اندازهٔ ۳۶۰، ۳۹۰، ۷۶۸، ۱۰۲۴، ۱۴۴۰ و ۱۹۲۰ بررسی شدند.
- در Windows با Node.js 24.18.0، `npm run test:core` با ۴۷/۴۷ موفق شد. مقایسه با ZIP رسمی نشان داد ۳۵ سناریوی Core اصلی و ۹ سناریوی Smoke اولیه هنوز در مجموعه حضور دارند. پوشش ورود نمایشی به سناریوی ورود واقعی، رد ورود ناموفق و ذخیرهٔ Onboarding منتقل شد.
- `npm run test:postgres` روی PostgreSQL 17.12 با یک سناریوی ترتیبی کامل و `npm run test:postgres-http` روی Build تولید موفق بودند. آزمون Restore دوم، فاکتور، پرداخت و نرخ دارای منبع را پس از بازیابی بررسی کرد. `npm run test:project-lifecycle -- --workers=1` با TLS لوکال هر سه سناریو را پاس کرد. تنظیم اعتبار گواهی آزمایشی فقط برای نشانی Loopback در `tests/project-lifecycle.spec.ts` اعمال می‌شود.
- بررسی SQLite روی نسخهٔ کاملاً ساختگی با `backup`، `verify:backup`، `test:restore`، `backup:encrypted` و `verify:encrypted-backup` موفق بود. در آزمون Restore یک Workspace و یک پروژه بازیابی شدند و بررسی کلید خارجی خطا نداشت.
- مقایسهٔ `public/` با مبنای ZIP هیچ تغییری در ۳۲ آیکون نشان نداد. `npm audit --audit-level=high` برای وابستگی‌های قفل‌شده خطایی گزارش نکرد. اجرای Build و آزمایش‌ها در این مرحله با داده و سرویس آزمایشی انجام شد.
- در اجرای `5f5df09`، سه Job میزبانی‌شده موفق شدند و شش Workflow ویندوز در درخواست راه‌اندازی دادهٔ تست به مهلت ۱۲ ثانیه رسیدند. Fixture اکنون آمادگی دیتابیس را بررسی می‌کند و پیش از بازکردن مرورگر با یک نشست API جداگانه دادهٔ تست را می‌سازد. تمام Assertionهای سناریوها حفظ شدند. اجرای ترتیبی `npm run test:workflows -- --workers=1` هر ۱۳ سناریو را در Windows محلی پاس کرد. Windows CI همین فرمان را اجرا می‌کند. [اجرای دارای خطای آماده‌سازی](https://github.com/alirava56/progect_os/actions/runs/44706697205)

### وضعیت جاری Gateها

| Gate | وضعیت | آخرین شواهد و مسیرها | شرط باقی‌مانده |
|---|---|---|---|
| A | **PASS** | `npm run lint`، `npm run typecheck`، `npm run build`، ۴۷/۴۷ Core، ۴۶/۴۶ در هر یک از Chrome، Firefox و WebKit و چهار Job موفق CI. ۳۵ Core و ۹ Smoke اصلی حفظ و بازآزمایی شدند. | بسته شد. |
| B | **FAIL** | Auth، MFA، CSRF، Grant و هم‌زمانی در Core و HTTP. `npm run test:postgres`، `npm run test:postgres-http` و Migrationهای `schema/postgres/` تا ۰۰۶. | نرمال‌سازی کامل مدل هدف، سیاست PostgreSQL RLS، مرور مجوز حساب سرویس و تمرین Cutover و Rollback محیط هدف. |
| C | **BLOCKED** | Lease و بازیابی پس از قطع Worker در Core، آزمون قرارداد Vault، تحویل Mock، سلامت آفلاین و Restore جداگانه در `test:postgres` و `scripts/postgres-archive.mjs`. | `BLOCKED_EXTERNAL` برای Vault و ارائه‌دهندگان ارسال در Staging، Timer محیط هدف، نگهداری Offsite و سنجش RPO/RTO. |
| D | **FAIL** | عامل دیسک، GitHub با Backfill محدود، فاکتور و پرداخت، نرخ تبدیل دستی و ادامهٔ کار مجوزمحور در Build، Core، PostgreSQL و Playwright. `src/lib/server/project-memory.ts`، `src/components/invoice-ledger.tsx`، `src/components/exchange-rates.tsx` و `scripts/verify-postgres-http.mjs`. | جست‌وجوی معنایی، دریافت خودکار نرخ، سهم‌بندی هزینهٔ مشترک، تطبیق تسویهٔ قرارداد، پایش VPN/SLO و Backfill خودکار. آزمون حساب‌های خارجی مدل، GitHub و پایش در وضعیت `BLOCKED_EXTERNAL` است. |
| E | **FAIL** | ۲۱ مسیر RTL در شش عرض، ۱۳ Workflow تاریخی، axe روی ورود و داشبورد، آزمون Postgres مهاجرت و بازیابی و مرزهای دسترسی و هم‌زمانی HTTP. | بررسی دستی WCAG 2.2 AA، ممیزی مستقل، بار پایدار محیط هدف و DR/Cutover آزمایشی. |

گزارش تاریخی ۱۹ نوامبر در ادامه حفظ شده است. وضعیت جاری هر Gate در جدول بالا ثبت شده است و حکم انتشار Production **NO-GO** است.

**حکم انتشار Production: NO-GO**

تاریخ اجرای محلی ۱۹ نوامبر ۲۰۲۶، منطقهٔ زمانی تهران. مبنا `ProjectOS-P0-Verified-2026-11-18.zip` با SHA-256 `376662fcef9af1b20ed2f3e421121a85666a1c4aeb32e758e8b69843be83c019` است. اولین Commit محلی `44916a2f5b04212780d11eb410661c8e9742341b` و Commit سورس و تست گزارش‌شده `64359a57cb9a17ddeb2eeb770cea46550a546965` است. این شناسه‌ها در این اجرا از ZIP ساخته شده‌اند.

سورس تحویلی ۲۰ مسیر Workspace، ۲۱ مسیر API و ۳۲ آیکون اصلی دارد. Git هیچ تغییری در فایل‌های آیکون نسبت به ورودی نشان نداد. عملیات روی کپی سورس و دیتابیس‌ها و حساب‌های موقت انجام شد. اتصال‌های Production، دادهٔ واقعی و استقرار عمومی خارج از اجرا بودند.

## Gateها و شواهد

| Gate | وضعیت | پیاده‌سازی، دستورات و شواهد کد | باقیمانده برای PASS |
|---|---|---|---|
| A — تثبیت | **FAIL** | `npm ci --include=optional`، `typecheck`، `lint`، `test:core`، `build`، `test:smoke` در Chrome و WebKit و `npm audit --audit-level=high` روی Windows موفق‌اند. `tests/isolated-app.ts`، `scripts/prepare-e2e.mjs`، `playwright.smoke.config.ts`، `next.config.ts` و `.github/workflows/ci.yml`. | ۲۰ آزمون تاریخی مؤلفه‌های دمو در Build فعلی شکست خوردند. Firefox محلی برای ۴ تست صفحه راه‌اندازی نشد. CI میزبانی‌شدهٔ Windows/Linux و CodeQL در این اجرا **BLOCKED_EXTERNAL** هستند. |
| B — Backend و امنیت | **FAIL** | PostgreSQL واقعی در Build تولید، ۳ Migration اسکیمای SQL، Import از SQLite، نسخهٔ رکورد، Batch اتمیک، Scope پروژه و فیلد، MFA ثبت/تغییر و مدیریت نشست. `npm run test:postgres`، `npm run test:postgres-http`، Core و HTTP از جمله دو ویرایش مستقل، تضاد هم‌رکورد، Grant، CSRF و Recovery موفق‌اند. `schema/postgres/`، `scripts/sqlite-import.mjs`، `src/lib/server/{db,record-service,auth,mfa,invitations}.ts` و APIهای مرتبط. | مدل دامنه هنوز از payloadهای سازگار رکورد استفاده می‌کند. نرمال‌سازی کامل مدل هدف و RLS باقی‌اند. بررسی نقش واقعی سرویس، تمرین Cutover و Rollback پس از شروع نوشتن در محیط هدف انجام نشده‌اند. |
| C — Vault، یادآوری و Backup | **BLOCKED** | آداپتر فقط فرادادهٔ HashiCorp KV v2، یادآوری تقویمی، حفظ شناسه، Snooze، Outbox در هر دو موتور، Retry/Lease و Backup/Restore رمزنگاری‌شده. `npm run test:core`، تست Mock Vault و Crash/Lease و `npm run test:postgres` موفق‌اند. `src/lib/server/vault.ts`، `scripts/reminder-scheduler.mjs`، `scripts/notification-delivery.mjs`، `scripts/postgres-archive.mjs`. | Vault، Telegram، Resend و Worker زمان‌بندی‌شده روی Staging **BLOCKED_EXTERNAL** هستند. نگهداشت Offsite و RPO/RTO واقعی **BLOCKED_EXTERNAL** هستند. وضعیت ارسال آزمایشی حد پذیرش ارائه‌دهنده را از خوانده‌شدن جدا می‌کند. |
| D — قابلیت‌های پیشرفته | **FAIL** | HTTPS و TLS با بررسی DNS، مسیر عامل CPU/RAM دارای زمان و منبع، GitHub خواندنی با وب‌هوک، Scope، Retry، آثار مالی BigInt در واحد جدا و حافظهٔ پروژهٔ Scoped با بررسی گزیده. `npm run test:core` و Smoke HTTP حافظه پاس شدند. `scripts/monitor-probe.mjs`، `src/lib/server/github.ts`، `src/lib/money.ts`، `src/lib/server/project-memory.ts` و APIها. | Ledger مستقل پرداخت، Invoice، تخصیص منابع و FX دارای منبع باقی‌اند. Backfill خودکار GitHub و VPN، DNS SLO و پایش چندنقطه‌ای تکمیل نشده‌اند. تأیید سرویس‌های GitHub، عامل میزبان و مدل AI در محیط آزمایشی **BLOCKED_EXTERNAL** است. |
| E — تأیید نهایی | **FAIL** | ۱۵/۱۵ سناریو در Chrome و WebKit. ۲۰ مسیر Workspace در سه عرض ۳۹۰، ۷۶۸ و ۱۴۴۰. axe بر ورود و داشبورد، MFA، کنترل نقش، فرم فارسی واقعی، P95 محلی و Restore/Migration/Rollback تراکنشی. `tests/functional.spec.ts`، `tests/release.spec.ts` و `scripts/postgres.test.cjs`. | Firefox و مجموعهٔ تاریخی کامل سبز نیستند. بررسی دستی و سراسری WCAG، load/soak محیط هدف، آزمون امنیت مستقل، اجرای Linux میزبانی‌شده و DR/Cutover بیرونی باقی دارند. |

## خروجی بازتولیدپذیر

محیط نهایی Windows x64، Node.js 22.23.5، npm 10.9.9، Next.js 16.4.6 و PostgreSQL 17.12 محلی بود. خلاصهٔ Baseline و فهرست تغییرات در [پوشهٔ شواهد](evidence-2026-11-19/) آمده‌اند. لاگ‌های خام این اجرا در نسخهٔ محلی تحویل باقی مانده‌اند.

| دستور | کد خروج | نتیجه |
|---|---:|---|
| `npm ci --include=optional` در کپی تازه از Commit میانی با همین Lockfile | 0 | Windows، وابستگی‌های اختیاری درست نصب شدند. |
| `npm run typecheck` / `npm run lint` | 0 / 0 | هردو روی سورس و تست جاری موفق. |
| `npm run test:core` | 0 | ۴۲ موفق از ۴۲، شامل ۳۵ تست اصلی و ۷ رگرسیون جدید. هیچ مورد Skip نشد. |
| `npm run build` | 0 | Build تولید. بسته‌بندی `pg` مشکل Junction در Windows را رفع کرد. |
| `npm run test:smoke` با Chrome 157.0.8103.79 نصب‌شده | 0 | ۱۵ موفق، شامل هر ۹ آزمون Smoke قبلی. |
| `npm run test:smoke -- --browser=webkit` با TLS موقت loopback | 0 | ۱۵ موفق. هر ۴ مسیر مرتبط با مرورگر واقعی اجرا شد. |
| `npm run test:smoke -- --browser=firefox` با همان TLS و پوشهٔ موقت مستقل | 1 | ۱۱ تست API موفق، ۴ تست نیازمند مرورگر با خطای شروع فرایند Firefox متوقف شدند. |
| `npm audit --audit-level=high` | 0 | صفر مورد در خروجی همین رجیستری و تاریخ. |
| `npm run test:postgres` | 0 | ۱ آزمون یکپارچهٔ ترتیبی. هش و شمارش Import، اجرای دوباره، Failure قبل از Commit، احراز هویت، هم‌زمانی، آرشیو و Restore به دیتابیس خالی آزموده شدند. |
| `npm run test:postgres-http` | 0 | Build تولید PostgreSQL را واقعاً برای Health، Setup و عملیات رکوردی استفاده کرد. |
| `npx playwright install chromium firefox webkit` | 1 | دانلود Chromium با 403 رجیون متوقف شد. Chrome نصب‌شده برای اجرا استفاده شد. |
| `npx playwright install firefox webkit` | 0 | دو موتور دریافت شدند. نتیجهٔ اجرای خود Firefox در ردیف جدا آمده است. |
| Playwright با `responsive.spec.ts` و `workflows.spec.ts` در سرور موقت Build تولید | 1 | ۱۹ شکست ثبت شدند و فراخوانی مجموعه به سقف زمانی رسید. سناریوی بیستم با `-g "demo login"` جداگانه اجرا شد و exit 1 داشت. مثال شاهد، انتظار دکمهٔ «ورود به حساب نمایشی» و مسیرهای نمونه بدون نشست معتبر است. |

آزمون‌های آداپتر Vault، محدودیت نرخ GitHub و رد DNS خصوصی با پاسخ کنترل‌شده و در وضعیت `MOCK_ONLY` بودند. اتصال پیام‌رسان، مدل و حساب واقعی GitHub فعال نشد. Worker Lease محلی پس از انقضا بازیابی شد و تلاش قبلی اجازهٔ Commit نتیجهٔ جدید را نداشت. تحویل خارجی همچنان از الگوی حداقل یک‌بار و پذیرش ارائه‌دهنده استفاده می‌کند.

P95 گرد‌شده در Chrome و WebKit هر دو **۶۸ ms** بود. بار آزمون فقط ۵۰ درخواست خواندن Snapshot، هم‌زمانی ۵ و ۶۱ رکورد ساختگی در SQLite موقت بود. این اندازه‌گیری مبنای SLA یا ظرفیت PostgreSQL نیست. axe فقط روی صفحهٔ ورود و داشبورد اجرا شد.

### بازتولید TLS مرورگر

برای سناریوهای loopback، WebKit در HTTP ممکن است Cookie دارای پیشوند `__Host-` را نپذیرد. Fixture فعلی امکان آزمون HTTPS با گواهی موقت اختصاصی را دارد. گواهی یا کلید محیط واقعی را استفاده نکنید. کلید در ZIP سورس وجود ندارد. گزینهٔ پذیرش گواهی خودامضا محدود به Context آزمایشی HTTPS روی 127.0.0.1 است.

```shell
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=ProjectOS Loopback Test" -addext "subjectAltName=IP:127.0.0.1" -keyout loopback.key -out loopback.crt
```

مسیر مطلق دو فایل موقت را در `PROJECTOS_TEST_TLS_KEY` و `PROJECTOS_TEST_TLS_CERT` بگذارید و `npm run test:smoke -- --browser=webkit` را اجرا کنید. در این اجرا گواهی با Python Cryptography ساخته شد و همین قرارداد PEM را استفاده کرد. برای PostgreSQL، `PROJECTOS_TEST_POSTGRES_URL` به دیتابیس مدیریتی `postgres` روی loopback و یک Cluster آزمایشی اشاره می‌کند. تست تنها دیتابیس‌هایی با نام تولیدشده از Prefix آزمایشی خودش می‌سازد و جمع می‌کند.

## تحویل‌ها

- [ممیزی سورس](../audit/FINAL-SOURCE-AUDIT-FA.md) و [ماتریس پذیرش](ACCEPTANCE-MATRIX.csv)
- [ERD](../architecture/ERD.md)، [تصمیم معماری](../architecture/ADR-002-postgres-runtime.md) و [قرارداد API](../architecture/API-CONTRACT.md)
- [ماتریس مجوز](../security/AUTHZ-MATRIX.md)، [مدل تهدید](../security/THREAT-MODEL.md) و [آزمون‌های امنیتی](../security/SECURITY-TEST-RESULTS.md)
- [Migration و Rollback](../migrations/SQLITE-TO-POSTGRES-FA.md)، [استقرار](../operations/DEPLOYMENT-FA.md)، [Backup و بازیابی](../operations/BACKUP-RESTORE-FA.md) و [اتصال‌ها](../operations/INTEGRATIONS-FA.md)
- [فهرست تغییرات سورس و آزمون‌ها](evidence-2026-11-19/CHANGED-FILES.txt)

اسناد تحویل از نتایج تاریخی ZIP ورودی جدا ثبت شدند. وضعیت همهٔ Gateها در جدول بالا معتبر است و انتشار عمومی برای این تحویل در وضعیت **NO-GO** باقی می‌ماند.
