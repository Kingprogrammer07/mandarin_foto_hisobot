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
from urllib.parse import quote, urlparse

from fastapi import FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
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

from . import config, db, excel_export, outbox, passkeys
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
    # Any body-bearing method — the PUT edit endpoints take multipart too.
    if request.method in ("POST", "PUT", "PATCH"):
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
    # Drain any queued channel sends (idles until a bot is set by __main__).
    outbox.ensure_started()


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


async def _read_photos(photos: list[UploadFile]) -> list[tuple[bytes, str]]:
    """Validate count + read all photos into memory as [(bytes, mime), …]."""
    if len(photos) > MAX_PHOTOS:
        raise HTTPException(status_code=413, detail=f"max {MAX_PHOTOS} photos")
    out: list[tuple[bytes, str]] = []
    total = 0
    for f in photos:
        content = await _read_capped(f, MAX_TOTAL_BYTES - total)
        total += len(content)
        out.append((content, f.content_type or "image/jpeg"))
    return out


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
# Reports (named containers; each has its own inventory, starts at 0)
# ---------------------------------------------------------------------------
def _require_report(report_id) -> int:
    try:
        rid = int(report_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="hisobot tanlanmagan")
    if not db.report_exists(rid):
        raise HTTPException(status_code=404, detail="hisobot topilmadi")
    return rid


OBSHIY_KINDS = {"top", "topchiqgan", "bizda", "chiqgan"}


def _entry_action(kind: str) -> str:
    kind = str(kind or "reys")
    if kind in OBSHIY_KINDS:
        return kind
    if kind == "adjust":
        return "adjust"
    return "reys"


@app.get("/api/reports")
async def api_reports_list(request: Request):
    _auth_or_403(request, state_changing=False)
    return {"reports": db.list_reports(), "max": db.MAX_REPORTS}


@app.post("/api/reports")
async def api_reports_create(request: Request):
    if not _rate_ok(f"report:{_client_ip(request)}", limit=30, window=60):
        raise HTTPException(status_code=429, detail="too many requests")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json")
    _auth_or_403(request, str(body.get("init_data", "")))
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="hisobotga nom bering")
    if len(name) > 60:
        raise HTTPException(status_code=400, detail="nom juda uzun")
    try:
        rep = db.create_report(name)
    except db.DuplicateName:
        raise HTTPException(status_code=409, detail="bu nomli hisobot allaqachon bor")
    except db.MaxReportsReached:
        raise HTTPException(status_code=409, detail=f"maksimal {db.MAX_REPORTS} ta hisobot saqlanadi")
    return JSONResponse({"ok": True, "report": rep})


@app.delete("/api/reports/{report_id}")
async def api_reports_delete(request: Request, report_id: int):
    identity = _auth_or_403(request, state_changing=True)  # cookie path requires same-origin
    db.delete_report(report_id)
    log.info("report %s deleted by %s", report_id, identity)
    return {"ok": True}


@app.post("/api/reports/{report_id}/zero-top-coefficients")
async def api_reports_zero_top_coefficients(request: Request, report_id: int):
    if not _rate_ok(f"zero-coef:{_client_ip(request)}", limit=10, window=60):
        raise HTTPException(status_code=429, detail="too many requests")
    try:
        body = await request.json()
    except Exception:
        body = {}
    identity = _auth_or_403(request, str(body.get("init_data", "")), state_changing=True)
    rid = _require_report(report_id)
    changed = db.zero_top_coefficients(rid)
    log.info("top coefficients zeroed by %s [r%s]: %s entries", identity, rid, changed)
    return {"ok": True, "changed": changed}


@app.get("/api/types")
async def api_types_list(request: Request):
    _auth_or_403(request, state_changing=False)
    return db.list_types()


@app.post("/api/types")
async def api_types_add(request: Request):
    if not _rate_ok(f"types:{_client_ip(request)}", limit=30, window=60):
        raise HTTPException(status_code=429, detail="too many requests")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json")
    _auth_or_403(request, str(body.get("init_data", "")), state_changing=True)
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="tovar turini kiriting")
    if len(name) > 40:
        raise HTTPException(status_code=400, detail="tovar turi juda uzun")
    try:
        name = db.add_custom_type(name)
    except ValueError:
        raise HTTPException(status_code=400, detail="tovar turi noto'g'ri")
    return {"ok": True, "name": name, **db.list_types()}


@app.delete("/api/types/{name}")
async def api_types_delete(request: Request, name: str):
    if not _rate_ok(f"types:{_client_ip(request)}", limit=30, window=60):
        raise HTTPException(status_code=429, detail="too many requests")
    _auth_or_403(request, state_changing=True)
    try:
        db.delete_custom_type(name)
    except ValueError:
        raise HTTPException(status_code=400, detail="default tovar turini o'chirib bo'lmaydi")
    return {"ok": True, **db.list_types()}


# ---------------------------------------------------------------------------
# Reys hisoboti — add net weight to a report's tovar turi balance
# ---------------------------------------------------------------------------
@app.post("/api/report")
async def submit_report(
    request: Request,
    init_data: str = Form(""),
    report_id: int = Form(...),
    type: str = Form(...),
    coefficient: float = Form(...),
    coefficient_mode: str = Form(...),
    box_weight: float = Form(0),
    weight: float = Form(...),
    photos: list[UploadFile] = [],  # noqa: B006 (FastAPI handles default)
):
    if not _rate_ok(f"report:{_client_ip(request)}", limit=30, window=60):
        raise HTTPException(status_code=429, detail="too many requests")

    identity = _auth_or_403(request, init_data)
    rid = _require_report(report_id)

    tovar_turi = (type or "").strip()
    if not tovar_turi:
        raise HTTPException(status_code=400, detail="tovar turi tanlanmagan")
    # Reject inf/nan before any arithmetic hits the DB (would poison a balance).
    if not (math.isfinite(weight) and math.isfinite(coefficient) and math.isfinite(box_weight)):
        raise HTTPException(status_code=400, detail="qiymat noto'g'ri")
    if not (weight > 0):
        raise HTTPException(status_code=400, detail="og'irlik noto'g'ri")
    if coefficient < 0 or box_weight < 0:
        raise HTTPException(status_code=400, detail="koeffitsient noto'g'ri")
    # net weight added to inventory = weight − coefficient (coef is kg to subtract).
    net = round(weight - coefficient, 4)
    if net < 0:
        raise HTTPException(status_code=400, detail="koeffitsient og'irlikdan katta")

    photo_data = await _read_photos(photos)

    result = db.add_reys(rid, identity, tovar_turi, weight, coefficient, net, len(photo_data), box_weight)
    entry_id = result["entry_id"]
    if photo_data:
        db.save_photos(entry_id, photo_data)  # persisted to disk (survives a crash)
    log.info("reys by %s [r%s e%s]: %s +%s (weight=%s coef=%s photos=%d)",
             identity, rid, entry_id, tovar_turi, net, weight, coefficient, len(photo_data))
    return JSONResponse({"ok": True, "net": net, "balance": result["balance"],
                         "inventory": result["inventory"], "entry_id": entry_id,
                         "photo_idxs": list(range(len(photo_data)))})


@app.put("/api/report/{entry_id}")
async def edit_report_entry(
    request: Request,
    entry_id: int,
    init_data: str = Form(""),
    report_id: int = Form(...),
    type: str = Form(...),
    coefficient: float = Form(...),
    coefficient_mode: str = Form(""),
    box_weight: float = Form(0),
    weight: float = Form(...),
):
    """Fix a saved reys entry's numbers. Photos are immutable after the initial
    save; the inventory delta is compensated atomically."""
    if not _rate_ok(f"report:{_client_ip(request)}", limit=30, window=60):
        raise HTTPException(status_code=429, detail="too many requests")

    identity = _auth_or_403(request, init_data)
    rid = _require_report(report_id)

    tovar_turi = (type or "").strip()
    if not tovar_turi:
        raise HTTPException(status_code=400, detail="tovar turi tanlanmagan")
    if not (math.isfinite(weight) and math.isfinite(coefficient) and math.isfinite(box_weight)):
        raise HTTPException(status_code=400, detail="qiymat noto'g'ri")
    if not (weight > 0):
        raise HTTPException(status_code=400, detail="og'irlik noto'g'ri")
    if coefficient < 0 or box_weight < 0:
        raise HTTPException(status_code=400, detail="koeffitsient noto'g'ri")
    net = round(weight - coefficient, 4)
    if net < 0:
        raise HTTPException(status_code=400, detail="koeffitsient og'irlikdan katta")

    try:
        result = db.edit_reys(rid, entry_id, tovar_turi, weight, coefficient, net, box_weight)
    except db.ActivityNotFound:
        raise HTTPException(status_code=404, detail="yozuv topilmadi")
    except db.InsufficientStock as exc:
        raise HTTPException(
            status_code=409,
            detail=f"{exc.tovar_turi}da yetarli emas: {round(exc.have, 2)} kg mavjud",
        )
    log.info("reys edit by %s [r%s e%s]: %s (weight=%s coef=%s)",
             identity, rid, entry_id, tovar_turi, weight, coefficient)
    return JSONResponse({"ok": True, "net": net, "balance": result["balance"],
                         "inventory": result["inventory"], "entry_id": entry_id,
                         "edited": bool(result.get("edited"))})


# ---------------------------------------------------------------------------
# Adashgan yuklar — move weight from one tovar turi to another (same report)
# ---------------------------------------------------------------------------
@app.post("/api/adjust")
async def submit_adjust(
    request: Request,
    init_data: str = Form(""),
    report_id: int = Form(...),
    from_type: str = Form(...),
    to_type: str = Form(...),
    weight: float = Form(...),
    photos: list[UploadFile] = [],  # noqa: B006
):
    if not _rate_ok(f"adjust:{_client_ip(request)}", limit=60, window=60):
        raise HTTPException(status_code=429, detail="too many requests")

    identity = _auth_or_403(request, init_data)
    rid = _require_report(report_id)
    from_type = from_type.strip()
    to_type = to_type.strip()

    if not from_type or not to_type:
        raise HTTPException(status_code=400, detail="ikkala tovar turini tanlang")
    if from_type == to_type:
        raise HTTPException(status_code=400, detail="tovar turlari bir xil bo'lmasin")
    if not (math.isfinite(weight) and weight > 0):
        raise HTTPException(status_code=400, detail="og'irlik noto'g'ri")

    photo_data = await _read_photos(photos)

    try:
        result = db.adjust(rid, identity, from_type, to_type, weight, len(photo_data))
    except db.InsufficientStock as exc:
        raise HTTPException(
            status_code=409,
            detail=f"{exc.tovar_turi}da yetarli emas: {exc.have} kg mavjud",
        )
    entry_id = result["entry_id"]
    if photo_data:
        db.save_photos(entry_id, photo_data)
    log.info("adjust by %s [r%s e%s]: %s -> %s %s kg photos=%d",
             identity, rid, entry_id, from_type, to_type, weight, len(photo_data))
    return JSONResponse({"ok": True, "balances": result["balances"], "entry_id": entry_id,
                         "photo_idxs": list(range(len(photo_data)))})


@app.put("/api/adjust/{entry_id}")
async def edit_adjust_entry(
    request: Request,
    entry_id: int,
    init_data: str = Form(""),
    report_id: int = Form(...),
    from_type: str = Form(...),
    to_type: str = Form(...),
    weight: float = Form(...),
):
    """Fix a saved transfer's numbers (photos immutable): the old transfer is
    reversed and the new one applied atomically."""
    if not _rate_ok(f"adjust:{_client_ip(request)}", limit=60, window=60):
        raise HTTPException(status_code=429, detail="too many requests")

    identity = _auth_or_403(request, init_data)
    rid = _require_report(report_id)
    from_type = from_type.strip()
    to_type = to_type.strip()

    if not from_type or not to_type:
        raise HTTPException(status_code=400, detail="ikkala tovar turini tanlang")
    if from_type == to_type:
        raise HTTPException(status_code=400, detail="tovar turlari bir xil bo'lmasin")
    if not (math.isfinite(weight) and weight > 0):
        raise HTTPException(status_code=400, detail="og'irlik noto'g'ri")

    try:
        result = db.edit_adjust(rid, entry_id, from_type, to_type, weight)
    except db.ActivityNotFound:
        raise HTTPException(status_code=404, detail="yozuv topilmadi")
    except db.InsufficientStock as exc:
        raise HTTPException(
            status_code=409,
            detail=f"{exc.tovar_turi}da yetarli emas: {round(exc.have, 2)} kg mavjud",
        )
    log.info("adjust edit by %s [r%s e%s]: %s -> %s %s kg",
             identity, rid, entry_id, from_type, to_type, weight)
    return JSONResponse({"ok": True, "balances": result["balances"], "entry_id": entry_id,
                         "edited": bool(result.get("edited"))})


@app.post("/api/obshiy")
async def submit_obshiy(
    request: Request,
    init_data: str = Form(""),
    report_id: int = Form(...),
    section: str = Form(...),
    code: str = Form(""),
    coefficient: float = Form(0),
    coefficient_mode: str = Form("fixed"),
    box_weight: float = Form(0),
    weight: float = Form(...),
    photos: list[UploadFile] = [],  # noqa: B006
):
    if not _rate_ok(f"obshiy:{_client_ip(request)}", limit=80, window=60):
        raise HTTPException(status_code=429, detail="too many requests")
    identity = _auth_or_403(request, init_data)
    rid = _require_report(report_id)
    section = str(section or "").strip()
    if section not in OBSHIY_KINDS:
        raise HTTPException(status_code=400, detail="bo'lim noto'g'ri")
    if section == "top" and not code.strip():
        raise HTTPException(status_code=400, detail="karobka kodini kiriting")
    if section == "top":
        coefficient = 0
        coefficient_mode = "none"
    if not (math.isfinite(weight) and weight > 0):
        raise HTTPException(status_code=400, detail="og'irlik noto'g'ri")
    if not (math.isfinite(coefficient) and math.isfinite(box_weight)):
        raise HTTPException(status_code=400, detail="karobka og'irligi noto'g'ri")
    if coefficient < 0 or box_weight < 0:
        raise HTTPException(status_code=400, detail="karobka og'irligi noto'g'ri")
    if box_weight <= 0 and coefficient > 0:
        box_weight = coefficient
    coefficient = 0
    if box_weight > 0 and coefficient_mode == "none":
        coefficient_mode = "fixed"
    net = round(weight, 4)

    photo_data = await _read_photos(photos)
    result = db.add_obshiy(rid, identity, section, code, weight, coefficient, net, len(photo_data), box_weight)
    entry_id = result["entry_id"]
    if photo_data:
        db.save_photos(entry_id, photo_data)
    log.info("obshiy by %s [r%s e%s %s]: code=%s weight=%s box=%s mode=%s photos=%d",
             identity, rid, entry_id, section, code, weight, box_weight, coefficient_mode, len(photo_data))
    return JSONResponse({"ok": True, "entry_id": entry_id, "net": net,
                         "box_weight": box_weight,
                         "photo_idxs": list(range(len(photo_data)))})


@app.put("/api/obshiy/{entry_id}")
async def edit_obshiy_entry(
    request: Request,
    entry_id: int,
    init_data: str = Form(""),
    report_id: int = Form(...),
    section: str = Form(...),
    code: str = Form(""),
    coefficient: float = Form(0),
    coefficient_mode: str = Form(""),
    box_weight: float = Form(0),
    weight: float = Form(...),
):
    if not _rate_ok(f"obshiy:{_client_ip(request)}", limit=80, window=60):
        raise HTTPException(status_code=429, detail="too many requests")
    identity = _auth_or_403(request, init_data)
    rid = _require_report(report_id)
    section = str(section or "").strip()
    if section not in OBSHIY_KINDS:
        raise HTTPException(status_code=400, detail="bo'lim noto'g'ri")
    if section == "top" and not code.strip():
        raise HTTPException(status_code=400, detail="karobka kodini kiriting")
    if section == "top":
        coefficient = 0
        coefficient_mode = "none"
    if not (math.isfinite(weight) and weight > 0):
        raise HTTPException(status_code=400, detail="og'irlik noto'g'ri")
    if not (math.isfinite(coefficient) and math.isfinite(box_weight)):
        raise HTTPException(status_code=400, detail="karobka og'irligi noto'g'ri")
    if coefficient < 0 or box_weight < 0:
        raise HTTPException(status_code=400, detail="karobka og'irligi noto'g'ri")
    if box_weight <= 0 and coefficient > 0:
        box_weight = coefficient
    coefficient = 0
    if box_weight > 0 and coefficient_mode == "none":
        coefficient_mode = "fixed"
    net = round(weight, 4)
    try:
        result = db.edit_obshiy(rid, entry_id, section, code, weight, coefficient, net, box_weight)
    except db.ActivityNotFound:
        raise HTTPException(status_code=404, detail="yozuv topilmadi")
    log.info("obshiy edit by %s [r%s e%s %s]: code=%s weight=%s box=%s mode=%s",
             identity, rid, entry_id, section, code, weight, box_weight, coefficient_mode)
    return JSONResponse({"ok": True, "entry_id": entry_id, "net": net,
                         "box_weight": box_weight,
                         "edited": bool(result.get("edited"))})


@app.delete("/api/entry/{entry_id}")
async def delete_entry(request: Request, entry_id: int, report_id: int | None = None):
    """Delete a reys/adjust entry and undo its inventory effect."""
    if not _rate_ok(f"adjust:{_client_ip(request)}", limit=60, window=60):
        raise HTTPException(status_code=429, detail="too many requests")
    identity = _auth_or_403(request, state_changing=True)  # cookie path requires same-origin
    rid = _require_report(report_id)
    try:
        result = db.delete_entry(rid, entry_id)
    except db.ActivityNotFound:
        raise HTTPException(status_code=404, detail="yozuv topilmadi")
    except db.InsufficientStock as exc:
        raise HTTPException(
            status_code=409,
            detail=f"{exc.tovar_turi}da yetarli emas: {round(exc.have, 2)} kg mavjud",
        )
    log.info("entry %s deleted by %s [r%s]", entry_id, identity, rid)
    return {"ok": True, "balances": result["balances"]}


@app.get("/api/entries")
async def api_entries(request: Request, report_id: int | None = None, kind: str = "reys"):
    """Saved reys/adashgan rows for the 'Yuklanganlar' viewer (survives reload).
    Photos are fetched separately via /api/entry/{id}/photo/{idx}."""
    _auth_or_403(request, state_changing=False)
    rid = _require_report(report_id)
    action = _entry_action(kind)
    return {"entries": db.list_entries(rid, action)}


@app.get("/api/entries/status")
async def api_entries_status(request: Request, report_id: int | None = None, kind: str = "reys"):
    _auth_or_403(request, state_changing=False)
    rid = _require_report(report_id)
    action = _entry_action(kind)
    return {"entries": db.list_entry_statuses(rid, action)}


@app.get("/api/export/kargo")
async def api_export_kargo(request: Request, report_id: int | None = None):
    _auth_or_403(request, state_changing=False)
    rid = _require_report(report_id)
    try:
        content, filename = excel_export.build_kargo_excel(rid)
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="excel namunasi topilmadi")
    except ModuleNotFoundError as exc:
        log.exception("excel export dependency missing")
        raise HTTPException(status_code=500, detail=f"excel kutubxonasi topilmadi: {exc.name}")
    except Exception as exc:
        log.exception("excel export failed: report_id=%s", rid)
        raise HTTPException(status_code=500, detail=f"excel yaratishda xato: {exc}")
    headers = {
        "Content-Disposition": (
            "attachment; "
            f"filename*=UTF-8''{quote(filename)}"
        )
    }
    return StreamingResponse(
        iter([content]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@app.get("/api/export/obshiy")
async def api_export_obshiy(request: Request, report_id: int | None = None):
    _auth_or_403(request, state_changing=False)
    rid = _require_report(report_id)
    try:
        content, filename = excel_export.build_obshiy_excel(rid)
    except ModuleNotFoundError as exc:
        log.exception("obshiy excel export dependency missing")
        raise HTTPException(status_code=500, detail=f"excel kutubxonasi topilmadi: {exc.name}")
    except Exception as exc:
        log.exception("obshiy excel export failed: report_id=%s", rid)
        raise HTTPException(status_code=500, detail=f"excel yaratishda xato: {exc}")
    headers = {
        "Content-Disposition": (
            "attachment; "
            f"filename*=UTF-8''{quote(filename)}"
        )
    }
    return StreamingResponse(
        iter([content]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@app.get("/api/export/summary")
async def api_export_summary(request: Request, report_id: int | None = None):
    _auth_or_403(request, state_changing=False)
    rid = _require_report(report_id)
    try:
        content, filename = excel_export.build_umumiy_excel(rid)
    except ModuleNotFoundError as exc:
        log.exception("summary excel export dependency missing")
        raise HTTPException(status_code=500, detail=f"excel kutubxonasi topilmadi: {exc.name}")
    except Exception as exc:
        log.exception("summary excel export failed: report_id=%s", rid)
        raise HTTPException(status_code=500, detail=f"excel yaratishda xato: {exc}")
    headers = {
        "Content-Disposition": (
            "attachment; "
            f"filename*=UTF-8''{quote(filename)}"
        )
    }
    return StreamingResponse(
        iter([content]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@app.post("/api/send-bulk")
async def api_send_bulk(request: Request):
    if not _rate_ok(f"send:{_client_ip(request)}", limit=20, window=60):
        raise HTTPException(status_code=429, detail="too many requests")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json")
    identity = _auth_or_403(request, str(body.get("init_data", "")), state_changing=True)
    rid = _require_report(body.get("report_id"))
    kind = str(body.get("kind", "reys"))
    action = _entry_action(kind)
    mode = str(body.get("mode", "unsent"))
    if mode not in ("unsent", "sent"):
        raise HTTPException(status_code=400, detail="send mode noto'g'ri")
    entry_ids = body.get("entry_ids")
    if entry_ids is not None:
        if not isinstance(entry_ids, list):
            raise HTTPException(status_code=400, detail="entry_ids noto'g'ri")
        count = db.enqueue_selected_send(rid, action, entry_ids)
    else:
        count = db.enqueue_bulk_send(rid, action, mode=mode)
    outbox.notify()
    log.info("channel send queued by %s [r%s %s %s]: %s entries", identity, rid, action, mode, count)
    return {"ok": True, "queued": count}


@app.get("/api/entry/{entry_id}/photo/{idx}")
async def api_entry_photo(request: Request, entry_id: int, idx: int):
    """Serve one persisted photo. Auth via cookie (browser) or the
    X-Telegram-Init-Data header — the client fetches these as blobs."""
    _auth_or_403(request, state_changing=False)
    res = db.photo_file(entry_id, idx)
    if res is not None:
        path, mime = res
        return FileResponse(str(path), media_type=mime,
                            headers={"Cache-Control": "private, max-age=86400"})
    blob = db.photo_data(entry_id, idx)
    if blob is None:
        raise HTTPException(status_code=404, detail="rasm topilmadi")
    data, mime = blob
    return Response(content=data, media_type=mime,
                    headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/inventory")
async def api_inventory(request: Request, report_id: int | None = None):
    _auth_or_403(request, state_changing=False)
    rid = _require_report(report_id)
    return {"inventory": db.get_inventory(rid)}


@app.get("/api/activity")
async def api_activity(request: Request, report_id: int | None = None,
                       start: int | None = None, end: int | None = None):
    identity = _auth_or_403(request, state_changing=False)
    rid = _require_report(report_id)
    return {"activity": db.get_activity(rid, actor=identity, limit=500, ts_from=start, ts_to=end)}


@app.exception_handler(Exception)
async def unhandled(_: Request, exc: Exception):
    log.exception("unhandled error: %s", exc)
    return JSONResponse(status_code=500, content={"ok": False, "detail": "server error"})
