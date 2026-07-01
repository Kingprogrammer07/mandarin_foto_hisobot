"""WebAuthn passkey persistence + short-lived challenge store.

Credentials live in a JSON file (data/passkeys.json, gitignored). Challenges are
kept in memory only for the few seconds between begin/complete.
"""
from __future__ import annotations

import base64
import json
import os
import secrets
import time
from threading import Lock

from . import config

_LOCK = Lock()
_FILE = config.DATA_DIR / "passkeys.json"


def _load_all() -> dict:
    try:
        with open(_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_all(data: dict) -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, _FILE)  # atomic


def _load() -> list[dict]:
    return _load_all().get("credentials", [])


def list_for_user(username: str) -> list[dict]:
    return [c for c in _load() if c.get("username") == username]


def find_by_id(credential_id_b64: str) -> dict | None:
    if not credential_id_b64:
        return None
    for c in _load():
        if c.get("credential_id") == credential_id_b64:
            return c
    return None


def get_or_create_handle(username: str) -> bytes:
    """Stable random opaque WebAuthn user handle (no PII on the authenticator)."""
    with _LOCK:
        data = _load_all()
        handles = data.setdefault("handles", {})
        h = handles.get(username)
        if not h:
            h = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
            handles[username] = h
            _save_all(data)
        return base64.urlsafe_b64decode(h + "=" * (-len(h) % 4))


def add_credential(username: str, credential_id_b64: str, public_key_b64: str,
                   sign_count: int, transports: list[str]) -> None:
    with _LOCK:
        data = _load_all()
        creds = data.setdefault("credentials", [])
        if any(c.get("credential_id") == credential_id_b64 for c in creds):
            return
        creds.append({
            "username": username,
            "credential_id": credential_id_b64,
            "public_key": public_key_b64,
            "sign_count": int(sign_count),
            "transports": transports or [],
            "created": int(time.time()),
        })
        _save_all(data)


def update_sign_count(credential_id_b64: str, count: int) -> None:
    with _LOCK:
        data = _load_all()
        creds = data.get("credentials", [])
        changed = False
        for c in creds:
            if c.get("credential_id") == credential_id_b64:
                c["sign_count"] = int(count)
                changed = True
        if changed:
            _save_all(data)


# --------------------------------------------------------------------------
# In-memory challenge store (bounded, TTL).
# --------------------------------------------------------------------------
_CHAL: dict[str, dict] = {}
_CHAL_TTL = 300  # seconds


def _gc(now: float) -> None:
    if len(_CHAL) > 1000:
        for k in [k for k, v in _CHAL.items() if v["exp"] < now]:
            _CHAL.pop(k, None)


def put_challenge(challenge: bytes, user: str | None = None) -> str:
    now = time.time()
    _gc(now)
    cid = secrets.token_urlsafe(18)
    _CHAL[cid] = {"challenge": challenge, "user": user, "exp": now + _CHAL_TTL}
    return cid


def take_challenge(cid: str) -> dict | None:
    rec = _CHAL.pop(cid, None)
    if not rec:
        return None
    if rec["exp"] < time.time():
        return None
    return rec
