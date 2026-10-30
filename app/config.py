import os
import re
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


@dataclass(frozen=True)
class Config:
    bot_token: str
    webapp_url: str  # публичный HTTPS-адрес мини-аппа (Telegram требует https)
    host: str
    port: int
    data_dir: Path
    max_items: int
    dev_user_id: int | None  # для отладки мини-аппа в обычном браузере без Telegram
    proxy: str = ""  # прокси до api.telegram.org, если Telegram недоступен напрямую
    admin_ids: frozenset[int] = frozenset()  # кому можно /update
    max_pages: int = 300  # всего страниц в одном PDF (в PDF-файлах считаются все страницы)
    session_ttl_days: float = 7  # сессии без движения дольше этого срока удаляются
    build_workers: int = 2  # сколько PDF собирается одновременно, остальные ждут
    ocr_workers: int = 2  # сколько страниц одновременно распознаётся; остальные ждут в очереди
    ocr_daily_pages: int = 100  # лимит распознанных страниц в сутки на человека (админам не действует)
    anthropic_api_key: str = ""  # ключ API Claude: с ним распознанный текст проверяется на грамматику и смысл; без него проверки нет
    proofread_model: str = "claude-haiku-5-5"  # лёгкая модель: страница обходится в доли цента


def load_config() -> Config:
    token = os.getenv("BOT_TOKEN", "")
    if not token:
        raise SystemExit("BOT_TOKEN не задан — скопируй .env.example в .env и заполни")
    dev_user = os.getenv("DEV_USER_ID")
    return Config(
        bot_token=token,
        webapp_url=os.getenv("WEBAPP_URL", "").rstrip("/"),
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8080")),
        data_dir=Path(os.getenv("DATA_DIR", ROOT / "data")),
        max_items=int(os.getenv("MAX_ITEMS", "100")),
        dev_user_id=int(dev_user) if dev_user else None,
        proxy=os.getenv("PROXY_URL", "").strip(),
        max_pages=int(os.getenv("MAX_PAGES", "300")),
        session_ttl_days=float(os.getenv("SESSION_TTL_DAYS", "7")),
        build_workers=max(1, int(os.getenv("BUILD_WORKERS", "2"))),
        ocr_workers=max(1, int(os.getenv("OCR_WORKERS", "2"))),
        ocr_daily_pages=int(os.getenv("OCR_DAILY_PAGES", "100")),
        anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", "").strip(),
        proofread_model=os.getenv("PROOFREAD_MODEL", "claude-haiku-5-5").strip() or "claude-haiku-5-5",
        admin_ids=frozenset(int(x) for x in re.split(r"[,\s]+", os.getenv("ADMIN_IDS", "")) if x.isdigit()),
    )
