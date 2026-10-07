"""Durable Telegram sender.

Saved entries are enqueued in SQLite `send_queue`. A single background worker
drains the queue and forwards photos + caption to the configured Telegram
channel for that entry type. Pending sends survive process restarts and retry
forever with backoff.
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

_BACKOFF = [5, 15, 30, 60, 120, 300, 600, 900]
_OBSHIY_TITLES = {
    "top": "Top",
    "topchiqgan": "Topdan chiqgan",
    "bizda": "Bizda qoladigan",
    "chiqgan": "Bizdan chiqgan",
}


def set_bot(bot) -> None:
    global _bot
    _bot = bot


def notify() -> None:
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
    action = entry["action"]
    if action in _OBSHIY_TITLES:
        head = f"{name} - {_OBSHIY_TITLES[action]}"
        code = (entry.get("tovar_turi") or "").strip()
        coef = float(entry.get("coefficient") or 0)
        net = entry.get("net")
        if net is None:
            net = float(entry.get("weight") or 0) - coef
        weight = f"{_fmt(entry.get('weight'))} - {_fmt(coef)} = {_fmt(net)}" if coef else _fmt(entry.get("weight"))
        body = f"{code + ' - ' if code else ''}{weight} kg"
    elif action == "adjust":
        head = f"{name} - {entry['from_type']} -> {entry['to_type']}"
        body = f"{_fmt(entry['weight'])} kg"
    else:
        coef = float(entry.get("coefficient") or 0)
        net = entry.get("net")
        if net is None:
            net = float(entry.get("weight") or 0) - coef
        head = f"{name} - {entry.get('tovar_turi') or ''}"
        body = f"{_fmt(entry.get('weight'))} - {_fmt(coef)} = {_fmt(net)} kg"
    return f"{head}\n\n{body}"


async def _remember_telegram_photo(entry_id: int, idx: int, message) -> None:
    photos = getattr(message, "photo", None) or []
    if not photos:
        return
    photo = photos[-1]
    await db.mark_photo_telegram(
        entry_id,
        idx,
        getattr(photo, "file_id", None),
        getattr(photo, "file_unique_id", None),
        getattr(message, "message_id", None),
    )


async def _send_one(entry_id: int) -> None:
    entry = await db.get_entry_any(entry_id)
    if entry is None:
        await db.mark_send_canceled(entry_id)
        return
    chat = config.channel_for_action(entry["action"])
    if chat is None:
        raise RuntimeError(f"channel not configured for {entry['action']}")

    caption = _caption(entry, await db.report_name(entry["report_id"]) or "")
    blobs = await db.photo_blobs(entry_id)

    if not blobs:
        await _bot.send_message(chat, caption)
    elif len(blobs) == 1:
        data, _mime = blobs[0]
        msg = await _bot.send_photo(chat, BufferedInputFile(data, filename="photo.jpg"), caption=caption)
        await _remember_telegram_photo(entry_id, 0, msg)
    else:
        media = [
            InputMediaPhoto(
                media=BufferedInputFile(data, filename=f"photo_{i}.jpg"),
                caption=caption if i == 0 else None,
            )
            for i, (data, _mime) in enumerate(blobs)
        ]
        messages = await _bot.send_media_group(chat, media)
        for i, msg in enumerate(messages or []):
            await _remember_telegram_photo(entry_id, i, msg)


async def worker() -> None:
    global _wake
    _wake = asyncio.Event()
    log.info("outbox worker started (pending=%s)", await db.pending_send_count())
    while True:
        if _bot is None:
            await asyncio.sleep(5)
            continue

        now = int(time.time())
        job = await db.next_send_job(now)
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
            await db.mark_sent(entry_id)
            log.info("channel send ok: entry=%s", entry_id)
        except Exception as exc:  # noqa: BLE001
            attempts = job["attempts"] + 1
            retry_after = getattr(exc, "retry_after", None)
            delay = int(retry_after) if retry_after else _BACKOFF[min(attempts - 1, len(_BACKOFF) - 1)]
            await db.mark_send_retry(entry_id, attempts, now + delay, str(exc))
            log.warning("channel send failed: entry=%s attempt=%s err=%s retry_in=%ss",
                        entry_id, attempts, exc, delay)
            await asyncio.sleep(1)


def ensure_started() -> None:
    global _started
    if _started:
        return
    _started = True
    asyncio.create_task(worker())


async def send_filtered_to_channel(channel_id: str | int, entries: list[dict]) -> dict:
    """Forward a list of matching entries (photos + caption) to a specified Telegram channel."""
    global _bot
    if _bot is None:
        log.error("send_filtered_to_channel: bot is not initialized")
        return {"ok": False, "sent": 0, "errors": len(entries), "total": len(entries)}

    chat = config._parse_chat_id(str(channel_id))
    if chat is None:
        log.error("send_filtered_to_channel: invalid channel id %s", channel_id)
        return {"ok": False, "sent": 0, "errors": len(entries), "total": len(entries)}

    sent_count = 0
    errors = 0

    log.info("Starting filtered send to channel %s for %d entries", chat, len(entries))
    for entry in entries:
        report_name = entry.get("report_name") or await db.report_name(entry.get("report_id", 0)) or ""
        caption = _caption(entry, report_name)
        blobs = await db.photo_blobs(entry["id"])

        success = False
        for attempt in range(3):
            try:
                if not blobs:
                    await _bot.send_message(chat, caption)
                elif len(blobs) == 1:
                    data, _mime = blobs[0]
                    await _bot.send_photo(
                        chat,
                        BufferedInputFile(data, filename="photo.jpg"),
                        caption=caption,
                    )
                else:
                    media = [
                        InputMediaPhoto(
                            media=BufferedInputFile(data, filename=f"photo_{i}.jpg"),
                            caption=caption if i == 0 else None,
                        )
                        for i, (data, _mime) in enumerate(blobs)
                    ]
                    await _bot.send_media_group(chat, media)
                success = True
                sent_count += 1
                await asyncio.sleep(0.4)
                break
            except Exception as exc:  # noqa: BLE001
                retry_after = getattr(exc, "retry_after", None)
                if retry_after:
                    delay = float(retry_after) + 0.5
                    log.warning("Telegram flood limit hit on channel %s, waiting %s seconds", chat, delay)
                    await asyncio.sleep(delay)
                elif attempt < 2:
                    await asyncio.sleep(1.0)
                else:
                    log.error("Failed to send entry %s to channel %s: %s", entry.get("id"), chat, exc)

        if not success:
            errors += 1

    log.info("Filtered send finished to channel %s: %d sent, %d errors out of %d",
             chat, sent_count, errors, len(entries))
    return {"ok": True, "sent": sent_count, "errors": errors, "total": len(entries)}

