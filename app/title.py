"""Титульный лист студенческой работы (A4, Times New Roman 14, поля по ГОСТ 7.32)."""

import os
from dataclasses import dataclass, fields
from datetime import date
from io import BytesIO
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

WORK_TYPES = [
    "Реферат", "Доклад", "Эссе", "Контрольная работа", "Домашнее задание",
    "Курсовая работа", "Лабораторная работа", "Отчёт по практике",
]

UNIVERSITY = [
    "Федеральное государственное образовательное бюджетное учреждение",
    "высшего образования",
    "«Финансовый университет при Правительстве Российской Федерации»",
    "(Финансовый университет)",
]

# Times New Roman, а если его нет (Linux-сервер) — метрически совместимый Liberation Serif
FONT_CANDIDATES = [
    (os.getenv("TITLE_FONT", ""), os.getenv("TITLE_FONT_BOLD", "")),
    ("/System/Library/Fonts/Supplemental/Times New Roman.ttf",
     "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf"),
    ("/usr/share/fonts/truetype/msttcorefonts/Times_New_Roman.ttf",
     "/usr/share/fonts/truetype/msttcorefonts/Times_New_Roman_Bold.ttf"),
    ("/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
     "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf"),
    ("/usr/share/fonts/liberation-serif/LiberationSerif-Regular.ttf",
     "/usr/share/fonts/liberation-serif/LiberationSerif-Bold.ttf"),
    ("C:/Windows/Fonts/times.ttf", "C:/Windows/Fonts/timesbd.ttf"),
]


class FontMissing(Exception):
    pass


@dataclass
class TitlePage:
    enabled: bool = False
    work_type: str = "Реферат"
    discipline: str = ""
    topic: str = ""
    faculty: str = ""
    student: str = ""
    student_label: str = "Выполнил"  # «Выполнил» | «Выполнила»
    group: str = ""
    teacher: str = ""
    teacher_position: str = ""
    city: str = "Москва"

    @classmethod
    def from_dict(cls, raw: dict) -> "TitlePage":
        tp = cls()
        for f in fields(cls):
            if f.name not in raw:
                continue
            value = raw[f.name]
            setattr(tp, f.name, bool(value) if f.type in (bool, "bool") else str(value).strip()[:300])
        if tp.student_label not in ("Выполнил", "Выполнила"):
            tp.student_label = "Выполнил"
        return tp

    def missing(self) -> list[str]:
        need = {"work_type": "тип работы", "student": "ФИО", "group": "группу"}
        return [label for key, label in need.items() if not getattr(self, key)]


_fonts: tuple[str, str] | None = None


def _register_fonts() -> tuple[str, str]:
    global _fonts
    if _fonts:
        return _fonts
    for regular, bold in FONT_CANDIDATES:
        if regular and bold and Path(regular).exists() and Path(bold).exists():
            pdfmetrics.registerFont(TTFont("TitleRegular", regular))
            pdfmetrics.registerFont(TTFont("TitleBold", bold))
            _fonts = ("TitleRegular", "TitleBold")
            return _fonts
    raise FontMissing("Нет шрифта Times New Roman или Liberation Serif — задай TITLE_FONT/TITLE_FONT_BOLD")


def text_font() -> str:
    """Шрифт с кириллицей и латиницей: им же рисуется невидимый текстовый слой при распознавании."""
    return _register_fonts()[0]


def render_title(tp: TitlePage, year: int | None = None) -> bytes:
    regular, bold = _register_fonts()
    year = year or date.today().year
    width, height = A4
    left, right, top, bottom = 30 * mm, 15 * mm, 20 * mm, 20 * mm
    text_w = width - left - right
    size, leading = 14, 14 * 1.15

    buf = BytesIO()
    c = Canvas(buf, pagesize=A4)
    c.setTitle(f"{tp.work_type} — {tp.topic or tp.discipline}".strip(" —"))
    c.setAuthor(tp.student)
    y = height - top - size

    def centered(text: str, font: str = regular, fsize: int = size, gap: float = 0) -> None:
        nonlocal y
        for line in simpleSplit(text, font, fsize, text_w):
            c.setFont(font, fsize)
            c.drawCentredString(left + text_w / 2, y, line)
            y -= fsize * 1.15
        y -= gap

    for line in UNIVERSITY:
        centered(line)
    y -= leading
    if tp.faculty:
        centered(tp.faculty, gap=leading)

    # основной блок — примерно на трети высоты листа, как в методичках
    y = min(y, height * 0.62)
    centered(tp.work_type.upper(), bold, 16, gap=leading * 0.5)
    if tp.discipline:
        centered(f"по дисциплине «{tp.discipline}»", gap=leading * 0.3)
    if tp.topic:
        centered(f"на тему: «{tp.topic}»", bold)

    # блок «Выполнил / Проверил» прижат вправо (начинается с середины листа)
    block_x = left + text_w * 0.5
    block_w = text_w * 0.5
    y = min(y - leading * 2, height * 0.38)

    def right_block(lines: list[tuple[str, str]]) -> None:
        nonlocal y
        for text, font in lines:
            for line in simpleSplit(text, font, size, block_w):
                c.setFont(font, size)
                c.drawString(block_x, y, line)
                y -= leading

    student = [(f"{tp.student_label}:", bold)]
    if tp.group:
        student.append((f"студент{'ка' if tp.student_label == 'Выполнила' else ''} группы {tp.group}", regular))
    student.append((tp.student, regular))
    right_block(student)

    if tp.teacher:
        y -= leading
        teacher = [("Проверил(а):", bold)]
        if tp.teacher_position:
            teacher.append((tp.teacher_position, regular))
        teacher.append((tp.teacher, regular))
        right_block(teacher)

    c.setFont(regular, size)
    c.drawCentredString(left + text_w / 2, bottom, f"{tp.city or 'Москва'} {year}")
    c.showPage()
    c.save()
    return buf.getvalue()
