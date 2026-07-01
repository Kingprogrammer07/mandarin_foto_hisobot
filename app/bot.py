"""aiogram 3 bot. Responds only to admins in ADMIN_IDS; opens the Mini App."""
from __future__ import annotations

import logging

from aiogram import Bot, Dispatcher, F
from aiogram.filters import BaseFilter, CommandStart
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    WebAppInfo,
)

from . import config

log = logging.getLogger("reys.bot")


class IsAdmin(BaseFilter):
    """Pass only for users in the admin allow-list."""

    async def __call__(self, message: Message) -> bool:
        return bool(message.from_user) and config.is_admin(message.from_user.id)


dp = Dispatcher()


def _webapp_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[
            InlineKeyboardButton(
                text="📋 Hisobotni ochish",
                web_app=WebAppInfo(url=config.WEBAPP_URL),
            )
        ]]
    )


@dp.message(CommandStart(), IsAdmin())
async def on_start_admin(message: Message) -> None:
    await message.answer(
        "Assalomu alaykum! Hisobotni to'ldirish uchun tugmani bosing 👇",
        reply_markup=_webapp_keyboard(),
    )


# Any other message from an admin → re-show the button.
@dp.message(IsAdmin())
async def on_admin_message(message: Message) -> None:
    await message.answer("Hisobotni ochish:", reply_markup=_webapp_keyboard())


# Non-admins: silently ignore (handler matches everything left).
@dp.message(~IsAdmin())
async def on_non_admin(message: Message) -> None:
    log.info("ignored message from non-admin id=%s", message.from_user.id if message.from_user else "?")
    # No reply — bot only serves admins.


def build_bot() -> Bot:
    return Bot(token=config.BOT_TOKEN)
