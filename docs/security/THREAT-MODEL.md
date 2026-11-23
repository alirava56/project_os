# مدل تهدید جاری ProjectOS — ۱۹ نوامبر ۲۰۲۶

- PostgreSQL محیط عملیاتی و SQLite محیط توسعه و ورودی Migration است. رابط به عملیات رکوردی می‌نویسد. فرایند Migration ورودی را فقط می‌خواند و تطبیق داده و Backup را پیش از Commit بررسی می‌کند.
- نشست‌های HttpOnly، محدودیت پایدار ورود، MFA اجباری در استقرار خارج از loopback، Recovery تک‌مصرف و الزام تأیید عامل فعلی برای Rotation اجرا شده‌اند. اعتماد به هدر IP تنها با Proxy اختصاصی مجاز است. بازیابی سازمانی خارج از عامل دوم و رمز و بررسی مستقل چرخهٔ هویت باقی است.
- نقش‌های Workspace و Grantهای Project روی خواندن و نوشتن، اسناد تاریخی و حافظه اجرا می‌شوند. Scope در برنامه اعمال می‌شود. RLS عمومی و نقش‌های واقعی محیط Staging هنوز ارزیابی نشده‌اند.
- CSP مبتنی بر nonce در صفحات فعال است. CSS inline موجود برای مقدارهای UI مجاز است. مسیرهای تغییردهندهٔ نشست به Origin معتبر وابسته‌اند. Webhook و عامل میزبان مسیرهای ماشینی با احراز هویت جداگانه‌اند.
- HashiCorp KV فقط فراداده را می‌خواند. دریافت مقدار Vault در قرارداد وجود ندارد. متن آزاد الگوهای شناخته‌شده را رد می‌کند. دادهٔ نامعمول ممکن است از الگو عبور کند. در صورت رخداد، Rotation، پاک‌سازی کنترل‌شده، بررسی Log و Backup لازم است.
- سرور بدنهٔ خام GitHub Webhook را ذخیره نمی‌کند. Replay با شناسه و هش بدنه کنترل می‌شود. GitHub زمان تأیید قابل اتکا به همراه امضای بدنه در هر رویداد عرضه نمی‌کند. خطای اتصال، قدیمی‌شدن یا نبود مشاهده به‌عنوان سلامت نمایش داده نمی‌شود.
- پاسخ خارجی AI تنها شامل گزیدهٔ قابل تطبیق با منابع از قبل مجاز می‌شود. فعال‌سازی به رضایت پرسش و اپراتور وابسته است. آزمون ارائه‌دهندهٔ واقعی و آزمون گستردهٔ کیفیت Retrieval باز هستند.
- Backup PostgreSQL رمزنگاری می‌شود و Recovery در مقصد خالی آزموده شده است. Offsite، RPO/RTO محیط هدف، SAST میزبانی‌شده، ممیزی مستقل و تمرین Cutover روی Staging باز هستند.

[ماتریس مجوزها](AUTHZ-MATRIX.md) · [گزارش تحویل](../verification/FINAL-DELIVERY-REPORT-FA.md)

---

گزارش تاریخی زیر مربوط به نسخهٔ ۱۸ نوامبر است.

# ProjectOS Threat Model — Hardened private preview (2026-11-18)

## Boundary and operator responsibilities
The application is a private preview, **not** a credential vault or audited production service.
It stores project/server metadata and free-text documents in SQLite without full-disk encryption.
A malicious or compromised workstation can access the underlying file; protect host access and
never enter real passwords, tokens, SSH private keys, session cookies, or production credentials.

## Implemented defenses, verified at domain-test level
- One-time owner bootstrap token; invite-only membership with random 256-bit one-time codes,
  exact email binding, expiration, revocation and role-scoped records.
- Scrypt password hashes; hashed session tokens; HttpOnly, SameSite Strict cookies;
  `__Host-` Secure cookie name in production. Full-session revocation, password/MFA reauthentication.
- Optional RFC 6238 TOTP; AES-GCM encrypted seeds requiring a separately protected key;
  one-use high-entropy hashed recovery codes. Password is always required to use recovery codes.
- Canonical `PROJECTOS_PUBLIC_ORIGIN` mandatory on production mutating routes (CSRF defense).
  JSON bodies capped for auth endpoints, workspace and record mutation APIs.
- Owner-only full workspace writes. Editor: tasks/docs/reminders/incidents through single-record
  endpoint. Viewer: read-only. Workspace-scoped queries and state version conflicts.
- Best-effort credential-pattern rejection on new record payloads and redaction of previously
  stored suspicious values on read; offline remediation requires verified encrypted backup.
- AES-256-GCM backup tool; plaintext backup opt-in restricted to automated test context.
- Explicit allowlisted public HTTPS monitoring; DNS-pinned IPv4 and no redirects.
  No polling without operator configuration. GitHub read-only token scoped to allowlisted repos.
- AI provider calls are opt-in and restricted to Workspace Owner; external docs transmission
  has a separate switch. Timeout/errors are labeled **unknown after attempt**, never unsent.

## Remaining threats / NO-GO gates
1. **PostgreSQL and full normalized DAL not integrated.** Node 22 built-in SQLite is a
   transitional local adapter and the current full-snapshot UI still uses per-workspace revisions.
2. **External Vault not integrated**: approved HTTPS vault links are navigational metadata only.
   They neither validate authorization at the provider nor rotate or revoke credentials.
3. **Secret-pattern filtering is inherently incomplete**. Keys with unrecognized formats can
   be stored in any free-text field. Prior database copies/backups may retain leaked secrets.
   Credential rotation is required after a leak; redaction is not proof of erasure.
4. **Public HTTP threat testing has not passed**: browser E2E, session fixation, CSRF/IDOR,
   invite abuse, authentication rate-limit stress, XSS/CSP, account recovery workflow,
   negative permission testing and external network tests are not verified end to end.
5. **No production-grade offsite disaster recovery**. Encrypted local backup + isolated restore
   smoke are implemented, but RTO/RPO, rotation, retention, offsite copies and full staging restore
   remain untested.
6. **Email notification absent**. Telegram is opt-in and at-least-once; its real delivery has
   not been tested with a real token. Worker installation must be performed by the operator.
7. **AI and monitoring remain restricted previews**, not an evaluated model of safe project
   reasoning or an external multi-point SLO/incident management system.
8. No verified SCA/SAST report, penetration test, WCAG2.2AA audit, load test or full release rollback.

## Risk priorities
P0: PostgreSQL migration + safe/verified backup restore; full-stack auth/permission E2E;
external Vault before any real credentials; production build/test reproducibility.
P1: scheduler/stale alert end-to-end, offsite DR, rate limits and CI security scans,
monitoring and webhook tests, money accounting audit.
P2: AI RAG citation quality, project intelligence, full visual and accessibility review.

No production approval is implied by tests or static typechecking.

## Gate C integration boundaries

Vault requests use a server-configured HTTPS origin, approved KV v2 mounts and metadata paths. Redirects are rejected and normal TLS certificate verification remains enabled. Version numbers and status are the only provider-derived fields returned to the application. The Vault token requires a metadata-only policy, further constrained to the operator-approved prefix.

Notification workers authenticate as separate PostgreSQL logins. The browser reads delivery status and retry times only for alerts visible under the current project grants. It cannot read queue leases, recipient addresses or provider identifiers. Telegram project and alert labels require explicit operator opt-in for the destination group. Email content stays generic. Unknown outcomes stop automated delivery after an ambiguous request, while explicit transient failures can retry within the configured schedule. The database cannot recall a request already in flight.

## Revision 2026-11-18 — Security hardening review

This revision supersedes earlier statements claiming there is no MFA or no optional outgoing connection. TOTP and single-use recovery codes exist; Telegram, GitHub, monitoring and LLM outgoing requests are opt-in and require server-side configuration. MFA-protected existing accounts must supply a valid second factor when joining via a new invitation. Absolute session lifetime is seven days with an additional 24-hour inactivity timeout. Client input is stream-bounded at the API and manual activity uses a transactional per-user rate limit. Auto-generated alerts have worker-owned immutable identity/provenance. Database paths inside static directories or through symlinks are rejected.

**Residual risk:** Production build/browser tests are not independently confirmed, heuristic secret detection is not a vault, external integrations and offsite backup are not end-to-end verified, and there is no production-grade PostgreSQL deployment, CSP nonce policy, independent penetration test, or released ASVS compliance report. Continue treating this as private test software. See `docs/verification/SECURITY-REVIEW-2026-11-18-FA.md`.
