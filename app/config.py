"""Centralized configuration loaded from environment / .env."""
from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

# Load .env from project root (one level above this file's package).
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

WEBAPP_DIR = BASE_DIR / "webapp"
ASSETS_DIR = BASE_DIR / "assets"
DATA_DIR = BASE_DIR / "data"  # passkeys store (gitignored)


def _parse_admin_ids(raw: str) -> set[int]:
    ids: set[int] = set()
    for part in raw.replace(";", ",").split(","):
        part = part.strip()
        if part:
            ids.add(int(part))
    return ids


def _parse_credentials(raw: str) -> dict[str, str]:
    """Parse ADMIN_CREDENTIALS: `user1:<pbkdf2hash>,user2:<pbkdf2hash>`.

    The PBKDF2 string contains '$' but never ':' or ',', so split is unambiguous.
    """
    creds: dict[str, str] = {}
    for part in raw.split(","):
        part = part.strip()
        if not part or ":" not in part:
            continue
        user, stored = part.split(":", 1)
        user = user.strip()
        if user:
            creds[user] = stored.strip()
    return creds


def _parse_proxies(raw: str) -> set[str]:
    return {p.strip() for p in raw.split(",") if p.strip()}


BOT_TOKEN: str = os.getenv("BOT_TOKEN", "").strip()
ADMIN_IDS: set[int] = _parse_admin_ids(os.getenv("ADMIN_IDS", ""))


def _parse_chat_id(raw: str):
    """A Telegram chat id: numeric (-100…) or an @channelusername. None = disabled."""
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return raw


# Channel that saved reys/adashgan entries are forwarded to (photos + caption).
# None disables forwarding (the send worker idles).
KARGO_CHANNEL_ID = _parse_chat_id(os.getenv("BOT_KARGOLARGA_TARQATISH_CHANNEL_ID", ""))
TOP_TYPE_CHANNEL_ID = _parse_chat_id(os.getenv("BOT_TOP_TYPE_CHANNEL_ID", ""))
TOPDAN_CHIQGAN_CHANNEL_ID = _parse_chat_id(os.getenv("BOT_TOPDAN_CHIQGAN_CHANNEL_ID", ""))
BIZDA_QOLADIGAN_CHANNEL_ID = _parse_chat_id(os.getenv("BOT_BIZDA_QOLADIGAN_CHANNEL_ID", ""))
BIZDAN_CHIQGAN_CHANNEL_ID = _parse_chat_id(os.getenv("BOT_BIZDAN_CHIQGAN_CHANNEL_ID", ""))

OBSHIY_CHANNELS = {
    "top": TOP_TYPE_CHANNEL_ID,
    "topchiqgan": TOPDAN_CHIQGAN_CHANNEL_ID,
    "bizda": BIZDA_QOLADIGAN_CHANNEL_ID,
    "chiqgan": BIZDAN_CHIQGAN_CHANNEL_ID,
}


def channel_for_action(action: str):
    if action in OBSHIY_CHANNELS:
        return OBSHIY_CHANNELS[action]
    if action in {"reys", "adjust"}:
        return KARGO_CHANNEL_ID
    return None

# Browser (username/password) login accounts. Generate with:
#   python -m app.passwords <username>
ADMIN_CREDENTIALS: dict[str, str] = _parse_credentials(os.getenv("ADMIN_CREDENTIALS", ""))

# Public HTTPS url where the Mini App is served (Telegram requires https).
WEBAPP_URL: str = os.getenv("WEBAPP_URL", "").strip()

# Bind to localhost by default — the public tunnel (cloudflared) connects locally,
# so the port need not be exposed on the LAN. Set 0.0.0.0 only if you must.
HOST: str = os.getenv("HOST", "127.0.0.1")
PORT: int = int(os.getenv("PORT", "8080"))

# Reject initData older than this many seconds (replay protection). 0 disables.
INITDATA_MAX_AGE: int = int(os.getenv("INITDATA_MAX_AGE", "86400"))

# Browser session lifetime. Short by default (stateless tokens can't be revoked
# individually; removing a user's ADMIN_CREDENTIALS line kills their sessions).
SESSION_TTL: int = int(os.getenv("SESSION_TTL", str(12 * 3600)))  # 12 hours

# IPs of trusted reverse proxies whose forwarding headers we honor. Empty means
# we never trust client-supplied forwarding headers (use the direct peer IP).
TRUSTED_PROXIES: set[str] = _parse_proxies(os.getenv("TRUSTED_PROXIES", ""))

# WebAuthn (passkeys). RP ID is the registrable domain — defaults to the
# WEBAPP_URL host. Passkeys are bound to it: if the domain changes (e.g. a new
# tunnel URL), previously registered passkeys stop working and must be re-added.
WEBAUTHN_RP_ID: str = os.getenv("WEBAUTHN_RP_ID", "").strip() or (urlparse(WEBAPP_URL).hostname or "")
WEBAUTHN_RP_NAME: str = os.getenv("WEBAUTHN_RP_NAME", "Reys hisoboti").strip()
WEBAUTHN_ORIGIN: str = WEBAPP_URL.rstrip("/")


def is_admin(user_id: int) -> bool:
    return user_id in ADMIN_IDS


def has_credential(username: str) -> bool:
    return username in ADMIN_CREDENTIALS


def check_credentials(username: str, password: str) -> bool:
    """Constant-ish time credential check (dummy-verify unknown users)."""
    from .passwords import verify_password

    stored = ADMIN_CREDENTIALS.get(username)
    if stored is None:
        # Spend comparable time so presence/absence of a user isn't timing-leaked.
        verify_password(password, "pbkdf2_sha256$200000$00$00")
        return False
    return verify_password(password, stored)


def require_config() -> None:
    missing = []
    if not BOT_TOKEN:
        missing.append("BOT_TOKEN")
    if not ADMIN_IDS:
        missing.append("ADMIN_IDS")
    if not WEBAPP_URL:
        missing.append("WEBAPP_URL")
    if missing:
        raise RuntimeError(f"Missing required config: {', '.join(missing)} (see .env.example)")
    # Telegram only opens Mini Apps over HTTPS.
    if not WEBAPP_URL.startswith("https://"):
        raise RuntimeError(f"WEBAPP_URL must be an https:// url, got: {WEBAPP_URL!r}")
