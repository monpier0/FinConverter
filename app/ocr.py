"""Распознавание печатного текста (Tesseract) и невидимый текстовый слой для страницы PDF.

Сама страница остаётся нашей картинкой (размер файла не растёт), а поверх кладётся прозрачный
текст в тех же местах: по такому PDF работают поиск и копирование.
"""

import csv
import io
import os
import shutil
import subprocess
from dataclasses import dataclass
from io import BytesIO

from PIL import Image
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen.canvas import Canvas

from .title import text_font

LANGS = "rus+eng"
MAX_SIDE = 2400  # распознаём уменьшенную копию: дольше не значит точнее
MIN_CONF = 30  # слова, в которых Tesseract сильно сомневается, в слой не берём
TIMEOUT = 120


class OcrError(Exception):
    pass


@dataclass
class Word:
    text: str
    x: float  # рамка слова в пикселях исходной страницы, от левого верхнего угла
    y: float
    w: float
    h: float


def available() -> bool:
    return shutil.which("tesseract") is not None


def recognize(img: Image.Image) -> list[Word]:
    work = img.convert("L")
    scale = 1.0
    if max(work.size) > MAX_SIDE:
        scale = MAX_SIDE / max(work.size)
        work = work.resize((round(work.width * scale), round(work.height * scale)), Image.Resampling.LANCZOS)
    buf = BytesIO()
    work.save(buf, "PNG")
    try:
        proc = subprocess.run(
            ["tesseract", "stdin", "stdout", "-l", LANGS, "--psm", "3", "tsv"],
            input=buf.getvalue(), capture_output=True, timeout=TIMEOUT,
            # один поток на процесс: число параллельных страниц задаёт очередь, а не OpenMP
            env={**os.environ, "OMP_THREAD_LIMIT": "1"},
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        raise OcrError(str(e)) from e
    if proc.returncode:
        raise OcrError(proc.stderr.decode("utf-8", "replace")[-300:])

    words = []
    rows = csv.DictReader(io.StringIO(proc.stdout.decode("utf-8", "replace")), delimiter="\t", quoting=csv.QUOTE_NONE)
    for row in rows:
        text = (row.get("text") or "").strip()
        if row.get("level") != "5" or not text or float(row["conf"]) < MIN_CONF:
            continue
        words.append(Word(text, int(row["left"]) / scale, int(row["top"]) / scale,
                          int(row["width"]) / scale, int(row["height"]) / scale))
    return words


def text_layer(words: list[Word], size_px: tuple[int, int], dpi: float) -> bytes:
    """Одностраничный PDF того же размера, что и страница, с невидимым текстом на местах слов."""
    k = 72 / dpi  # пиксели → пункты
    width, height = size_px[0] * k, size_px[1] * k
    font = text_font()
    buf = BytesIO()
    c = Canvas(buf, pagesize=(width, height))
    for word in words:
        size = max(word.h * k * 0.85, 1)
        natural = stringWidth(word.text, font, size)
        t = c.beginText()
        t.setTextRenderMode(3)  # невидимый
        t.setFont(font, size)
        if natural:
            t.setHorizScale(word.w * k / natural * 100)  # слово занимает ровно свою рамку
        t.setTextOrigin(word.x * k, height - (word.y + word.h * 0.8) * k)  # базовая линия
        t.textOut(word.text)
        c.drawText(t)
    c.showPage()
    c.save()
    return buf.getvalue()
