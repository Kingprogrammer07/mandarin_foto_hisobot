"""Optional background task queue using arq / Redis with transparent local fallback.

When REDIS_URL is configured, tasks can be distributed across workers.
When REDIS_URL is not set or Redis is unavailable, tasks fall back to the in-process
asyncio event loop and outbox worker without disruption.
"""
from __future__ import annotations

import logging
from typing import Any

from . import config, outbox

log = logging.getLogger("reys.queue")

_arq_pool = None


async def get_redis_pool():
    global _arq_pool
    if not config.redis_enabled():
        return None
    if _arq_pool is None:
        try:
            from arq import create_pool
            from arq.connections import RedisSettings

            _arq_pool = await create_pool(RedisSettings.from_dsn(config.REDIS_URL))
            log.info("connected to Redis queue at %s", config.REDIS_URL)
        except Exception as exc:
            log.warning("failed to connect to Redis (%s), falling back to in-process outbox", exc)
            _arq_pool = None
    return _arq_pool


async def close_redis_pool() -> None:
    global _arq_pool
    if _arq_pool is not None:
        try:
            await _arq_pool.close()
        except Exception:
            pass
        _arq_pool = None


async def dispatch_send(entry_id: int | None = None) -> None:
    """Notify the outbox system that a new job is available.
    Dispatches to Redis/arq if available, and pokes the in-process outbox worker.
    """
    # 1. Poke the local in-process outbox
    outbox.notify()

    # 2. If Redis is configured, enqueue to arq
    if config.redis_enabled():
        try:
            pool = await get_redis_pool()
            if pool:
                if entry_id is not None:
                    await pool.enqueue_job("send_entry_task", entry_id)
                else:
                    await pool.enqueue_job("drain_outbox_task")
        except Exception as exc:
            log.warning("redis dispatch failed (%s), relying on in-process outbox", exc)


async def send_entry_task(ctx: dict[str, Any], entry_id: int) -> None:
    """Arq task to send one entry."""
    outbox.notify()


async def drain_outbox_task(ctx: dict[str, Any]) -> None:
    """Arq task to drain outbox."""
    outbox.notify()


def _get_worker_redis_settings():
    from arq.connections import RedisSettings
    if config.redis_enabled():
        return RedisSettings.from_dsn(config.REDIS_URL)
    return RedisSettings()


class WorkerSettings:
    """Settings class for running standalone `arq app.queue.WorkerSettings`."""
    functions = [send_entry_task, drain_outbox_task]
    redis_settings = _get_worker_redis_settings()

