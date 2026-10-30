"""Сборка и отправка PDF — общая логика для бота и мини-аппа."""

import asyncio
from datetime import datetime

from aiogram import Bot
from aiogram.types import BufferedInputFile

from .pdf import build_pdf, safe_filename
from .storage import SessionStore
from .title import FontMissing, render_title

TG_UPLOAD_LIMIT = 50 * 1024 * 1024  # ботам нельзя отправлять файлы больше 50 МБ


class BuildError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


_building: set[int] = set()


def is_building() -> bool:
    return bool(_building)


def human_size(n: int) -> str:
    if n < 1024 * 1024:
        return f"{max(n // 1024, 1)} КБ"
    return f"{n / 1024 / 1024:.1f} МБ".replace(".", ",")


async def build_and_send(bot: Bot, store: SessionStore, uid: int) -> tuple[int, int]:
    """Собирает PDF из сессии, отправляет в личку и очищает сессию. Возвращает (страниц, байт)."""
    if uid in _building:
        raise BuildError("PDF уже собирается, секунду…")
    session = store.load(uid)
    if not session.items:
        raise BuildError("Сначала пришли фото или PDF-файлы 📸")

    title = store.load_title(uid)
    if title.enabled and (missing := title.missing()):
        raise BuildError("Для титульного листа не хватает: " + ", ".join(missing) + ".")

    _building.add(uid)
    try:
        prefix = None
        if title.enabled:
            try:
                prefix = await asyncio.to_thread(render_title, title)
            except FontMissing as e:
                raise BuildError("Титульный лист сейчас недоступен: на сервере нет нужного шрифта.") from e
        data, pages = await asyncio.to_thread(build_pdf, store.dir(uid), session.items, session.options, prefix)
        if len(data) > TG_UPLOAD_LIMIT:
            raise BuildError(
                f"Получилось {human_size(len(data))} — больше лимита Telegram в 50 МБ. "
                "Выбери качество «Сжатое» или раздели файлы на две части."
            )
        name = safe_filename(session.options.filename, f"FinConverter {datetime.now():%d.%m %H-%M}")
        await bot.send_document(
            uid,
            BufferedInputFile(data, filename=name),
            caption=f"Готово: {pages} стр., {human_size(len(data))}.\n"
            "Новые фото пойдут в следующий PDF.",
        )
        store.clear(uid)
        if title.enabled:
            # ФИО, группу и дисциплину оставляем, а тема и сам титульник — на одну работу
            title.enabled, title.topic = False, ""
            store.save_title(uid, title)
        return pages, len(data)
    finally:
        _building.discard(uid)
