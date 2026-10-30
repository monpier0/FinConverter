import asyncio
import os
import time

import pytest

from app.storage import SessionStore, TooManyItems, TooManyPages
from tests.helpers import photo


def test_parallel_adds_lose_nothing(tmp_path):
    """Альбом из 10 фото: разбор идёт в потоках, а страницы не теряются и не затирают друг друга."""
    store = SessionStore(tmp_path)

    async def run():
        await asyncio.gather(*(store.add_async(1, photo(size=(300, 400)), "image") for _ in range(10)))

    asyncio.run(run())
    items = store.load(1).items
    assert len(items) == 10 and len({i.id for i in items}) == 10
    assert all((store.dir(1) / i.file).exists() and store.thumb_path(1, i.id).exists() for i in items)


def test_item_limit_discards_files(tmp_path):
    store = SessionStore(tmp_path, max_items=2)

    async def run():
        for _ in range(2):
            await store.add_async(1, photo(size=(300, 400)), "image")
        with pytest.raises(TooManyItems):
            await store.add_async(1, photo(size=(300, 400)), "image")

    asyncio.run(run())
    assert len(list(store.dir(1).glob("*.jpg"))) == 4  # две страницы и две миниатюры, лишний файл не остался


def test_page_limit_counts_pdf_pages(tmp_path):
    from io import BytesIO
    from pypdf import PdfWriter
    writer = PdfWriter()
    for _ in range(5):
        writer.add_blank_page(100, 100)
    buf = BytesIO()
    writer.write(buf)
    store = SessionStore(tmp_path, max_pages=8)
    store.add(1, buf.getvalue(), "pdf", "a.pdf")
    with pytest.raises(TooManyPages):
        store.add(1, buf.getvalue(), "pdf", "b.pdf")  # 5 + 5 > 8
    assert len(store.load(1).items) == 1 and len(list(store.dir(1).glob("*.pdf"))) == 1


def test_set_text_for_removed_item_is_noop(tmp_path):
    store = SessionStore(tmp_path)
    item = store.add(1, photo(size=(300, 400)), "image")
    store.remove(1, item.id)
    store.set_text(1, item.id, ["текст"])  # страницу удалили, пока шло распознавание
    assert store.load(1).items == []


def test_cleanup_removes_only_stale_sessions(tmp_path):
    store = SessionStore(tmp_path)
    store.add(1, photo(size=(300, 400)), "image")
    store.add(2, photo(size=(300, 400)), "image")
    store.save_title(1, store.load_title(1))
    old = time.time() - 10 * 86400
    os.utime(store.dir(1) / "session.json", (old, old))
    assert store.cleanup(7) == 1
    assert not store.dir(1).exists() and store.dir(2).exists()
    assert (tmp_path / "_titles" / "1.json").exists()  # запомненные ФИО остаются
    assert store.cleanup(0) == 0  # 0 отключает очистку
