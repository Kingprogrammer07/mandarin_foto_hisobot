"""Run the FastAPI server and the aiogram bot together in one event loop.

    python -m app
"""
from __future__ import annotations

import asyncio
import logging

import uvicorn

from . import config
from .bot import build_bot, dp
from .server import app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("reys")


async def main() -> None:
    config.require_config()

    bot = build_bot()

    server = uvicorn.Server(
        uvicorn.Config(app, host=config.HOST, port=config.PORT, log_level="info")
    )

    log.info("starting server on %s:%s and bot polling", config.HOST, config.PORT)
    log.info("admins: %s", sorted(config.ADMIN_IDS))

    await asyncio.gather(
        server.serve(),
        dp.start_polling(bot, handle_signals=False),
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        log.info("shutting down")
