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
- Product Type Normalization (`normalize_type_key`): Strictly separates `x`-prefixed codes (`x637`, `x517`) from `xabib` (previously any `x` + digit was conflated to `xabib`). Only valid aliases are `one -> oneway` and `uztez -> uzt`.
- Report Card 3-Dots Menu & Kg Adjustment:
  - Each report card on `#/reports` features a 3-dots kebab menu (`.report-item__more` -> `#reportMoreSheet`).
  - **Maxsus reys nomi (Card Badge)** (`#specialReysSheet`, `POST /api/reports/{id}/special-name`): Does not create an independent report card; attaches `special_name` to the selected report and displays it as a glowing/accent badge (`.report-item__special-badge`) directly inside that card. Supports editing, comma-separated tags, and clearing the badge.
  - **Kg to'g'rilash** (`#kgFixSheet`, `POST /api/reports/{id}/adjust-kg`): Manually add or subtract weight (`+` / `-` kg, e.g. `+6` or `-2.5`) to any product type on the report. Updates `inventory` balance atomically and logs an audit record in `activity` (`action = 'kg_fix'`, `actor = identity`, `net = weight_delta`, `note`).
  - Audit Trail: In Activity logs, `kg_fix` events explicitly show the admin identity who performed the change (`Admin: {actor}`), the delta (`+` / `-`), and the reason note. Assets cache-busted with `?v=badge1`.

