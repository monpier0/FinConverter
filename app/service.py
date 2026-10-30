"""Сборка и отправка PDF — общая логика для бота и мини-аппа."""

import asyncio
import time
from contextlib import asynccontextmanager
from datetime import date, datetime
from typing import Awaitable, Callable

from aiogram import Bot
from aiogram.types import BufferedInputFile

from . import ocr
from .config import Config
from .pdf import build_pdf, safe_filename
from .storage import SessionStore
from .title import FontMissing, render_title

TG_UPLOAD_LIMIT = 50 * 1024 * 1024  # ботам нельзя отправлять файлы больше 50 МБ
STATUS_EVERY = 2.0  # не чаще, чем раз в столько секунд, обновляем сообщение о прогрессе (лимиты Telegram)

Status = Callable[[str], Awaitable[None]]


class BuildError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


_building: set[int] = set()
_ocr_slots: asyncio.Semaphore | None = None
_ocr_waiting = 0


def is_building() -> bool:
    return bool(_building)


def human_size(n: int) -> str:
    if n < 1024 * 1024:
        return f"{max(n // 1024, 1)} КБ"
    return f"{n / 1024 / 1024:.1f} МБ".replace(".", ",")


@asynccontextmanager
async def _ocr_turn(cfg: Config, say: Status):
    """Очередь на распознавание: одновременно работают cfg.ocr_workers сборок, остальные ждут."""
    global _ocr_slots, _ocr_waiting
    if _ocr_slots is None:
        _ocr_slots = asyncio.Semaphore(cfg.ocr_workers)
    if _ocr_slots.locked():
        _ocr_waiting += 1
        try:
            await say(f"Распознавание сейчас занято, ты в очереди: {_ocr_waiting}-й. Это займёт несколько минут.")
            await _ocr_slots.acquire()
        finally:
            _ocr_waiting -= 1
    else:
        await _ocr_slots.acquire()
    try:
        yield
    finally:
        _ocr_slots.release()


async def build_and_send(bot: Bot, store: SessionStore, uid: int, cfg: Config,
                         on_status: Status | None = None) -> tuple[int, int]:
    """Собирает PDF из сессии, отправляет в личку и очищает сессию. Возвращает (страниц, байт).
    on_status получает тексты про очередь и прогресс распознавания."""
    if uid in _building:
        raise BuildError("PDF уже собирается, секунду…")
    session = store.load(uid)
    if not session.items:
        raise BuildError("Сначала пришли фото или PDF-файлы.")

    title = store.load_title(uid)
    if title.enabled and (missing := title.missing()):
        raise BuildError("Для титульного листа не хватает: " + ", ".join(missing) + ".")

    async def say(text: str) -> None:
        if on_status:
            try:
                await on_status(text)
            except Exception:  # сообщение могло быть удалено или не изменилось, сборке это не мешает
                pass

    # распознаём только фото; PDF-файлы остаются как есть
    ocr_pages = sum(1 for i in session.items if i.kind == "image") if session.options.ocr else 0
    today = date.today().isoformat()
    if ocr_pages:
        if not ocr.available():
            raise BuildError("Распознавание текста сейчас недоступно на сервере. Собери PDF без него.")
        if cfg.ocr_daily_pages and uid not in cfg.admin_ids:
            left = max(cfg.ocr_daily_pages - store.ocr_used(uid, today), 0)
            if ocr_pages > left:
                raise BuildError(
                    f"Распознавание: {ocr_pages} стр., а на сегодня осталось {left} из {cfg.ocr_daily_pages}. "
                    "Выключи распознавание или убери лишние страницы."
                )

    _building.add(uid)
    try:
        prefix = None
        if title.enabled:
            try:
                prefix = await asyncio.to_thread(render_title, title)
            except FontMissing as e:
                raise BuildError("Титульный лист сейчас недоступен: на сервере нет нужного шрифта.") from e

        loop = asyncio.get_running_loop()
        last = 0.0

        def progress(done: int, total: int) -> None:  # вызывается из рабочего потока
            nonlocal last
            if time.monotonic() - last >= STATUS_EVERY or done == total:
                last = time.monotonic()
                asyncio.run_coroutine_threadsafe(say(f"Распознаю текст: {done} из {total} стр."), loop)

        args = (store.dir(uid), session.items, session.options, prefix, progress if ocr_pages else None)
        if ocr_pages:
            async with _ocr_turn(cfg, say):
                data, pages = await asyncio.to_thread(build_pdf, *args)
        else:
            data, pages = await asyncio.to_thread(build_pdf, *args)

        if len(data) > TG_UPLOAD_LIMIT:
            raise BuildError(
                f"Получилось {human_size(len(data))} — больше лимита Telegram в 50 МБ. "
                "Выбери качество «Сжатое» или раздели файлы на две части."
            )
        name = safe_filename(session.options.filename, f"FinConverter {datetime.now():%d.%m %H-%M}")
        caption = f"Готово: {pages} стр., {human_size(len(data))}.\n"
        caption += "Текст в PDF можно искать и копировать.\n" if ocr_pages else ""
        await bot.send_document(
            uid,
            BufferedInputFile(data, filename=name),
            caption=caption + "Новые фото пойдут в следующий PDF.",
        )
        if ocr_pages:
            store.ocr_add(uid, today, ocr_pages)
        store.clear(uid)
        if title.enabled:
            # ФИО, группу и дисциплину оставляем, а тема и сам титульник — на одну работу
            title.enabled, title.topic = False, ""
            store.save_title(uid, title)
        return pages, len(data)
    finally:
        _building.discard(uid)
