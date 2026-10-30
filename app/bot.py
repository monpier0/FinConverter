import asyncio
import os
from html import escape
from io import BytesIO

from aiogram import Bot, F, Router
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    WebAppInfo,
)

from . import updater
from .config import Config
from .pdf import safe_filename
from .service import BuildError, build_and_send, is_building
from .storage import SessionStore, TooManyItems, UnsupportedFile

router = Router()

CLOSED = "Бот пока работает в закрытом режиме."


async def admin_only(handler, event: Message | CallbackQuery, data: dict):
    """Пока бот закрытый: все сообщения и нажатия от тех, кого нет в ADMIN_IDS, не доходят до хендлеров."""
    cfg: Config = data["cfg"]
    uid = data["event_from_user"].id
    if uid in cfg.admin_ids:
        return await handler(event, data)
    if isinstance(event, CallbackQuery):
        await event.answer(CLOSED, show_alert=True)
    elif cfg.admin_ids:
        await event.answer(CLOSED)
    else:  # ADMIN_IDS не задан: никого не пускаем, но подсказываем владельцу его id
        await event.answer(f"{CLOSED} Чтобы открыть доступ себе, впиши свой id в ADMIN_IDS: <code>{uid}</code>")


router.message.outer_middleware(admin_only)
router.callback_query.outer_middleware(admin_only)

TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024  # Bot API отдаёт ботам файлы до 20 МБ
STATUS_DELAY = 1.2  # ждём, пока догрузится весь альбом, и отвечаем одним сообщением


def session_keyboard(cfg: Config, count: int) -> InlineKeyboardMarkup:
    rows = [[InlineKeyboardButton(text=f"Собрать PDF ({count} стр.)", callback_data="build")]]
    if cfg.webapp_url:
        rows.append([InlineKeyboardButton(text="Порядок, титульный лист, настройки",
                                          web_app=WebAppInfo(url=cfg.webapp_url))])
    rows.append([InlineKeyboardButton(text="Начать заново", callback_data="clear")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


class StatusNotifier:
    """Одно обновляемое сообщение «Добавлено N» вместо ответа на каждое фото."""

    def __init__(self):
        self._tasks: dict[int, asyncio.Task] = {}
        self._last_msg: dict[int, int] = {}

    def schedule(self, bot: Bot, cfg: Config, store: SessionStore, uid: int) -> None:
        if task := self._tasks.get(uid):
            task.cancel()
        self._tasks[uid] = asyncio.create_task(self._send(bot, cfg, store, uid))

    def forget(self, uid: int) -> None:
        self._last_msg.pop(uid, None)

    async def _send(self, bot: Bot, cfg: Config, store: SessionStore, uid: int) -> None:
        await asyncio.sleep(STATUS_DELAY)
        session = store.load(uid)
        count = sum(i.pages for i in session.items)
        if not count:
            return
        title = store.load_title(uid)
        count += title.enabled
        if old := self._last_msg.pop(uid, None):
            try:
                await bot.delete_message(uid, old)
            except Exception:
                pass
        lines = [f"В PDF {count} стр."]
        if title.enabled:
            lines.append(f"Титульный лист: {escape(title.work_type.lower())}, {escape(title.student or 'ФИО не указано')}")
        if session.options.filename:
            lines.append(f"Файл: <b>{escape(safe_filename(session.options.filename, ''))}</b>")
        lines.append("\nМожно прислать ещё фото. Текстовое сообщение станет названием файла.")
        msg = await bot.send_message(uid, "\n".join(lines), reply_markup=session_keyboard(cfg, count))
        self._last_msg[uid] = msg.message_id


@router.message(CommandStart())
@router.message(Command("help"))
async def cmd_start(message: Message, cfg: Config):
    kb = None
    if cfg.webapp_url:
        kb = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="Открыть редактор", web_app=WebAppInfo(url=cfg.webapp_url))
        ]])
    await message.answer(
        "<b>FinConverter</b> собирает фото конспектов, сканы и PDF в один файл.\n\n"
        "Пришли фото: по одному, альбомом или файлом (файлом качество выше). "
        "Порядок страниц, поворот, режим «Скан» и титульный лист настраиваются в редакторе.\n\n"
        "/pdf — собрать файл\n/title — титульный лист\n/ocr — распознавание текста\n/clear — начать заново",
        reply_markup=kb,
    )


async def _add(message: Message, bot: Bot, cfg: Config, store: SessionStore, notifier: StatusNotifier,
               file_id: str, size: int | None, kind: str, name: str = "") -> None:
    uid = message.from_user.id
    if size and size > TG_DOWNLOAD_LIMIT:
        await message.reply("Файл больше 20 МБ — Telegram не даёт ботам скачивать такие. Попробуй сжать его.")
        return
    buf = BytesIO()
    await bot.download(file_id, destination=buf)
    try:
        store.add(uid, buf.getvalue(), kind, name)
    except TooManyItems:
        await message.reply(f"Максимум {cfg.max_items} файлов в одном PDF. Собери этот и начни следующий.")
        return
    except UnsupportedFile:
        await message.reply("Не получилось открыть файл. Подходят JPG, PNG, HEIC и PDF.")
        return
    notifier.schedule(bot, cfg, store, uid)


@router.message(F.photo)
async def on_photo(message: Message, bot: Bot, cfg: Config, store: SessionStore, notifier: StatusNotifier):
    photo = message.photo[-1]
    await _add(message, bot, cfg, store, notifier, photo.file_id, photo.file_size, "image")


@router.message(F.document)
async def on_document(message: Message, bot: Bot, cfg: Config, store: SessionStore, notifier: StatusNotifier):
    doc = message.document
    mime = doc.mime_type or ""
    name = (doc.file_name or "").lower()
    if mime == "application/pdf" or name.endswith(".pdf"):
        kind = "pdf"
    elif mime.startswith("image/") or name.endswith((".heic", ".heif")):
        kind = "image"
    else:
        await message.reply("Подходят только фото и PDF.")
        return
    await _add(message, bot, cfg, store, notifier, doc.file_id, doc.file_size, kind, doc.file_name or "")


@router.message(Command("pdf"))
async def cmd_pdf(message: Message, bot: Bot, cfg: Config, store: SessionStore, notifier: StatusNotifier):
    await _build(message, bot, cfg, store, notifier, message.from_user.id)


@router.callback_query(F.data == "build")
async def cb_build(call: CallbackQuery, bot: Bot, cfg: Config, store: SessionStore, notifier: StatusNotifier):
    await call.answer("Собираю…")
    await call.message.edit_reply_markup(reply_markup=None)
    await _build(call.message, bot, cfg, store, notifier, call.from_user.id)


async def _build(message: Message, bot: Bot, cfg: Config, store: SessionStore, notifier: StatusNotifier, uid: int):
    progress = await message.answer("Собираю PDF…")

    async def status(text: str) -> None:  # очередь и ход распознавания показываем в этом же сообщении
        await progress.edit_text(text)

    try:
        await bot.send_chat_action(uid, "upload_document")
        await build_and_send(bot, store, uid, cfg, status)
        notifier.forget(uid)
    except BuildError as e:
        await message.answer(e.message)
    finally:
        await progress.delete()


_updating = False


@router.message(Command("update"))
async def cmd_update(message: Message, cfg: Config):
    global _updating
    uid = message.from_user.id
    if not updater.available():
        await message.answer("Обновление недоступно: код запущен не из git-клона. Смонтируй клон в /app (см. README).")
        return
    if _updating or is_building():
        await message.answer("Сейчас идёт сборка или обновление, повтори через минуту.")
        return

    _updating = True
    progress = await message.answer("Проверяю обновления…")
    try:
        commits = await updater.update()
        if not commits:
            await progress.edit_text(f"Уже последняя версия: <code>{escape(await updater.version())}</code>")
            return
        updater.mark_restart(cfg.data_dir, uid)
        await progress.edit_text("Обновлено, перезапускаюсь…\n<pre>" + escape("\n".join(commits)) + "</pre>")
    except updater.UpdateError as e:
        await progress.edit_text(f"Не удалось обновить:\n<pre>{escape(str(e))}</pre>")
        return
    finally:
        _updating = False
    await asyncio.sleep(2)  # Telegram должен успеть подтвердить саму команду, иначе после старта она придёт снова
    os._exit(0)  # дальше Docker (restart policy) поднимает бота уже с новым кодом


@router.message(Command("ocr"))
async def cmd_ocr(message: Message, cfg: Config, store: SessionStore):
    uid = message.from_user.id
    session = store.load(uid)
    session.options.ocr = not session.options.ocr
    store.set_options(uid, session.options)
    if session.options.ocr:
        limit = "" if uid in cfg.admin_ids or not cfg.ocr_daily_pages else f" Лимит: {cfg.ocr_daily_pages} стр. в сутки."
        await message.answer("Распознавание текста включено: в следующем PDF текст можно будет искать и копировать. "
                             "Работает на печатном тексте, рукописный читается плохо. Сборка станет дольше." + limit)
    else:
        await message.answer("Распознавание текста выключено.")


@router.message(Command("clear"))
async def cmd_clear(message: Message, store: SessionStore, notifier: StatusNotifier):
    store.clear(message.from_user.id)
    notifier.forget(message.from_user.id)
    await message.answer("Очистил. Можно присылать новые фото.")


@router.callback_query(F.data == "clear")
async def cb_clear(call: CallbackQuery, store: SessionStore, notifier: StatusNotifier):
    store.clear(call.from_user.id)
    notifier.forget(call.from_user.id)
    await call.answer("Очищено")
    await call.message.edit_text("Очистил. Можно присылать новые фото.")


@router.message(F.text & ~F.text.startswith("/"))
async def on_text(message: Message, bot: Bot, cfg: Config, store: SessionStore, notifier: StatusNotifier):
    uid = message.from_user.id
    session = store.load(uid)
    if not session.items:
        await message.answer("Пришли фото или PDF, и я соберу из них один файл.")
        return
    session.options.filename = message.text.strip()[:80]
    store.set_options(uid, session.options)
    notifier.schedule(bot, cfg, store, uid)


def title_summary(store: SessionStore, uid: int) -> str:
    t = store.load_title(uid)
    if not (t.student or t.discipline):
        return "Титульный лист ещё не заполнен. Заполни его в редакторе один раз: ФИО и группа запомнятся."
    rows = [
        f"Тип: {t.work_type}",
        f"Дисциплина: {t.discipline or '—'}",
        f"Тема: {t.topic or '—'}",
        f"{t.student_label}: {t.student or '—'}, гр. {t.group or '—'}",
        f"Проверил(а): {t.teacher or '—'}",
    ]
    state = "будет добавлен в следующий PDF" if t.enabled else "выключен"
    return f"<b>Титульный лист</b> — {state}\n\n" + escape("\n".join(rows))


def title_keyboard(cfg: Config, enabled: bool) -> InlineKeyboardMarkup:
    rows = [[InlineKeyboardButton(text="Выключить" if enabled else "Добавить в PDF",
                                  callback_data="title_off" if enabled else "title_on")]]
    if cfg.webapp_url:
        rows.append([InlineKeyboardButton(text="Изменить в редакторе", web_app=WebAppInfo(url=cfg.webapp_url))])
    return InlineKeyboardMarkup(inline_keyboard=rows)


@router.message(Command("title"))
async def cmd_title(message: Message, cfg: Config, store: SessionStore):
    uid = message.from_user.id
    await message.answer(title_summary(store, uid), reply_markup=title_keyboard(cfg, store.load_title(uid).enabled))


@router.callback_query(F.data.in_({"title_on", "title_off"}))
async def cb_title(call: CallbackQuery, cfg: Config, store: SessionStore):
    uid = call.from_user.id
    title = store.load_title(uid)
    title.enabled = call.data == "title_on"
    if title.enabled and (missing := title.missing()):
        await call.answer("Не хватает: " + ", ".join(missing) + ". Заполни в редакторе.", show_alert=True)
        return
    store.save_title(uid, title)
    await call.answer()
    await call.message.edit_text(title_summary(store, uid), reply_markup=title_keyboard(cfg, title.enabled))
