import hashlib
import hmac
import io
import json
import time
from pathlib import Path
from urllib.parse import urlencode

from PIL import Image, ImageDraw, ImageFont

from app.config import Config

TOKEN = "123:ABC"
FONT = Path("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf")


def config(tmp: Path, **kw) -> Config:
    base = dict(bot_token=TOKEN, webapp_url="", host="", port=0, data_dir=tmp, max_items=20, dev_user_id=None,
                admin_ids=frozenset({7}), ocr_workers=1, ocr_daily_pages=100)
    base.update(kw)
    return Config(**base)


def init_data(uid: int, auth_date: str | None = None, token: str = TOKEN) -> str:
    params = {"auth_date": auth_date or str(int(time.time())), "user": json.dumps({"id": uid})}
    check = "\n".join(f"{k}={v}" for k, v in sorted(params.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    params["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urlencode(params)


def photo(lines: list[str] | None = None, size=(1654, 2339), fmt="JPEG") -> bytes:
    """Страница с печатным текстом (или пустая, если lines не заданы)."""
    img = Image.new("RGB", size, "white")
    if lines:
        font = ImageFont.truetype(str(FONT), 46)
        draw = ImageDraw.Draw(img)
        for i, line in enumerate(lines):
            draw.text((150, 220 + i * 100), line, fill="black", font=font)
    buf = io.BytesIO()
    img.save(buf, fmt)
    return buf.getvalue()
