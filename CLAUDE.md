# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

No test suite or linter is configured.

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

### Data model (`app/db.py`, SQLite `data/reys.db`, WAL, gitignored)

One serialized connection behind a `threading.Lock` — single process, low volume.

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
  <idx>`), plus the Telegram `file_id`/`message_id` once forwarded.
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
- `AGENTS.md` is a copy of this file for Codex — update both together.
