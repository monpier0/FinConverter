import io

import pytest
from pypdf import PdfReader

from app import ocr
from app.document import merge_pages
from app.ocr import MARK_CLOSE, MARK_OPEN, Word, paragraphs, paragraphs_with_boxes, plain
from tests.helpers import FONT, photo

needs_tesseract = pytest.mark.skipif(not (ocr.available() and FONT.exists()), reason="нужны tesseract и шрифт DejaVu")


def W(text, line, conf=95, block=1):
    return Word(text, 0, 0, 10, 10, block, 1, line, conf)


def test_paragraphs_join_hyphenation_and_mark_unsure_words():
    words = [W("Ставка", 1), W("рефинансиро-", 1), W("вания", 2), W("влияет", 2, conf=50), W("на", 2), W("рост.", 2),
             W("Новый", 1, block=2), W("абзац", 1, conf=60, block=2)]
    got = paragraphs(words)
    assert [plain(p) for p in got] == ["Ставка рефинансирования влияет на рост.", "Новый абзац"]
    assert f"{MARK_OPEN}влияет{MARK_CLOSE}" in got[0] and f"{MARK_OPEN}абзац{MARK_CLOSE}" in got[1]


def test_boxes_follow_marked_words_and_merge_hyphenation():
    words = [Word("Ставка", 0, 0, 100, 20, 1, 1, 1, 95), Word("рефинансиро-", 100, 0, 100, 20, 1, 1, 1, 50),
             Word("вания", 0, 40, 60, 20, 1, 1, 2, 90), Word("рост", 70, 40, 30, 20, 1, 1, 2, 40)]
    paras, boxes = paragraphs_with_boxes(words, (200, 100))
    assert paras == [f"Ставка {MARK_OPEN}рефинансирования{MARK_CLOSE} {MARK_OPEN}рост{MARK_CLOSE}"]
    # рамка склеенного слова охватывает обе его части, вторая рамка у «рост»
    assert boxes == [[0.0, 0.0, 1.0, .6], [.35, .4, .15, .2]]


def test_hyphen_before_capital_letter_is_kept():
    assert plain(paragraphs([W("Санкт-", 1), W("Петербург", 2)])[0]) == "Санкт- Петербург"


def test_merge_pages_joins_paragraph_split_by_page_edge():
    pages = [["Первая часть предложения и"], [f"{MARK_OPEN}продолжение{MARK_CLOSE} на странице.", "Новый абзац."]]
    assert merge_pages(pages) == ["Первая часть предложения и продолжение на странице.", "Новый абзац."]
    assert merge_pages([["Конец."], ["начало с малой"]]) == ["Конец.", "начало с малой"]  # после точки не склеиваем
    assert merge_pages([[], ["  ", "Текст"]]) == ["Текст"]


@needs_tesseract
def test_recognizes_russian_and_english_text():
    from PIL import Image
    img = Image.open(io.BytesIO(photo(["Валовой внутренний продукт", "Inflation rate 4,5% за год."])))
    text = " ".join(plain(p) for p in paragraphs(ocr.recognize(img)))
    assert "Валовой" in text and "продукт" in text and "Inflation" in text


@needs_tesseract
def test_text_layer_makes_pdf_searchable():
    from PIL import Image
    img = Image.open(io.BytesIO(photo(["Валовой внутренний продукт"])))
    layer = ocr.text_layer(ocr.recognize(img), img.size, 200)
    assert "внутренний" in PdfReader(io.BytesIO(layer)).pages[0].extract_text()


@needs_tesseract
def test_queue_runs_at_most_workers_at_once():
    import asyncio
    running = peak = 0

    async def job():
        nonlocal running, peak
        async with ocr.turn(1):
            running += 1
            peak = max(peak, running)
            await asyncio.sleep(0.05)
            running -= 1

    async def run():
        await asyncio.gather(*(job() for _ in range(4)))

    asyncio.run(run())
    assert peak == 1
