# Reys hisoboti — Telegram Mini App

Admin-only Telegram bot + Mini App (WebApp) for filling out trip reports.

- **Bot** (`aiogram 3`) — responds only to user IDs in `ADMIN_IDS`, opens the Mini App.
- **Server** (`FastAPI`) — serves the Mini App and the `/api/report` endpoint.
- **Frontend** — vanilla HTML/CSS/JS (no build step), mobile-first, Telegram-themed.

## Setup

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows  (source .venv/bin/activate on *nix)
pip install -r requirements.txt
copy .env.example .env         # then edit values
```

Fill `.env`:
- `BOT_TOKEN` — from @BotFather
- `ADMIN_IDS` — comma-separated Telegram user IDs
- `WEBAPP_URL` — public **https** url of the Mini App (Telegram requires https)

## Run

```bash
python -m app
```

Runs the FastAPI server and the bot polling in one process.

### Local development

Telegram only opens Mini Apps over HTTPS. For local testing, expose the
server with a tunnel and put that url in `WEBAPP_URL`:

```bash
cloudflared tunnel --url http://localhost:8080
# or: ngrok http 8080
```

You can also open `http://localhost:8080/` directly in a browser — outside
Telegram a fallback **Saqlash** button appears (initData will be empty, so the
API rejects it; useful for UI work only).

## Form (tab 1 — Reys hisoboti)

- Up to 10 photos (gallery + camera) with previews
- Searchable type select (default `akb`; custom types via the pencil / search)
- Coefficient: `Ayirilmasin` (=0), `0.94`, `1.22`, or a custom number
- Weight (kg)
- Save → `POST /api/report` (multipart) with Telegram `initData`

Tab 2 (`Adashgan tovarlar`) is a placeholder.

## Security

Every `/api/report` call must carry valid Telegram `initData`; the server
verifies the HMAC-SHA256 signature against `BOT_TOKEN` and checks the user
against `ADMIN_IDS`. See `app/security.py`.
