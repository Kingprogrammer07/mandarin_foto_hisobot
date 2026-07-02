"""Durable Telegram sender.

Every saved reys/adashgan entry is enqueued in the SQLite `send_queue`. A single
background worker drains it, forwarding photos + caption to the kargo channel.
Because the queue is on disk, a pending send survives a process restart, and a
failed send (channel/Telegram/internet down) is retried with backoff forever —
so once an entry reaches the server it is never lost.
"""
from __future__ import annotations

import asyncio
import logging
import time

from aiogram.types import BufferedInputFile, InputMediaPhoto

from . import config, db

log = logging.getLogger("reys.outbox")

_bot = None
_wake: asyncio.Event | None = None
_started = False

# Retry backoff (seconds) indexed by attempt; caps at the last value. Sends are
# retried indefinitely — the data stays queued until it is delivered.
_BACKOFF = [5, 15, 30, 60, 120, 300, 600, 900]


def set_bot(bot) -> None:
    global _bot
    _bot = bot


def notify() -> None:
    """Wake the worker to process a freshly-enqueued job (best effort)."""
    if _wake is not None:
        try:
            _wake.set()
        except RuntimeError:
            pass


def _fmt(v) -> str:
    try:
        return f"{round(float(v or 0), 2):g}"
    except (TypeError, ValueError):
        return "0"


def _caption(entry: dict, report_name: str) -> str:
    name = report_name or "Hisobot"
    if entry["action"] == "adjust":
        head = f"{name} - {entry['from_type']} → {entry['to_type']}"
        body = f"{_fmt(entry['weight'])} kg"
    else:
        coef = float(entry.get("coefficient") or 0)
        net = entry.get("net")
        if net is None:
            net = float(entry.get("weight") or 0) - coef
        head = f"{name} - {entry.get('tovar_turi') or ''}"
        body = f"{_fmt(entry.get('weight'))} - {_fmt(coef)} = {_fmt(net)} kg"
    return f"{head}\n\n{body}"


async def _send_one(entry_id: int) -> None:
    entry = db.get_entry_any(entry_id)
    if entry is None:
        db.mark_sent(entry_id)  # entry was deleted → nothing to send, drop it
        return
    caption = _caption(entry, db.report_name(entry["report_id"]) or "")
    blobs = db.photo_blobs(entry_id)
    chat = config.KARGO_CHANNEL_ID

    if not blobs:
        await _bot.send_message(chat, caption)
    elif len(blobs) == 1:
        data, _mime = blobs[0]
        await _bot.send_photo(chat, BufferedInputFile(data, filename="photo.jpg"), caption=caption)
    else:
        media = [
            InputMediaPhoto(
                media=BufferedInputFile(data, filename=f"photo_{i}.jpg"),
                caption=caption if i == 0 else None,
            )
            for i, (data, _mime) in enumerate(blobs)
        ]
        await _bot.send_media_group(chat, media)


async def worker() -> None:
    global _wake
    _wake = asyncio.Event()
    log.info("outbox worker started (pending=%s)", db.pending_send_count())
    while True:
        # No bot / channel configured (e.g. a `uvicorn app.server:app` preview) →
        # idle without draining, so entries stay queued for the real process.
        if _bot is None or config.KARGO_CHANNEL_ID is None:
            await asyncio.sleep(5)
            continue

        now = int(time.time())
        job = db.next_send_job(now)
        if job is None:
            _wake.clear()
            try:
                await asyncio.wait_for(_wake.wait(), timeout=15)
            except asyncio.TimeoutError:
                pass
            continue

        entry_id = job["entry_id"]
        try:
            await _send_one(entry_id)
            db.mark_sent(entry_id)
            log.info("channel send ok: entry=%s", entry_id)
        except Exception as exc:  # noqa: BLE001 — keep the worker alive on any failure
            attempts = job["attempts"] + 1
            retry_after = getattr(exc, "retry_after", None)
            delay = int(retry_after) if retry_after else _BACKOFF[min(attempts - 1, len(_BACKOFF) - 1)]
            db.mark_send_retry(entry_id, attempts, now + delay, str(exc))
            log.warning("channel send failed: entry=%s attempt=%s err=%s retry_in=%ss",
                        entry_id, attempts, exc, delay)
            await asyncio.sleep(1)  # don't hot-loop on a persistent error


def ensure_started() -> None:
    """Start the worker task once (call from within the running event loop)."""
    global _started
    if _started:
        return
    _started = True
    asyncio.create_task(worker())
