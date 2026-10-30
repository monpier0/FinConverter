"""Сборка PDF из фото и PDF-файлов."""

import re
from dataclasses import dataclass, fields
from io import BytesIO
from pathlib import Path
from typing import IO, Iterable

from PIL import Image, ImageChops, ImageEnhance, ImageFilter, ImageOps
from pypdf import PdfReader, PdfWriter

try:  # фото с iPhone, отправленные файлом, приходят в HEIC
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:
    pass

A4_INCHES = (8.27, 11.69)

# длинная сторона страницы в пикселях и качество JPEG
QUALITY = {
    "high": (3508, 90),  # ~300 dpi на A4
    "medium": (2339, 80),  # ~200 dpi
    "low": (1600, 65),  # ~135 dpi, для порталов с лимитом на размер
}


@dataclass
class BuildOptions:
    page: str = "original"  # "original" | "a4"
    mode: str = "color"  # "color" | "gray" | "scan"
    quality: str = "medium"  # "high" | "medium" | "low"
    filename: str = ""

    @classmethod
    def from_dict(cls, raw: dict) -> "BuildOptions":
        opts = cls(**{f.name: raw[f.name] for f in fields(cls) if f.name in raw})
        if opts.page not in ("original", "a4"):
            opts.page = "original"
        if opts.mode not in ("color", "gray", "scan"):
            opts.mode = "color"
        if opts.quality not in QUALITY:
            opts.quality = "medium"
        opts.filename = str(opts.filename)[:80]
        return opts


def open_image(fp: IO[bytes] | Path) -> Image.Image:
    img = Image.open(fp)
    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA", "P"):
        # прозрачность (PNG-скриншоты) кладём на белый фон, а не на чёрный
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, "white")
        bg.paste(img, mask=img.getchannel("A"))
        return bg
    return img.convert("RGB")


def pdf_page_count(path: Path) -> int:
    return len(PdfReader(path).pages)


def safe_filename(name: str, fallback: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\n\r\t]+', " ", name).strip().strip(".")
    name = name.removesuffix(".pdf").removesuffix(".PDF").strip()
    return f"{name or fallback}.pdf"


def _apply_mode(img: Image.Image, mode: str) -> Image.Image:
    if mode == "gray":
        return ImageOps.grayscale(img)
    if mode == "scan":
        # «скан»: серый, выравниваем фон под белый и поднимаем контраст текста
        gray = ImageOps.grayscale(img)
        # убираем тени и неравномерный свет: вычитаем сильно размытую копию (это «бумага»),
        # так фон становится ровно белым, а текст остаётся тёмным
        bg = gray.filter(ImageFilter.GaussianBlur(radius=max(gray.size) // 40 or 1))
        flat = ImageChops.add(gray, ImageOps.invert(bg))
        flat = ImageOps.autocontrast(flat, cutoff=1)
        flat = ImageEnhance.Contrast(flat).enhance(1.4)
        return flat.filter(ImageFilter.UnsharpMask(radius=1.5, percent=80, threshold=2))
    return img


def _render_page(img: Image.Image, rotation: int, opts: BuildOptions) -> tuple[Image.Image, float]:
    """Возвращает готовую картинку страницы и dpi, с которым её нужно положить в PDF."""
    if rotation:
        img = img.rotate(-rotation, expand=True)  # PIL крутит против часовой
    img = _apply_mode(img, opts.mode)
    max_side, _ = QUALITY[opts.quality]

    if opts.page == "a4":
        landscape = img.width > img.height
        w_in, h_in = (A4_INCHES[1], A4_INCHES[0]) if landscape else A4_INCHES
        dpi = max_side / h_in if not landscape else max_side / w_in
        canvas_size = (round(w_in * dpi), round(h_in * dpi))
        margin = round(0.4 * dpi)  # ~1 см
        box = (canvas_size[0] - 2 * margin, canvas_size[1] - 2 * margin)
        fitted = ImageOps.contain(img, box, Image.Resampling.LANCZOS)
        canvas = Image.new(img.mode, canvas_size, "white" if img.mode == "RGB" else 255)
        canvas.paste(fitted, ((canvas_size[0] - fitted.width) // 2, (canvas_size[1] - fitted.height) // 2))
        return canvas, dpi

    if max(img.size) > max_side:
        img = ImageOps.contain(img, (max_side, max_side), Image.Resampling.LANCZOS)
    # подбираем dpi так, чтобы длинная сторона = длинной стороне A4:
    # страницы получаются привычного размера при любом разрешении фото
    return img, max(img.size) / A4_INCHES[1]


def build_pdf(folder: Path, items: Iterable, opts: BuildOptions, prefix: bytes | None = None) -> tuple[bytes, int]:
    """items — объекты с полями kind/file/rotation (storage.Item); prefix — готовые страницы
    в начало (титульный лист). Возвращает (pdf, число страниц)."""
    _, jpeg_quality = QUALITY[opts.quality]
    writer = PdfWriter()
    if prefix:
        writer.append(PdfReader(BytesIO(prefix)))

    for item in items:
        path = folder / item.file
        if item.kind == "image":
            page_img, dpi = _render_page(open_image(path), item.rotation, opts)
            buf = BytesIO()
            page_img.save(buf, "PDF", resolution=dpi, quality=jpeg_quality)
            buf.seek(0)
            writer.append(PdfReader(buf))
        else:
            reader = PdfReader(path)
            for page in reader.pages:
                if item.rotation:
                    page.rotate(item.rotation)
                writer.add_page(page)

    writer.compress_identical_objects(remove_identicals=True, remove_orphans=True)
    out = BytesIO()
    writer.write(out)
    return out.getvalue(), len(writer.pages)
