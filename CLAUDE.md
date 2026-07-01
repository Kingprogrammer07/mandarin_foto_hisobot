# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Admin-only Telegram bot + Mini App (WebApp) for trip reports ("reys hisoboti").
Single Python process runs both an aiogram-3 bot (polling) and a FastAPI server
that serves the Mini App static files and the report API.

## Commands

```bash
python -m app                  # run server + bot together (entry: app/__main__.py)
pip install -r requirements.txt
```

No test suite or linter is configured yet.

## Architecture

- `app/__main__.py` — boots both halves in one event loop via
  `asyncio.gather(server.serve(), dp.start_polling(...))`. `handle_signals=False`
  on the bot so uvicorn owns signal handling.
- `app/bot.py` — aiogram Dispatcher. `IsAdmin` filter gates every handler; the
  bot only ever replies to IDs in `ADMIN_IDS`. `/start` (and any admin message)
  returns an inline button with `WebAppInfo(url=WEBAPP_URL)`.
- `app/server.py` — FastAPI. Serves `webapp/` (index at `/`, `/css`, `/js`) and
  the API. `POST /api/report` (multipart) adds `net = weight − coefficient` to a
  tovar turi's balance; `POST /api/adjust` (json) moves weight between two types
  (blocks/409 if the source is insufficient); `GET /api/inventory` and
  `GET /api/activity` (both read-only, auth via cookie or `X-Telegram-Init-Data`).
- `app/db.py` — SQLite (`data/reys.db`, gitignored, WAL). Two tables:
  `inventory` (one row per tovar turi = its running weight balance) and
  `activity` (append-only log of every reys/adjust with actor + timestamp).
  Both tabs share this store; `db.init()` runs at startup and seeds default types.
  The frontend "Faolligim" screen renders `/api/activity` (filtered to the caller).
- `app/security.py` — Telegram `initData` HMAC validation + signed browser
  sessions. The signature scheme is exact (secret_key = HMAC(key="WebAppData",
  msg=bot_token); compare against the `hash` field). Sessions are stateless HMAC
  tokens over `"<username>.<exp>"`; `verify_session` re-checks the credential
  still exists so removing it is an instant kill switch.
- `app/passwords.py` — PBKDF2-SHA256 hashing for browser login. `python -m
  app.passwords <user>` prints an `ADMIN_CREDENTIALS` line for `.env`.
- Two ways in: **Telegram** (Mini App `initData`, login-free) or **browser**
  (username/password OR a **WebAuthn passkey** → httpOnly+Secure+SameSite=Strict
  session cookie). `/api/report` accepts either; the cookie path additionally
  requires a same-origin Origin/Referer.
- `app/passkeys.py` — passkey JSON store (`data/passkeys.json`, gitignored) +
  in-memory challenge store. WebAuthn endpoints live in `server.py`
  (`/api/webauthn/{register,auth}/{begin,complete}`). Passkeys are bound to
  `WEBAUTHN_RP_ID` (the WEBAPP_URL host) — they break if the domain/tunnel URL
  changes, so a stable domain is needed for them to persist. Enrolling a passkey
  requires an existing (password) session; login with one is usernameless.
- `app/config.py` — env via `.env`. `ADMIN_IDS` is the single source of truth for
  who may use either half.
- `webapp/` — vanilla JS, **no build step** (chosen for Mini App load speed).
  `app.js` holds all state in one `state` object; the searchable type select is a
  bottom-sheet; Save sends a `FormData` POST with `tg.initData`.

## Conventions / gotchas

- Admin allow-list is enforced in **two** places — bot handlers (`IsAdmin`) and
  the API (`authenticate_admin`). Changing the rule means changing both.
- The frontend cannot use `tg.sendData()` (4 KB limit, no files) — photos go via
  `fetch` to `/api/report`, which is why initData is sent in the form body.
- `WEBAPP_URL` must be **https** or Telegram refuses to open the Mini App; for
  local dev use a tunnel (cloudflared/ngrok).
- Photos are read into memory (chunked, capped) and logged only — persistence/
  forwarding is intentionally unimplemented (pending product logic). Server-side
  caps live in `server.py`: `MAX_PHOTOS`, `MAX_PHOTO_BYTES`, `MAX_TOTAL_BYTES`;
  the client cap in `app.js` is convenience only and is not trusted.
- `require_config()` runs at startup (also via FastAPI startup event, so
  `uvicorn app.server:app` can't skip it) and `validate_init_data` fails closed
  on an empty token — don't remove either; they prevent a fail-open deploy.
- UI text is in Uzbek; keep it consistent when adding strings.
