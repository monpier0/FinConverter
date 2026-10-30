import asyncio
import logging
from html import escape

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.enums import ParseMode
from aiogram.types import BotCommand, MenuButtonWebApp, WebAppInfo
from aiohttp import web

from . import updater
from .bot import StatusNotifier, router
from .config import load_config
from .storage import SessionStore
from .web import create_app


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = load_config()
    store = SessionStore(cfg.data_dir, cfg.max_items)
    session = AiohttpSession(proxy=cfg.proxy) if cfg.proxy else None
    bot = Bot(cfg.bot_token, session=session, default=DefaultBotProperties(parse_mode=ParseMode.HTML))

    dp = Dispatcher(cfg=cfg, store=store, notifier=StatusNotifier())
    dp.include_router(router)

    await bot.set_my_commands([
        BotCommand(command="pdf", description="Собрать PDF"),
        BotCommand(command="title", description="Титульный лист"),
        BotCommand(command="clear", description="Начать заново"),
        BotCommand(command="help", description="Как пользоваться"),
    ])
    if cfg.webapp_url.startswith("https://"):
        await bot.set_chat_menu_button(
            menu_button=MenuButtonWebApp(text="Редактор", web_app=WebAppInfo(url=cfg.webapp_url))
        )

    runner = web.AppRunner(create_app(cfg, store, bot))
    await runner.setup()
    await web.TCPSite(runner, cfg.host, cfg.port).start()
    logging.info("Mini app: http://%s:%s (public: %s)", cfg.host, cfg.port, cfg.webapp_url or "не задан")

    if uid := updater.pop_restart(cfg.data_dir):  # перезапуск после /update — сообщаем, что всё поднялось
        try:
            await bot.send_message(uid, f"Бот перезапущен. Версия: <code>{escape(await updater.version())}</code>")
        except Exception:
            logging.exception("Не удалось сообщить об обновлении")

    try:
        await dp.start_polling(bot)
    finally:
        await runner.cleanup()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
