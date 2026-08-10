# Reys hisoboti — Telegram Mini App

Admin-only Telegram bot + Mini App (WebApp) for trip reports.

- **Bot** (`aiogram 3`) — responds only to user IDs in `ADMIN_IDS`, opens the Mini App.
- **Server** (`FastAPI`) — serves the Mini App, the report API, and the Excel exports.
- **Outbox** — background worker that forwards saved entries (photos + caption) to
  the configured Telegram channels, with retry across restarts.
- **Frontend** — vanilla HTML/CSS/JS (no build step), mobile-first, Telegram-themed.

All three run in one Python process.

## Setup

```bash
python -m venv .venv
```

```bash
.venv\Scripts\activate
```

(`source .venv/bin/activate` on Linux/macOS)

```bash
pip install -r requirements.txt
```

```bash
copy .env.example .env
```

Required in `.env`:

| Variable | Meaning |
| --- | --- |
| `BOT_TOKEN` | from @BotFather |
| `ADMIN_IDS` | comma-separated Telegram user IDs |
| `WEBAPP_URL` | public **https** url of the Mini App (Telegram requires https) |

Optional: `ADMIN_CREDENTIALS` (browser login), the five
`BOT_*_CHANNEL_ID` values (channel forwarding — empty disables it), `HOST`/`PORT`,
`TRUSTED_PROXIES`, `INITDATA_MAX_AGE`, `SESSION_TTL`. See `.env.example`.

Browser login accounts are generated one at a time:

```bash
python -m app.passwords <username>
```

Paste the printed `user:pbkdf2_sha256$…` line into `ADMIN_CREDENTIALS`.

## Run

```bash
python -m app
```

Server + bot polling + outbox worker, one process.

### Local development

Telegram only opens Mini Apps over HTTPS. For local testing, expose the server
with a tunnel and put that url in `WEBAPP_URL`:

```bash
cloudflared tunnel --url http://localhost:8080
```

You can also open `http://localhost:8080/` directly in a browser and sign in with
an `ADMIN_CREDENTIALS` account (or a passkey enrolled from an existing session).
Note that passkeys are bound to the `WEBAPP_URL` host, so they stop working when
a throwaway tunnel url changes.

## Data

Everything lives under `data/` (gitignored): `reys.db` (SQLite), `photos/`
(uploaded photos, also mirrored as blobs in the DB), `passkeys.json`.
Excel templates live in `assets/`.

## What the app does

The home screen lists **reports** — named containers, newest 25 kept. Opening one
gives two sections:

**Obshiy ves** — four subsections (`Top`, `Topdan chiqgan`, `Bizda qoladigan`,
`Bizdan chiqgan`) sharing one form: photos + karobka kodi + weight. These rows are
recorded and exported but do not move the inventory balance.

**Kargolarga tarqatish** — two tabs:

- *Reys hisoboti* — up to 10 photos, searchable tovar turi (custom types can be
  added), coefficient (`Ayirilmasin`, fixed chips, or a custom number), weight.
  Saving adds `weight − coefficient` to that type's balance.
- *Adashgan yuklar* — moves weight from one type to another; rejected if the
  source balance is short.

Saved rows are listed under **Yuklanganlar** (editable, deletable, re-sendable to
the channel), and **Faolligim** shows a per-report, date-filtered activity log.
Each section has an Excel export; the home screen exports the per-report summary.

## Security

Every state-changing API call must carry either valid Telegram `initData`
(HMAC-SHA256 against `BOT_TOKEN`, user checked against `ADMIN_IDS`) or a signed
session cookie from browser login — cookie requests additionally require a
same-origin `Origin`/`Referer`. See `app/security.py`.
