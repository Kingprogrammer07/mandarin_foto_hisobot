# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

Admin-only Telegram bot + Mini App (WebApp) for trip reports ("reys hisoboti").
Single Python process runs three things in one event loop: an aiogram-3 bot
(polling), a FastAPI server (Mini App static files + report API), and a durable
outbox worker that forwards saved entries to Telegram channels.

## Commands

```bash
python -m app                  # run server + bot + outbox (entry: app/__main__.py)
```

```bash
pip install -r requirements.txt
```

```bash
python -m app.passwords <username>   # print an ADMIN_CREDENTIALS line for .env
```

```bash
python -m pytest               # run automated test suite (tests/)
```

```bash
python -m app.storage_migrate [--dry-run]   # safely migrate local photos to Cloudflare R2
```

UI-only work can skip the bot: `.claude/launch.json` defines a `reys-preview`
config (`uvicorn app.server:app --port 8099`). It still runs `require_config()`
at startup, so `.env` must be filled even there.

## Architecture

### Process

- `app/__main__.py` — `asyncio.gather(server.serve(), dp.start_polling(...))`.
  `handle_signals=False` on the bot so uvicorn owns signal handling. Hands the
  bot to `outbox.set_bot()`; the worker itself is started by the FastAPI startup
  event, so it exists even under bare `uvicorn app.server:app` (it idles with no
  bot).
- `app/bot.py` — aiogram Dispatcher. `IsAdmin` gates every handler; `/start` (and
  any admin message) returns an inline `WebAppInfo(url=WEBAPP_URL)` button.
  Non-admins get silence.
- `app/config.py` — env via `.env`. `ADMIN_IDS` is the single source of truth for
  who may use either half. `require_config()` also rejects a non-https
  `WEBAPP_URL`.

> **MANDATORY AI AGENT RULE**: Whenever making any changes to this codebase, you MUST update `HANDOFF.md`, `AGENTS.md`, and `CLAUDE.md` in lockstep so other AI agents and developers can onboard immediately without reading the whole codebase.

### Data model (`app/db.py`, SQLite `data/reys.db`, WAL, aiosqlite, gitignored)

Completely asynchronous via `aiosqlite` with connection management behind an `asyncio.Lock` for single-writer serialization — non-blocking for FastAPI event loop.

- `reports` — named containers. `MAX_REPORTS = 25`; `create_report` hard-deletes
  the oldest beyond that (`_prune`, cascading into activity/inventory/photos/
  send_queue). `delete_report` is a **soft** delete (`deleted_at`) — the frontend
  calls it "archive".
- `inventory` — running balance per `(report_id, tovar_turi)`. Every new report
  starts every known type at 0.
- `activity` — one row per entry, `action` ∈ `reys | adjust | top | topchiqgan |
  bizda | chiqgan`. Soft-deleted (`deleted_at`), edit-stamped (`edited_at`).
- `custom_types` — user-added tovar turlari on top of `DEFAULT_TYPES`
  (soft-deleted). `DEFAULT_TYPES` is duplicated in `webapp/js/app.js` — change
  both.
- `entry_photos` — photo bytes as BLOB **and** on disk (`data/photos/<entry_id>/
  <idx>`), plus `r2_key`, `r2_url` (Cloudflare R2) and Telegram `file_id`/`message_id`
  once forwarded.
- `send_queue` — durable outbox (`pending | sent | failed`, attempts, `next_at`).
- `schema_migrations` — names of applied one-off **data** migrations.

Balance rules: `reys` adds `net = weight − coefficient`. `adjust` moves weight
between two types and raises `InsufficientStock` (→ 409) if the source is short.
**Obshiy-ves actions (`top`/`topchiqgan`/`bizda`/`chiqgan`) never touch
inventory** — they are log rows feeding the Excel exports and channel sends;
`add_obshiy` forces `coefficient = 0`, `net = weight`, and stashes any submitted
coefficient in `box_weight`.

Migrations are additive: legacy pre-report-schema `inventory`/`activity` tables
are *renamed* to `<tbl>_legacy_<ts>`, never dropped; new columns go through
`_add_column`; one-off data fixes are guarded by a row in `schema_migrations`.
Cargo/photo data must never disappear silently — keep that property.

### Storage (`app/storage.py`, `app/storage_migrate.py`)

Async S3/Cloudflare R2 integration via `aioboto3`. Uploads photos to R2 bucket
with clean hierarchical folder keys (`{action}/report_{report_id}/{entry_id}/{idx}.webp`),
e.g. `top/report_44/5915/0.webp` or `reys/report_44/5916/0.webp`.
Direct public CDN URLs are stored if `R2_PUBLIC_URL` is configured.
If direct CDN is used, standard R2 CORS (`GET`/`HEAD`) should be allowed on the bucket.
**Transparent local fallback**: If `R2_*` credentials are empty or unconfigured,
automatically falls back to storing photos on local disk (`data/photos/<entry_id>/<idx>`).
**Zero Data Loss Migration**: `python -m app.storage_migrate` verifies every upload
via R2 `head_object` before updating SQLite, preserving local copies and BLOBs.

### Task Queue & Outbox (`app/queue.py`, `app/outbox.py`)

Telegram sends are enqueued in SQLite `send_queue` and dispatched via `queue.dispatch_send()`.
- If `REDIS_URL` is set, dispatches tasks through `arq` / Redis.
- If Redis is unconfigured or unreachable, transparently falls back to the in-process
  `asyncio` outbox worker (`outbox.notify()`).

### API (`app/server.py`)

Serves `webapp/` (`/` → index, `/css`, `/js`) plus:

- Auth — `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`,
  `POST /api/webauthn/{register,auth}/{begin,complete}`.
- Reports — `GET|POST /api/reports`, `DELETE /api/reports/{id}`,
  `POST /api/reports/{id}/zero-top-coefficients`.
- Types — `GET|POST /api/types`, `DELETE /api/types/{name}`.
- Entries (all multipart, all return `entry_id`, all `report_id`-scoped) —
  `POST|PUT /api/report`, `POST|PUT /api/adjust`, `POST|PUT /api/obshiy`,
  `DELETE /api/entry/{id}?report_id=`. Edits compensate the inventory delta
  atomically in `db.py` and 409 if a balance would go negative.
- Reads — `GET /api/entries`, `/api/entries/status`, `/api/inventory`,
  `/api/activity`, `/api/entry/{id}/photo/{idx}`, `/healthz`.
- Excel — `GET /api/export/{kargo,obshiy,summary}` (streamed `.xlsx`).
- Sending — `POST /api/send-bulk` (`mode: unsent|sent`, or an explicit
  `entry_ids` list) enqueues into `send_queue` and pokes `outbox.notify()`.

Cross-cutting: a body-size middleware rejects oversized uploads before FastAPI
spools them; `_rate_ok` is a fixed-window per-IP limiter; `_client_ip` honors
forwarding headers only from `TRUSTED_PROXIES` or a loopback peer.

### Auth (`app/security.py`, `app/passkeys.py`, `app/passwords.py`)

Two ways in: **Telegram** (Mini App `initData`, login-free) or **browser**
(username/password OR a **WebAuthn passkey** → httpOnly+Secure+SameSite=Strict
cookie). State-changing endpoints accept either; the cookie path additionally
requires a same-origin Origin/Referer (CSRF).

- initData signature scheme is exact: `secret_key = HMAC(key="WebAppData",
  msg=bot_token)`, compared against the `hash` field.
- Sessions are stateless HMAC tokens over `"<username>.<exp>"`; `verify_session`
  re-checks the credential still exists, so deleting an `ADMIN_CREDENTIALS` line
  is an instant kill switch.
- Passkeys live in `data/passkeys.json` (gitignored) and are bound to
  `WEBAUTHN_RP_ID` (the `WEBAPP_URL` host) — a new tunnel URL invalidates them.
  Enrolling needs an existing password session; login with one is usernameless.

### Outbox (`app/outbox.py`)

Single background worker drains `send_queue`: builds an Uzbek caption, sends
photos (`send_photo` / `send_media_group`) to the channel that
`config.channel_for_action(action)` maps the entry's action to, then records the
returned Telegram `file_id`s. Retries forever with a fixed backoff ladder
(honoring `retry_after` on flood waits). Pending sends survive restarts. A
missing channel id for an action raises → the job just keeps retrying.

### Excel (`app/excel_export.py`)

`build_kargo_excel` / `build_obshiy_excel` / `build_umumiy_excel` fill the
openpyxl templates in `assets/` (`shablon.xlsx`, `obshiy_ves_shablon.xlsx`,
`umumiy_hisobot_shabloni.xlsx`; a `BASE_DIR` copy is accepted as a legacy
fallback). Cells are written as **live formulas** (`=12.5-0.94+3`) whenever an
entry carries a coefficient or a later adjust touched it, so the sheet shows the
arithmetic, not just the total. Filenames embed the report name and are
sanitized for Windows.

### Frontend (`webapp/`)

Vanilla JS, **no build step** (chosen for Mini App load speed). One `state`
object in `app.js`; hash routing (`#/report/<id>/obshiy/<section>`) drives a
stack of full-screen `.screen` overlays — home → report menu → Obshiy ves /
Kargolarga tarqatish → shared form → entries viewer. `body.locked` must stay set
while *any* overlay is open (`syncLock()`), or iOS rubber-bands behind it.
The four Obshiy-ves sections share one photo+code+weight form (`SECTIONS`).
Saving is a `FormData` POST carrying `tg.initData`.

## Conventions / gotchas

- Admin allow-list is enforced in **two** places — bot handlers (`IsAdmin`) and
  the API (`authenticate_admin`). Changing the rule means changing both.
- The frontend cannot use `tg.sendData()` (4 KB limit, no files) — photos go via
  `fetch`, which is why initData travels in the form body (or the
  `X-Telegram-Init-Data` header on GETs).
- `WEBAPP_URL` must be **https** or Telegram refuses to open the Mini App; for
  local dev use a tunnel (cloudflared/ngrok).
- Upload caps are server-side in `server.py`: `MAX_PHOTOS`, `MAX_PHOTO_BYTES`,
  `MAX_TOTAL_BYTES`, `MAX_BODY_BYTES`. The `app.js` cap is convenience only and
  is not trusted.
- `require_config()` runs at startup (also via the FastAPI startup event, so
  `uvicorn app.server:app` can't skip it) and `validate_init_data` fails closed
  on an empty token — don't remove either; they prevent a fail-open deploy.
- Numeric input from the client is checked with `math.isfinite` before it reaches
  the DB, and `init()` self-heals any pre-guard inf/nan rows. Keep new numeric
  paths guarded.
- UI text and API error `detail` strings are in Uzbek; keep it consistent.
- `CLAUDE.md` and `HANDOFF.md` document this codebase — whenever making changes to the codebase, **all three files (`HANDOFF.md`, `AGENTS.md`, `CLAUDE.md`) must be kept up to date**.
- Photos use Cloudflare R2 / S3 storage (`app/storage.py`) with automatic graceful fallback to local disk (`data/photos`).
- Database access is asynchronous via `aiosqlite` in `app/db.py`.
- Background sending supports Redis + `arq` with fallback to SQLite `send_queue`.
- All images are automatically converted to high-fidelity WebP (quality 95) on both client (`webapp/js/app.js` via canvas) and server (`app/images.py` via Pillow + `pillow_heif` supporting HEIC/HEIF/JPEG/PNG/WEBP), saving 70-85% storage and mobile bandwidth.
- Outbox Diagnostics sheet (`#outboxSheet`) has `z-index: 100` (`#outboxBackdrop` `z-index: 99`) and `touch-action: pan-y` ensuring it opens smoothly above `.screen` overlays on iOS & Android.
- Unobtrusive Floating Status Bar (`#outboxPillWrap` with `pointer-events: none` on container) provides real-time network and pending queue status (`⚡ Oflayn`, `🔄 Yuklanmoqda`, `⏳ Navbatda`) with interactive inspection of pending items and photo thumbnails.
- Entries Viewer (`#entriesScreen`) across all 6 sections (`reys`, `adjust`, `top`, `bizda`, `chiqgan`, `topchiqgan`) includes instant real-time search (by code, type, transfer, weight), flexible date presets and custom ranges, 5-way sorting, channel send status & tovar filters, and live count/weight summary bar.
- Mobile-First Design System (`webapp/css/styles.css`):
  - Brand Palette: Electric Blue (`#2457ff`) as primary action color, Neon Volt (`#c8ff3d`) for active badges, glowing banners, and focus rings, paired with Deep OLED Obsidian (`#090b10` / `#11141d`) in dark mode and crisp high-contrast light mode.
  - Ergonomics: Minimum 48-52px touch targets, safe-area inset adaptation for notch/Dynamic Island and Android navigation bars, tactile `:active` spring feedback (`scale(0.97)`).
  - Hero Weight Inputs (`#weight`, `#adjWeight`, `#topWeight`): 28px bold tabular typography with embedded uppercase `kg` badge and quick-save action pill.
  - Fast Mode Indicator (`.fast-mode-banner`): Glowing Neon Volt banner indicating automatic camera re-opening after save, clickable to toggle state instantly.
- iOS & Offline Photo Stability: Photos in IndexedDB outbox use safe Blob slices (`file.slice`) with explicit metadata to avoid WebKit `DataCloneError`; camera uses WebP -> JPEG fallback; online saves use optimistic direct upload; server 422 errors are sanitized via `formatApiError` and unified `RequestValidationError` handler so `[object Object]` never appears.
- Reports Capacity & Management: MAX_REPORTS = 200 (env configurable via MAX_REPORTS); report renaming via PATCH /api/reports/{id} and frontend edit modal; instant real-time live search filter (#homeSearchInput) across all reports on home screen.
- Cross-Report Filter & Excel Export: Multi-report product filter (#homeFilterBtn & #reportsFilterSheet) on home screen allowing multi-selecting reports, choosing product type (e.g. akb, mandarin), and downloading structured, lightweight Excel with 4 core columns (Reys nomi, Og'irligi, Qo'shiladigan karobka og'irligi, Jami =B+C) and automatic JAMI =SUM(...) summary row. API: POST/GET /api/export/filtered. Photos are intentionally kept out of the Excel sheet to keep it fast and clean. If product type is `top` (or `bizda`), weight is automatically derived from the "bizda qoladigan" sheet total (`bizda_total`) from Obshiy ves, and photo/entry forwarding targets `action in ('bizda', 'top')`.
- Filtered Photos Telegram Forwarding & Channel Memory: Instead of embedding photos in Excel, matching entries (photos + captions in the style of "Kargolarga tarqatish": `{report_name} - {tovar_turi}\n\n{weight} - {coef} = {net} kg`) are dispatched directly to a user-specified Telegram channel via dedicated background sender (`outbox.send_filtered_to_channel`) and `POST /api/send-filtered`. The channel ID / @username is persisted in client `localStorage` and server `app_settings` SQLite table (served via `GET /api/reports`) for seamless memory across devices and sessions. Early validation checks bot chat access (`_bot.get_chat(chat)`) before scheduling background delivery. Assets cache-busted with `?v=tgchannel1`.
- Product Type Normalization (`normalize_type_key` & `normalize_telegram_type_key`): In general trip reports (`Umumiy hisobot`, Word DOCX summary), `x`-prefixed codes (`x637`, `x517`, `x657`, etc.) summarize on Row 7 (`xabib`). In Multi-Report Filter and Excel Export (`#reportsFilterSheet`, `POST /api/export/filtered`) AND Telegram forwarding (`POST /api/send-filtered`), `x`-codes (`x637`, `x517`, `x657`, etc.) and pure `xabib` are strictly separated so downloading or forwarding `x657`, `x637`, or `x517` never mixes in `xabib` or other `x`-codes. Only valid general aliases are `one -> oneway` and `uztez -> uzt`.
- Report Card 3-Dots Menu & Kg Adjustment:
  - Each report card on `#/reports` features a 3-dots kebab menu (`.report-item__more` -> `#reportMoreSheet`).
  - **Maxsus reys nomi (Card Badge & Umumiy hisobot Excel)** (`#specialReysSheet`, `POST /api/reports/{id}/special-name`): Does not create an independent report card; attaches `special_name` to the selected report and displays it as a high-contrast warm amber/gold VIP badge (`.report-item__special-badge`) with dark bronze text in light mode and radiant gold in dark mode directly inside that card. Supports editing, comma-separated tags, and clearing the badge. In Umumiy hisobot Excel (`build_umumiy_excel`), cell `B2` (previously static template text `M174`) is dynamically populated with this `special_name`.
  - **Kg to'g'rilash (E ustuni - To'lanishi kerak bo'lgan summa)** (`#kgFixSheet`, `POST /api/reports/{id}/adjust-kg`): Manually add or subtract weight (`+` / `-` kg, e.g. `+6` or `-2.5`) to any product type on the report. Does NOT tamper with raw warehouse inventory in Column C or box weight in Column D; instead applies directly to **Column E ("To'lashi kerak bo'lgan summa")** via live formula (`=C{row}+D{row}+{delta}`) in Umumiy hisobot Excel (`build_umumiy_excel`) and logs an audit record in `activity` (`action = 'kg_fix'`, `actor = identity`, `net = weight_delta`, `note`).
  - Audit Trail: In Activity logs, `kg_fix` events explicitly show the admin identity who performed the change (`Admin: {actor}`), the delta (`+` / `-`), and the reason note.
- **Word DOCX hisoboti va Maxsus reys filtri** (`#reportsFilterSheet`, `GET /api/export/docx`, `app/excel_export.py:build_special_docx`):
  - **Avtomatik DOCX yuklash**: Maxsus reys nomi (`special_name`) biriktirilgan reyslarda Umumiy hisobot Excel yuklab olinganda (`downloadSummaryExcel`) avtomatik ravishda Word (`.docx`) hujjati ham birga yuklab beriladi. Shuningdek 3 nuqta (kebab) menyusida `#reportMoreDocxBtn` orqali faqat DOCX ni ham yuklab olish mumkin.
  - **Hujjat strukturasi**:
    - 1-qator: `AVIA {special_name} ({report_name}) UCHUN OPSHI VES: {total_ves:.2f} KG. {date}` (`date` - birinchi yozuv boshlangan vaqt `MIN(ts)`, `total_ves` = Obshiy ves `top` worksheet D ustun jami + `bizda qoladigan` worksheet D ustun jami).
    - 2-qator: `TOP CARGO {special_name} ({report_name}) - {top_total:.2f} KG. {date}` (`top` worksheet jami).
    - 3-qator: `Avia {special_name} ({report_name})  - {bizda_total:.2f} KG. {date}` (`bizda qoladigan` worksheet jami).
    - 4-qator: `(O'zimizga qolgan.)`.
    - 5-qator+: Umumiy hisobot E ustunidagi og'irliklar ("To'lashi kerak bo'lgan summa:"): `{CARGO_NOMI} ({special_name}) - {total:.2f} KG` (`mandarin`, `akb`, `jet`, `xabib` va barcha kargolar bo'yicha karobka taqsimoti va kg_fix qo'shilgan yakuniy to'lov og'irligi).
  - **Filtr va Qidiruv**: Asosiy qidiruv maydoni (`#homeSearchInput`) reys nomi hamda maxsus reys nomi bo'yicha qidiradi. Ko'p reysli filtr oynasida (`#reportsFilterSheet`) har bir reys yonida maxsus reys badge ko'rsatiladi, `#filterReportsSearch` orqali real vaqtda qidirish va `#filterSpecialOnlyReports` tugmasi bilan faqat maxsus reyslarni bir zumda belgilash imkoniyati qo'shilgan. Assets cache-busted with `?v=specialdocx1`.
- **Dinamik Koeffitsient va Karobka Og'irligi Presets ('+' tugmasi va boshqaruv)**:
  - Kargolarga tarqatish (`#coefChips`) va Obshiy ves (`#topCoefChips`) bo'limlarida yangi qiymatlarni kiritish uchun interaktiv `+` tugmasi (`.chip--add`) hamda Kargolarga tarqatish "Ayirilmasin" ochiluvchi menyusida (`#coefBoxMenu`) `+ Yangi karobka og'irligi` elementi qo'shildi.
  - Yangi Bottom Sheet (`#presetSheet`): Foydalanuvchi yangi qiymat kiritganda (`inputmode="decimal"`), u `localStorage` ga saqlanadi (`reys_coef_presets` va `reys_box_presets`), chiplar dinamik ravishda qayta chiziladi va yangi kiritilgan qiymat darhol tanlanadi.
  - Shaxsiy qiymatlarni o'chirish: Sheet ichida mavjud qiymatlar ko'rinadi va foydalanuvchi qo'shgan shaxsiy qiymatlar yonidagi `×` tugmasi orqali istalgan payt osongina o'chirib tashlanishi mumkin.
  - Default qiymatlar: Koeffitsientlar uchun `[0.94, 1.22, 1.4, 1.05]`, Karobka og'irliklari uchun `[1, 1.22, 1.4, 1.05]`. Assets cache-busted with `?v=presets1`.
- **Barcha Tovar Turlarini Uppercase Qilish (`schema_migrations: uppercase_all_tovar_turi_20261009`)**:
  - Ma'lumotlar bazasida (`data/reys.db`) barcha tovar turlari (`inventory.tovar_turi`, `activity.tovar_turi`, `activity.from_type`, `activity.to_type`, `custom_types.name`) to'liq UPPERCASE (`AKB`, `TRITON`, `IZI`, `NAVO`, `XABIB`, `JET`, `JON`, `TOP`, `UZTEZ`, `MANDARIN`, `ONEWAY`, `X637`, `X517`, `REDWING`, `MEBEL`, `XON CARGO`, `MUSR`) ga o'tkazildi.
  - `_clean_type(name)` endi har doim `.strip().upper()` qaytaradi, `DEFAULT_TYPES` hamda frontend `DEFAULT_TYPES` to'liq bosh harflarda sinxronlashtirildi.
  - Zero data loss: `inventory` va `custom_types` dagi duplikatlar birlashtirildi, barcha og'irlik va audit qaydlari 100% saqlandi.
- **XON CARGO To'g'rilash va Umumiy Hisobot Excel Custom Kargolari (`M296 UMUMIY HISOBOT.xlsx` standarti)**:
  - **Baza Tozalash (`schema_migrations: rename_xon_carogo_and_clean_types_20261009`)**:
    - `XON CAROGO` dagi imlo xatosi barcha jadvallarda (`custom_types`, `inventory`, `activity`) to'liq **`XON CARGO`** ga o'zgartirildi. Agar bir xil reysda ikkala tur bo'lsa, og'irliklari birlashtirildi (`SUM(weight)`).
    - `custom_types` jadvalidan `DEFAULT_TYPES` da mavjud bo'lgan takroriy standart turlar olib tashlandi.
    - `_clean_type` va `normalize_type_key` funksiyalarida `xon carogo` -> `XON CARGO` / `xon cargo` xavfsiz avto-almashtiruvi joriy etildi.
  - **Umumiy hisobot Excel Formulalari (`app/excel_export.py:build_umumiy_excel`)**:
    - Taqsimlanmaydigan kargolar faqat va faqat: `NON_DISTRIBUTED_LABELS = {"izi", "triton", "top"}`.
    - Foydalanuvchi qo'shgan barcha yangi tovar turlari (`XON CARGO`, `MEBEL`, `X213` va h.k.) avtomatik ravishda **taqsimlanuvchi** deb olinadi:
      - 16+ qatorlarda D ustuniga `=C{row}*$H$3` (karobka og'irligi) va E ustuniga `=C{row}+D{row}` yoziladi.
      - Mandarin (C4) formulasidan ayirib tashlanadi (`=G3 - C5 - C6 - ... - C{row}`).
      - Toza yuk (G3) formulasida esa sof yukdan ayrilmaydi (faqat izi, triton, top va C3 karobka ayriladi).
    - `calculate_report_metrics` va Word DOCX hisobotida (`build_special_docx`) ham barcha yangi kargolar taqsimlangan karobka og'irligi bilan to'liq hisob-kitobga kiritildi.
- **Filtr va Excel Eksport Oynasida Reys Yaratilgan Vaqti va Sana Qidiruvi (`#reportsFilterSheet`)**:
  - Ko'p reysli filtr oynasida har bir reys nomi yoniga yaratilgan sanasi va vaqti (`fmtTs(rep.created_at)` $\rightarrow$ `DD.MM.YYYY HH:MM`) ixcham badge (`.filter-report-checkbox__time`) sifatida joylashtirildi.
  - Flex konteyner (`.filter-report-checkbox__info`) orqali keng ekranlarda nom, maxsus badge va vaqt bir qatorda turadi, tor mobil ekranlarda esa vaqt ravon tarzda pastga tushadi.
  - `#filterReportsSearch` qidiruv maydoni reys nomi va maxsus nomdan tashqari sana/vaqt (`dataset.time`) bo'yicha ham real vaqtda filtrlaydi. Aktivlar `?v=filterdate1` bilan cache-bust qilindi.
- **Tezkor Rejimda (Fast Mode) Qiymatlarni Eslab Qolish va Reyslar Sahifasida Refresh Tugmasi**:
  - **Obshiy ves**: `Fast Mode` (`topFast`) yoki `remember` yoniq bo'lganda, `resetTop(false)` orqali har safar saqlangandan keyin tanlangan karobka og'irligi (`topCoef`, faol chip va custom qiymat) o'chib ketmasdan keyingi yozuvlar uchun avtomatik saqlanib qoladi.
  - **Kargolarga tarqatish**: `Fast Mode` (`reysFast`) yoki `remember` yoniq bo'lganda, `resetForm(false)` orqali tanlangan tovar turi hamda koeffitsient (`Ayirilmasin` karobka og'irligi yoki 0.94, 1.22 chiplari) keyingi yozuvlar uchun eslab qolinadi.
  - **Reyslar sahifasi (#/reports) Refresh tugmasi**: `homeScreen` navbarida (`.screen__top-actions`) mavzu tugmasi yoniga `#homeRefreshBtn` (Material Design reload) qo'shildi — bosilganda tebranish (haptic), 360° aylanuvchi animatsiya (`.is-spinning`) va sahifani to'liq qayta yuklash (`window.location.reload()`) ishlaydi. Aktivlar `?v=fastmode1` bilan cache-bust qilindi.
- **Maxsus Reys Hisobot Matnlarini Alohida Qatorlar Bo'yicha Nusxalash Modali va Yakuniy Nuqta Standarti (`#specialTextSheet`, `GET /api/reports/{id}/special-text`)**:
  - **Alohida Nusxalash Modali**: Maxsus reys nomi biriktirilgan reyslarda Word (.docx) hisobotidagi har bir matn qatori alohida nusxalash tugmasi bilan `#specialTextSheet` bottom sheet oynasida taqdim etiladi. Oyna 3 nuqta (kebab) menyusidagi `#reportMoreTextBtn` yoki reys kartasidagi oltin maxsus nom badge (`.report-item__special-badge`) bosilganda ochiladi.
  - **Yakuniy Nuqta Qoidasi**: `(O'zimizga qolgan.)` qatoridan pastdagi barcha kargo ma'lumotlari (`MANDARIN (M219) - 179.83 KG.` va boshqalar) oxirida qat'iy nuqta (`.`) qo'yiladi. Ushbu qoida DOCX hujjati (`build_special_docx`) hamda API/modal oynada (`get_special_docx_lines`) yagona standart asosida bir xil ishlaydi.
  - **Toolbar & Qulayliklar**: Barcha qatorlarni bir bosishda nusxalash (`#specialTextCopyAllBtn`), to'g'ridan-to'g'ri Word DOCX yuklab olish (`#specialTextDownloadDocxBtn`), iOS WebApp uchun xavfsiz clipboard fallback va nusxalashda haptic + checkmark animatsiyasi mavjud. Aktivlar `?v=specialtext1` bilan cache-bust qilindi.
- **Kargolarga Tarqatishda Yangi "Ombor Holati" Tabi, Karobkalar Soni va Vertikal Karta Dizayni (`#panel-stock`, `GET /api/inventory`)**:
  - **Yangi 3-Tab**: Kargolarga tarqatish oynasida "Reys hisoboti" va "Adashgan yuklar" yoniga uchinchi mustaqil tab sifatida **"Ombor holati"** (`data-tab="stock"`, `#panel-stock`) qo'shildi.
  - **Adashgan Yuklardan Ko'chirish**: Ilgari "Adashgan yuklar" pastida turgan ombor qoldig'i to'liq ushbu yangi tabga ko'chirildi, bu esa transfer formasini ixcham va qulay qildi.
  - **Karobkalar Soni (Har bir tovar turi bo'yicha)**: Har bir tovar turi uchun nafaqat jami sof og'irlik (`kg`), balki ushbu reys bo'yicha nechtadan karobka yuk borligi aniq ko'rsatiladi (masalan: `4 ta karobka`, `0 ta karobka`). Backendda `db.get_box_counts` va `/api/inventory` orqali dinamik hisoblanadi.
  - **Dashboard & Qidiruv**: Tab yuqorisida umumiy xulosa kartalari (Jami og'irlik, Jami karobkalar, Mavjud tovarlar soni), real vaqtda tovar nomini qidirish maydoni (`#stockSearchInput`) hamda kartani bosganda ushbu tovarning yozuvlariga tezkor o'tish imkoniyati yaratildi.
  - **Vertikal Karta Qatlamlari va Grid Fix**: Tor ekranlarda kartalar bir-birining ustiga chiqib ketishi (collision/overflow) butunlay bartaraf etildi. Karta ichi 3 pog'onali toza vertikal qatlamga o'tkazildi: 1-qator tovar nomi (`.bal-cell__name`), 2-qator 20px qalin og'irlik (`.bal-cell__val`), 3-qator pastda `fit-content` pill badge (`.bal-cell__boxes`). Grid ustunlari kengaytirildi (`minmax(150px, 1fr)` va mobilda `minmax(130px, 1fr)`). Aktivlar `?v=ombor2` bilan cache-bust qilindi.
- **Bosh Sahifada Fon Sozlamalari (Settings) va 1 Daqiqagacha Video Fon (Loop) (`#homeSettingsBtn`, `#bgSettingsSheet`)**:
  - **Sozlamalar Tugmasi**: Bosh sahifa navbarida `#homeRefreshBtn` (Reload) yoniga zamonaviy ⚙️ Sozlamalar / Fon tugmasi (`#homeSettingsBtn`) joylashtirildi. Bosilganda pastdan qulay `#bgSettingsSheet` bottom sheet ochiladi.
  - **Video Fon (Max 1 daqiqa, Loop)**: Foydalanuvchi qurilmasidan 1 daqiqa (60 soniya) gacha bo'lgan ixtiyoriy video yuklashi mumkin. Davomiyligi `tempVideo.duration <= 60.5s` bilan brauzerda avtomatik tekshiriladi, xatolikda aniq o'zbekcha bildirishnoma beriladi. Video uzluksiz to'xtovsiz aylanadi (`loop`), ovozsiz (`muted playsinline`), sahifa ochilganda avtomatik o'ynaydi (`autoplay`) va mobil brauzerlarda to'xtab qolmasligi uchun zaxira `onended` qayta o'ynash hodisasi bilan ta'minlangan.
  - **Rasm Fon (Wallpaper) va Asl Holatga Qaytarish**: Video o'rniga rasm ham yuklash mumkin, shuningdek istalgan paytda "Standart fonga qaytarish" tugmasi orqali ilovaning asl mavzusiga qaytish mumkin.
  - **Lokal Xotira (IndexedDB - `reys-bg-store`)**: Video va rasm to'g'ridan-to'g'ri brauzerning IndexedDB xotirasida Blob ko'rinishida saqlanadi. Bu serverga ortiqcha yuklama bermaydi, internet trafigi ketmaydi va 0ms tezlikda (hatto oflayn bo'lsa ham) ishga tushadi.
  - **Glassmorphism Dizayn & O'qilish Standarti**: Fon faol bo'lganda (`body.has-custom-bg`) barcha ekranlar va kartalar yarim shaffof shisha (`backdrop-filter: blur(14px)`) uslubiga moslashadi. Sozlamalar oynasida Qoraytirish (Dimming: 10% - 85%) va Xiralashtirish (Blur: 0px - 20px) slayderlari yordamida har qanday fonda ham barcha matnlar va hisobotlar 100% tiniq o'qilishi ta'minlangan.
  - **Qatlamlar va Ekranlar Bir-biriga Chizilib Qolishini Bartaraf Etish (Layer Isolation Fix)**:
    - `body:not(.work-open) .topbar, body:not(.work-open) .content { display: none !important; }`: Foydalanuvchi hisobotlar ro'yxatida (`#/reports`) yoki reys menyusida (`#/report/:id/menu`) bo'lganda, orqa fondagi kargo ishlash bo'limi (Reys/Adashgan/Ombor tablari, rasm oynalari va kiritish formalari) butunlay renderdan olib tashlandi, natijada kartalar va tugmalar bir-birining ustiga tushib ketishi 100% yo'qotildi.
    - `.app-bg-wrap` ga `z-index: -1 !important;` berilib, orqa fon videosi/surati qat'iy ravishda butun interfeys orqasida joylashtirildi.
    - `#entriesScreen` va `#activityScreen` ga `color-mix(in srgb, var(--bg) 88%, transparent)` va `backdrop-filter: blur(24px)` berilib, ichki oynalar ostidagi qatlamlar chiroyli tarzda to'sildi. Aktivlar `?v=custombg2` bilan cache-bust qilindi.
- **Yuklanganlar (Entries Viewer) 0.1 Soniyada Tezkor Ochilish va Lazy-Loading Sahifalash (`#entriesScreen`)**:
  - **Instant Load (0.1 soniya)**: 136+ yozuvli reyslarda (masalan, M305–M306) bloklovchi 200+ rasm yuklash olib tashlandi; `loadEntries` ma'lumotlarni o'qishi bilan darhol `state.entries[kind]` ga o'tkazib kartochkalarni 0.1 soniyada chizadi.
  - **To'liq Qidiruv va Filtr**: Barcha 136+ ta yozuv to'liq xotirada saqlangani uchun qidiruv va filtrlar (kod, tovar turi, sana, jo'natish holati, rasmli yozuvlar) **barcha sahifalar bo'yicha** bir zumda (<1ms) ishlaydi va filtrlangan yozuvlarni sahifalab beradi.
  - **Lazy Thumbnails & Direct URL**: 1-sahifadagi 15 ta kartochka rasmlari to'g'ridan-to'g'ri `/api/entry/{id}/photo/{idx}?init_data=...` orqali `loading="lazy"` bilan yuklanadi, HTTP keshlashdan foydalanadi va `.entry-thumb.is-loading` animatsiyasi bilan silliq ko'rinadi.
  - **On-Demand Edit & Lightbox**: Tahrirlash bosilganda faqat o'sha 1 ta yozuvning rasmlari yuklanadi; Lightbox to'g'ridan-to'g'ri rasm manzilida ishlaydi. Sahifa almashganda avtomatik ravishda tepaga scroll qilinadi. Aktivlar `?v=fastentries1` bilan cache-bust qilindi.
- **Bosh Sahifada (#/reports) Arxivni Oyma-oy Papkalar (Monthly Folders) Bo'yicha Tashkil Qilish va Kartochka Tugmalari Fiksi**:
  - **Oylar Bo'yicha Guruhlash**: Arxivdagi hisobotlar `created_at` sanasi bo'yicha `groupReportsByYearMonth` yordamida yangidan eskiga qarab yil va oyma-oy papkalarga (📁 **Sentabr 2026**, 📁 **Avgust 2026** va h.k.) ajratiladi.
  - **To'liq Enli Vertikal Papkalar (Full-Width Accordion)**: `.archive-folders-list` mustaqil `flex-direction: column` qilinib, papkalar hech qachon 2 ustunli gridga bo'linib ketmaydi; har bir papka 100% to'liq enni egallaydi. Papka ochilganda ichidagi reys kartochkalari (`.report-list--archive-month`) planshet/kompyuterda to'liq konteyner bo'ylab 2 ustunli keng kartalar bo'lib chiqadi.
  - **Tugmalar Ustma-ust Tushishini Bartaraf Etish**: `.report-item__actions` ga `flex-wrap: wrap` va `report-item__edit, .report-item__xls, .report-item__del` tugmalariga `min-width: max-content`, `flex-shrink: 0`, `white-space: nowrap` berildi, `.report-item__del` ga `margin-left: auto` qo'shildi. Natijada tor ekranlarda ham "Nom", "Excel", "O'chirish" yozuvlari bir-birining ustiga chiqib ketmaydi.
  - **Xotira, Qidiruv va Silliq Yopilish (Accordion Collapse Fix)**: Ilgari barcha papkalar yopilganda `size === 0` sharti tufayli oxirgi oy avtomatik qayta ochilib qolib, folderni yopib bo'lmas edi. Endi `openArchiveMonthsInitialized` orqali foydalanuvchining papkani yopishi (`willOpen = false`) to'liq hurmat qilinadi va DOM da in-place silliq yopiladi/ochiladi. Qidiruvda oy nomi yozilsa ham bir zumda topiladi. Aktivlar `?v=archivefolders3` bilan cache-bust qilindi.
