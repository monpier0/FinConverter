import os
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
    )
