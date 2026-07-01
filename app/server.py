"""FastAPI app: serves the Mini App static files, auth, and the report API.

Auth model:
- Inside Telegram: requests carry Mini App `initData` (HMAC-validated, admin-gated).
- In a browser: the user signs in with a username/password, which mints a signed
  httpOnly session cookie. `/api/report` accepts EITHER credential.
"""
from __future__ import annotations

import json as _json
import logging
import math
import time
from urllib.parse import urlparse

from fastapi import FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from . import config, db, passkeys
from .security import (
    InitDataError,
    authenticate_admin,
    issue_session,
    verify_session,
)

log = logging.getLogger("reys.server")

# Upload limits (server-side; the client cap in app.js is not trusted).
MAX_PHOTOS = 10
MAX_PHOTO_BYTES = 12 * 1024 * 1024       # 12 MB per photo
MAX_TOTAL_BYTES = 60 * 1024 * 1024       # 60 MB per request
MAX_BODY_BYTES = MAX_TOTAL_BYTES + 2 * 1024 * 1024  # + multipart overhead
_CHUNK = 64 * 1024

SESSION_COOKIE = "reys_session"

app = FastAPI(title="Reys hisoboti")


# ---------------------------------------------------------------------------
# Reject oversized request bodies BEFORE FastAPI buffers/spools them (the
# per-file caps below only apply after auth, during the manual read loop).
# ---------------------------------------------------------------------------
@app.middleware("http")
async def _limit_body(request: Request, call_next):
    if request.method == "POST":
        cl = request.headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > MAX_BODY_BYTES:
            return JSONResponse(status_code=413, content={"ok": False, "detail": "request too large"})
    return await call_next(request)


# ---------------------------------------------------------------------------
# Fixed-window rate limiter (bounded; keyed on a validated client IP).
# ---------------------------------------------------------------------------
_RATE: dict[str, tuple[int, float]] = {}
_RATE_MAX_KEYS = 10_000


def _rate_ok(key: str, limit: int, window: int = 60) -> bool:
    now = time.time()
    if len(_RATE) > _RATE_MAX_KEYS:  # opportunistic eviction of expired windows
        for k, (_, start) in list(_RATE.items()):
            if now - start > window:
                _RATE.pop(k, None)
    count, start = _RATE.get(key, (0, now))
    if now - start > window:
        count, start = 0, now
    count += 1
    _RATE[key] = (count, start)
    return count <= limit


_LOOPBACK = {"127.0.0.1", "::1"}


def _client_ip(request: Request) -> str:
    """Real client IP for rate limiting.

    Honor X-Forwarded-For / CF-Connecting-IP only from a trusted source: a
    configured proxy, OR a loopback peer. A local tunnel (cloudflared) connects
    from 127.0.0.1 and only local processes can do so, so trusting loopback is
    safe and avoids collapsing every external client into one global bucket.
    """
    direct = request.client.host if request.client else "unknown"
    if direct in config.TRUSTED_PROXIES or direct in _LOOPBACK:
        cf = request.headers.get("cf-connecting-ip")
        if cf:
            return cf.strip()
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
    return direct


def _same_origin(request: Request) -> bool:
    """For cookie-authenticated POSTs: require Origin/Referer to match Host (CSRF)."""
    host = request.headers.get("host", "")
    src = request.headers.get("origin") or request.headers.get("referer")
    if not src:
        return False  # a browser sends Origin on cross-origin POST; absence is suspicious
    return urlparse(src).netloc == host


def _set_session_cookie(resp: JSONResponse, token: str) -> None:
    resp.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=config.SESSION_TTL,
        httponly=True,
        secure=True,
        samesite="strict",
        path="/",
    )


@app.on_event("startup")
async def _startup() -> None:
    # Enforce required config even when launched via `uvicorn app.server:app`
    # (bypassing app/__main__.py). Prevents a fail-open empty-token deploy.
    config.require_config()
    db.init()


# Static assets (css/, js/).
app.mount("/css", StaticFiles(directory=str(config.WEBAPP_DIR / "css")), name="css")
app.mount("/js", StaticFiles(directory=str(config.WEBAPP_DIR / "js")), name="js")


async def _read_capped(upload: UploadFile, remaining_total: int) -> bytes:
    """Read an UploadFile in chunks, enforcing per-file and total caps."""
    buf = bytearray()
    while True:
        chunk = await upload.read(_CHUNK)
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > MAX_PHOTO_BYTES:
            raise HTTPException(status_code=413, detail="photo too large")
        if len(buf) > remaining_total:
            raise HTTPException(status_code=413, detail="upload too large")
    return bytes(buf)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(config.WEBAPP_DIR / "index.html")


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
@app.post("/api/auth/login")
async def login(request: Request):
    """Browser sign-in with username/password -> signed session cookie."""
    if not _rate_ok(f"login:{_client_ip(request)}", limit=8, window=60):
        raise HTTPException(status_code=429, detail="Juda ko'p urinish. Birozdan keyin urinib ko'ring.")

    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json")

    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    if not username or not password or not config.check_credentials(username, password):
        # Generic message — don't reveal whether the username exists.
        raise HTTPException(status_code=401, detail="Login yoki parol noto'g'ri")

    resp = JSONResponse({"ok": True, "user": username})
    _set_session_cookie(resp, issue_session(username))
    log.info("browser login: user=%s", username)
    return resp


@app.get("/api/auth/me")
async def auth_me(request: Request) -> dict:
    user = verify_session(request.cookies.get(SESSION_COOKIE, ""))
    return {"authenticated": user is not None, "user": user}


@app.post("/api/auth/logout")
async def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


def _require_session(request: Request) -> str:
    user = verify_session(request.cookies.get(SESSION_COOKIE, ""))
    if user is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    return user


# ---------------------------------------------------------------------------
# WebAuthn / passkeys (browser passwordless login; additive to password login)
# ---------------------------------------------------------------------------
@app.post("/api/webauthn/register/begin")
async def wa_register_begin(request: Request):
    if not config.WEBAUTHN_RP_ID:
        raise HTTPException(status_code=400, detail="webauthn not configured")
    user = _require_session(request)  # must be logged in (password) to enroll
    exclude = [
        PublicKeyCredentialDescriptor(id=base64url_to_bytes(c["credential_id"]))
        for c in passkeys.list_for_user(user)
    ]
    opts = generate_registration_options(
        rp_id=config.WEBAUTHN_RP_ID,
        rp_name=config.WEBAUTHN_RP_NAME,
        user_name=user,
        user_id=passkeys.get_or_create_handle(user),  # opaque handle, no PII
        user_display_name=user,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        exclude_credentials=exclude,
    )
    cid = passkeys.put_challenge(opts.challenge, user=user)
    return {"challenge_id": cid, "options": _json.loads(options_to_json(opts))}


@app.post("/api/webauthn/register/complete")
async def wa_register_complete(request: Request):
    user = _require_session(request)
    body = await request.json()
    rec = passkeys.take_challenge(body.get("challenge_id", ""))
    if not rec or rec.get("user") != user:
        raise HTTPException(status_code=400, detail="challenge expired")
    try:
        ver = verify_registration_response(
            credential=body.get("credential"),
            expected_challenge=rec["challenge"],
            expected_rp_id=config.WEBAUTHN_RP_ID,
            expected_origin=config.WEBAUTHN_ORIGIN,
            require_user_verification=True,
        )
    except Exception as exc:  # noqa: BLE001
        log.info("passkey register failed for %s: %s", user, exc)
        raise HTTPException(status_code=400, detail="registration failed")

    transports = []
    try:
        transports = (body.get("credential", {}).get("response", {}) or {}).get("transports") or []
    except Exception:  # noqa: BLE001
        pass
    passkeys.add_credential(
        user,
        bytes_to_base64url(ver.credential_id),
        bytes_to_base64url(ver.credential_public_key),
        ver.sign_count,
        transports,
    )
    log.info("passkey registered for %s", user)
    return {"ok": True}


@app.post("/api/webauthn/auth/begin")
async def wa_auth_begin(request: Request):
    if not config.WEBAUTHN_RP_ID:
        raise HTTPException(status_code=400, detail="webauthn not configured")
    if not _rate_ok(f"walogin:{_client_ip(request)}", limit=15, window=60):
        raise HTTPException(status_code=429, detail="too many attempts")
    opts = generate_authentication_options(
        rp_id=config.WEBAUTHN_RP_ID,
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    cid = passkeys.put_challenge(opts.challenge, user=None)
    return {"challenge_id": cid, "options": _json.loads(options_to_json(opts))}


@app.post("/api/webauthn/auth/complete")
async def wa_auth_complete(request: Request):
    body = await request.json()
    rec = passkeys.take_challenge(body.get("challenge_id", ""))
    if not rec:
        raise HTTPException(status_code=400, detail="challenge expired")

    cred = body.get("credential") or {}
    stored = passkeys.find_by_id(cred.get("id") or cred.get("rawId"))
    if not stored:
        raise HTTPException(status_code=403, detail="unknown passkey")
    # The passkey's account must still exist.
    if not config.has_credential(stored["username"]):
        raise HTTPException(status_code=403, detail="account disabled")

    try:
        ver = verify_authentication_response(
            credential=cred,
            expected_challenge=rec["challenge"],
            expected_rp_id=config.WEBAUTHN_RP_ID,
            expected_origin=config.WEBAUTHN_ORIGIN,
            credential_public_key=base64url_to_bytes(stored["public_key"]),
            credential_current_sign_count=stored["sign_count"],
            require_user_verification=True,
        )
    except Exception as exc:  # noqa: BLE001
        log.info("passkey auth failed: %s", exc)
        raise HTTPException(status_code=403, detail="verification failed")

    passkeys.update_sign_count(stored["credential_id"], ver.new_sign_count)
    resp = JSONResponse({"ok": True, "user": stored["username"]})
    _set_session_cookie(resp, issue_session(stored["username"]))
    log.info("passkey login: user=%s", stored["username"])
    return resp


def _identity(request: Request, init_data: str = "", state_changing: bool = True) -> str:
    """Return an identity from initData (Telegram) or session cookie (browser).

    Telegram initData may arrive in the form body (POST) or the
    `X-Telegram-Init-Data` header (GET). The same-origin (CSRF) check applies
    only to cookie-authenticated state-changing requests.
    """
    idata = init_data or request.headers.get("x-telegram-init-data", "")
    if idata:
        return f"tg:{authenticate_admin(idata).id}"  # raises on failure
    if state_changing and not _same_origin(request):
        raise InitDataError("bad origin")
    user = verify_session(request.cookies.get(SESSION_COOKIE, ""))
    if user is None:
        raise InitDataError("not authenticated")
    return f"pw:{user}"


def _auth_or_403(request: Request, init_data: str = "", state_changing: bool = True) -> str:
    try:
        return _identity(request, init_data, state_changing)
    except InitDataError as exc:
        raise HTTPException(status_code=403, detail=str(exc))


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
@app.post("/api/report")
async def submit_report(
    request: Request,
    init_data: str = Form(""),
    type: str = Form(...),
    coefficient: float = Form(...),
    coefficient_mode: str = Form(...),
    weight: float = Form(...),
    photos: list[UploadFile] = [],  # noqa: B006 (FastAPI handles default)
):
    if not _rate_ok(f"report:{_client_ip(request)}", limit=30, window=60):
        raise HTTPException(status_code=429, detail="too many requests")

    identity = _auth_or_403(request, init_data)

    # Validate inputs.
    tovar_turi = (type or "").strip()
    if not tovar_turi:
        raise HTTPException(status_code=400, detail="tovar turi tanlanmagan")
    # Reject inf/nan before any arithmetic hits the DB (would poison a balance).
    if not (math.isfinite(weight) and math.isfinite(coefficient)):
        raise HTTPException(status_code=400, detail="qiymat noto'g'ri")
    if not (weight > 0):
        raise HTTPException(status_code=400, detail="og'irlik noto'g'ri")
    if coefficient < 0:
        raise HTTPException(status_code=400, detail="koeffitsient noto'g'ri")
    # net weight added to inventory = weight − coefficient (coef is kg to subtract).
    net = round(weight - coefficient, 4)
    if net < 0:
        raise HTTPException(status_code=400, detail="koeffitsient og'irlikdan katta")

    # Photo count cap (client cap is not trusted); read within size caps.
    if len(photos) > MAX_PHOTOS:
        raise HTTPException(status_code=413, detail=f"max {MAX_PHOTOS} photos")
    total = 0
    for f in photos:
        content = await _read_capped(f, MAX_TOTAL_BYTES - total)
        total += len(content)

    result = db.add_reys(identity, tovar_turi, weight, coefficient, net, len(photos))
    log.info("reys by %s: %s +%s (weight=%s coef=%s photos=%d)",
             identity, tovar_turi, net, weight, coefficient, len(photos))
    return JSONResponse({"ok": True, "net": net, "balance": result["balance"]})


# ---------------------------------------------------------------------------
# Adashgan yuklar — move weight from one tovar turi to another
# ---------------------------------------------------------------------------
@app.post("/api/adjust")
async def submit_adjust(request: Request):
    if not _rate_ok(f"adjust:{_client_ip(request)}", limit=60, window=60):
        raise HTTPException(status_code=429, detail="too many requests")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json")

    identity = _auth_or_403(request, str(body.get("init_data", "")))
    from_type = str(body.get("from_type", "")).strip()
    to_type = str(body.get("to_type", "")).strip()
    try:
        weight = float(body.get("weight"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="og'irlik noto'g'ri")

    if not from_type or not to_type:
        raise HTTPException(status_code=400, detail="ikkala tovar turini tanlang")
    if from_type == to_type:
        raise HTTPException(status_code=400, detail="tovar turlari bir xil bo'lmasin")
    if not (math.isfinite(weight) and weight > 0):
        raise HTTPException(status_code=400, detail="og'irlik noto'g'ri")

    try:
        result = db.adjust(identity, from_type, to_type, weight)
    except db.InsufficientStock as exc:
        raise HTTPException(
            status_code=409,
            detail=f"{exc.tovar_turi}da yetarli emas: {exc.have} kg mavjud",
        )
    log.info("adjust by %s: %s -> %s %s kg", identity, from_type, to_type, weight)
    return JSONResponse({"ok": True, "balances": result["balances"]})


@app.get("/api/inventory")
async def api_inventory(request: Request):
    _auth_or_403(request, state_changing=False)
    return {"inventory": db.get_inventory()}


@app.get("/api/activity")
async def api_activity(request: Request, start: int | None = None, end: int | None = None):
    identity = _auth_or_403(request, state_changing=False)
    return {"activity": db.get_activity(actor=identity, limit=500, ts_from=start, ts_to=end)}


@app.exception_handler(Exception)
async def unhandled(_: Request, exc: Exception):
    log.exception("unhandled error: %s", exc)
    return JSONResponse(status_code=500, content={"ok": False, "detail": "server error"})
