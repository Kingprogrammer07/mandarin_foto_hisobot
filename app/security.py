"""Telegram WebApp initData validation + Login Widget + browser sessions.

Specs:
- Mini App initData: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
- Login Widget:       https://core.telegram.org/widgets/login#checking-authorization
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from urllib.parse import parse_qsl

from . import config


@dataclass
class WebAppUser:
    id: int
    first_name: str = ""
    username: str = ""
    raw: dict | None = None


class InitDataError(Exception):
    """Raised when initData is missing, malformed, expired, or has a bad signature."""


def validate_init_data(init_data: str, bot_token: str = "") -> WebAppUser:
    """Verify the HMAC signature of Telegram WebApp initData and return the user.

    Raises InitDataError on any failure.
    """
    token = bot_token or config.BOT_TOKEN
    if not token:
        # Fail closed: an empty token yields a publicly-derivable secret key,
        # which would let anyone forge a valid signature.
        raise InitDataError("server misconfigured: empty bot token")
    if not init_data:
        raise InitDataError("empty init_data")

    pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        raise InitDataError("missing hash")

    # data_check_string: all fields except hash, sorted by key, joined by \n.
    data_check_string = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs))

    secret_key = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(computed_hash, received_hash):
        raise InitDataError("bad signature")

    # Optional freshness / replay protection.
    if config.INITDATA_MAX_AGE > 0:
        try:
            auth_date = int(pairs.get("auth_date", "0"))
        except ValueError:
            auth_date = 0
        if auth_date <= 0 or (time.time() - auth_date) > config.INITDATA_MAX_AGE:
            raise InitDataError("init_data expired")

    user_raw = pairs.get("user")
    if not user_raw:
        raise InitDataError("missing user")
    try:
        user = json.loads(user_raw)
    except json.JSONDecodeError as exc:
        raise InitDataError("invalid user json") from exc

    return WebAppUser(
        id=int(user["id"]),
        first_name=user.get("first_name", ""),
        username=user.get("username", ""),
        raw=user,
    )


def authenticate_admin(init_data: str) -> WebAppUser:
    """Validate initData and ensure the user is an allowed admin."""
    user = validate_init_data(init_data)
    if not config.is_admin(user.id):
        raise InitDataError("not authorized")
    return user


# --------------------------------------------------------------------------
# Stateless signed browser session (HMAC over "<username>.<exp>")
# --------------------------------------------------------------------------
# The browser path authenticates with a username/password (see config.
# check_credentials); the session subject is that username. Tokens are
# stateless and cannot be individually revoked before expiry — removing the
# user's ADMIN_CREDENTIALS line invalidates their sessions immediately, and
# rotating BOT_TOKEN invalidates all sessions at once.

def _session_secret() -> bytes:
    # Derived from the bot token; rotates automatically if the token changes.
    return hashlib.sha256(b"reys-session:" + (config.BOT_TOKEN or "").encode()).digest()


def issue_session(username: str, ttl: int | None = None) -> str:
    exp = int(time.time()) + int(ttl if ttl is not None else config.SESSION_TTL)
    payload = f"{username}.{exp}"
    sig = hmac.new(_session_secret(), payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{payload}.{sig}".encode()).decode()


def verify_session(token: str) -> str | None:
    """Return the username for a valid, unexpired session, else None.

    `username` may itself contain '.'; exp and sig never do, so rsplit(2) is safe.
    """
    if not token:
        return None
    try:
        raw = base64.urlsafe_b64decode(token.encode()).decode()
        username, exp_s, sig = raw.rsplit(".", 2)
        payload = f"{username}.{exp_s}"
        expected = hmac.new(_session_secret(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, sig):
            return None
        if int(exp_s) < time.time():
            return None
    except Exception:
        return None
    # Re-check on every request so removing a credential kills sessions instantly.
    if not config.has_credential(username):
        return None
    return username
