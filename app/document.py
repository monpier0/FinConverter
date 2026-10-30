"""Распознанный текст как документ: Word (.docx) и PDF из набранного текста.
Оформление по ГОСТ 7.32, как у титульного листа: Times New Roman 14, поля 30/15/20/20 мм, полуторный интервал."""

from io import BytesIO
from xml.sax.saxutils import escape

from reportlab.lib.enums import TA_JUSTIFY
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm, mm
from reportlab.platypus import Paragraph, SimpleDocTemplate

from .ocr import plain
from .title import text_font

FONT = "Times New Roman"
SENTENCE_END = (".", "!", "?", "…", ":", ";", "»", '"', ")")


def merge_pages(pages: list[list[str]]) -> list[str]:
    """Абзацы всех страниц подряд, без служебных пометок. Абзац, который оборвался на краю фото,
    склеивается с первым абзацем следующего."""
    result: list[str] = []
    for page in pages:
        for i, para in enumerate(p for p in (plain(x).strip() for x in page) if p):
            if i == 0 and result and not result[-1].endswith(SENTENCE_END) and para[:1].islower():
                result[-1] += " " + para
            else:
                result.append(para)
    return result


def build_docx(paragraphs: list[str]) -> bytes:
    # библиотека подключается здесь, а не наверху: если её нет, не работает только Word, а бот остаётся живым
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt

    doc = Document()
    section = doc.sections[0]
    section.page_width, section.page_height = Cm(21), Cm(29.7)
    section.left_margin, section.right_margin = Cm(3), Cm(1.5)
    section.top_margin = section.bottom_margin = Cm(2)

    normal = doc.styles["Normal"]
    normal.font.name = FONT
    normal.font.size = Pt(14)
    rfonts = normal.element.get_or_add_rPr().get_or_add_rFonts()
    for attr in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):  # без eastAsia/cs Word подставит другой шрифт для кириллицы
        rfonts.set(qn(attr), FONT)
    fmt = normal.paragraph_format
    fmt.line_spacing = 1.5
    fmt.first_line_indent = Cm(1.25)
    fmt.space_after = Pt(0)
    fmt.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY

    for text in paragraphs:
        doc.add_paragraph(text)
    out = BytesIO()
    doc.save(out)
    return out.getvalue()


def build_text_pdf(paragraphs: list[str]) -> bytes:
    """PDF, набранный из текста (а не фото): текст можно выделять и копировать."""
    style = ParagraphStyle("body", fontName=text_font(), fontSize=14, leading=21,
                           firstLineIndent=1.25 * cm, alignment=TA_JUSTIFY)
    out = BytesIO()
    SimpleDocTemplate(out, pagesize=A4, leftMargin=30 * mm, rightMargin=15 * mm,
                      topMargin=20 * mm, bottomMargin=20 * mm).build([Paragraph(escape(p), style) for p in paragraphs])
    return out.getvalue()
