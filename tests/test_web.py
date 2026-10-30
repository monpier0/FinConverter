import asyncio
import io
import time
from unittest.mock import AsyncMock, MagicMock

import aiohttp
import pytest
from aiohttp.test_utils import TestClient, TestServer

from app import ocr
from app.storage import SessionStore
from app.web import create_app, validate_init_data
from tests.helpers import FONT, TOKEN, config, init_data, photo

try:
    import docx  # noqa: F401
    HAS_DOCX = True
except ImportError:
    HAS_DOCX = False

needs_ocr = pytest.mark.skipif(not (ocr.available() and FONT.exists()), reason="нужны tesseract и шрифт DejaVu")


def run_client(tmp_path, scenario, **cfg_kw):
    cfg = config(tmp_path, **cfg_kw)
    bot = MagicMock()
    bot.send_document = AsyncMock()

    async def main():
        async with TestClient(TestServer(create_app(cfg, SessionStore(cfg.data_dir, cfg.max_items), bot))) as client:
            return await scenario(client, bot)

    return asyncio.run(main())


def test_init_data_validation():
    assert validate_init_data(init_data(7), TOKEN) == {"id": 7}
    assert validate_init_data(init_data(7), "other:token") is None  # подпись от другого токена
    assert validate_init_data(init_data(7, auth_date=str(int(time.time()) - 90000)), TOKEN) is None  # просрочена
    assert validate_init_data(init_data(7, auth_date="не число"), TOKEN) is None  # раньше падало в 500
    assert validate_init_data("", TOKEN) is None


def test_only_admins_get_in(tmp_path):
    async def scenario(client, bot):
        out = {}
        for uid in (7, 8):
            r = await client.get("/api/session", headers={"X-Init-Data": init_data(uid)})
            out[uid] = r.status
        out["без подписи"] = (await client.get("/api/session")).status
        out["страница"] = (await client.get("/")).status
        return out

    assert run_client(tmp_path, scenario) == {7: 200, 8: 403, "без подписи": 401, "страница": 200}


def test_empty_admin_list_closes_everything(tmp_path):
    async def scenario(client, bot):
        return (await client.get("/api/session", headers={"X-Init-Data": init_data(7)})).status

    assert run_client(tmp_path, scenario, admin_ids=frozenset()) == 403


def test_upload_reports_errors_and_page_limit(tmp_path):
    async def scenario(client, bot):
        H = {"X-Init-Data": init_data(7)}
        fd = aiohttp.FormData()
        fd.add_field("file", b"not an image", filename="x.jpg", content_type="image/jpeg")
        for _ in range(3):
            fd.add_field("file", photo(size=(300, 400)), filename="p.jpg", content_type="image/jpeg")
        r = await (await client.post("/api/upload", data=fd, headers=H)).json()
        return len(r["items"]), r.get("errors")

    items, errors = run_client(tmp_path, scenario, max_items=2)
    assert items == 2
    assert any("x.jpg" in e for e in errors) and any("Максимум 2" in e for e in errors)


@needs_ocr
def test_recognize_edit_export(tmp_path):
    async def scenario(client, bot):
        H = {"X-Init-Data": init_data(7)}
        for lines in (["Валовой внутренний продукт измеряет", "стоимость всех товаров и услуг."], ["Вторая страница."]):
            fd = aiohttp.FormData()
            fd.add_field("file", photo(lines), filename="p.jpg", content_type="image/jpeg")
            await client.post("/api/upload", data=fd, headers=H)
        job = await (await client.post("/api/ocr", headers=H)).json()
        assert job["total"] == 2
        for _ in range(100):
            job = await (await client.get("/api/ocr", headers=H)).json()
            if job["state"] in ("done", "error"):
                break
            await asyncio.sleep(0.2)
        assert job["state"] == "done" and len(job["finished"]) == 2
        items = (await (await client.get("/api/session", headers=H)).json())["items"]
        assert all(i["text"] for i in items)
        again = await (await client.post("/api/ocr", headers=H)).json()  # всё уже распознано
        assert again["state"] == "done" and again["total"] == 0
        await client.put(f"/api/items/{items[0]['id']}/text", json={"text": ["Исправленный текст."]}, headers=H)
        text = await (await client.post("/api/export", json={"format": "text"}, headers=H)).json()
        assert "Исправленный текст." in text["text"] and text["pages"] == 2
        results = {}
        for fmt in ("docx", "pdf") if HAS_DOCX else ("pdf",):
            r = await client.post("/api/export", json={"format": fmt}, headers=H)
            assert r.status == 200
            results[fmt] = bot.send_document.await_args.args[1].filename
        assert (await client.post("/api/export", json={"format": "exe"}, headers=H)).status == 400
        return results

    results = run_client(tmp_path, scenario)
    assert results["pdf"] == "Конспект.pdf"


@needs_ocr
def test_daily_limit_blocks_non_admins_only(tmp_path):
    async def scenario(client, bot):
        out = {}
        for uid in (7, 9):
            H = {"X-Init-Data": init_data(uid)}
            for _ in range(2):
                fd = aiohttp.FormData()
                fd.add_field("file", photo(["Текст"]), filename="p.jpg", content_type="image/jpeg")
                await client.post("/api/upload", data=fd, headers=H)
            out[uid] = (await client.post("/api/ocr", headers=H)).status
        return out

    # админ 7 лимитом не ограничен, а 9 просит 2 страницы при лимите 1
    got = run_client(tmp_path, scenario, ocr_daily_pages=1, admin_ids=frozenset({7, 9}))
    assert got[7] == 200
    got = run_client(tmp_path / "2", scenario, ocr_daily_pages=1, admin_ids=frozenset({7}))
    assert got[7] == 200 and got[9] == 403  # 9 не админ, до лимита не доходит


def test_export_without_text_is_400(tmp_path):
    async def scenario(client, bot):
        r = await client.post("/api/export", json={"format": "text"}, headers={"X-Init-Data": init_data(7)})
        return r.status

    assert run_client(tmp_path, scenario) == 400


def test_export_send_failure_is_reported(tmp_path):
    async def scenario(client, bot):
        H = {"X-Init-Data": init_data(7)}
        store = client.server.app["store"]
        item = store.add(7, photo(size=(300, 400)), "image")
        store.set_text(7, item.id, ["Какой-то текст."])
        bot.send_document.side_effect = RuntimeError("blocked")
        r = await client.post("/api/export", json={"format": "pdf"}, headers=H)
        return r.status, (await r.json())["error"]

    status, error = run_client(tmp_path, scenario)
    assert status == 502 and "чат" in error


def test_session_gives_mid_preview_and_serves_it(tmp_path):
    async def scenario(client, bot):
        H = {"X-Init-Data": init_data(7)}
        store = client.server.app["store"]
        item = store.add(7, photo(size=(1600, 2200)), "image")
        data = await (await client.get("/api/session", headers=H)).json()
        mid = data["items"][0]["mid"]
        r = await client.get(mid)
        body = await r.read()
        bad = await client.get(mid.replace("s=", "s=0"))
        return r.status, len(body), data["items"][0]["thumb"] != mid, bad.status

    status, size, different, bad = run_client(tmp_path, scenario)
    assert status == 200 and size > 1000 and different and bad == 403


def test_set_text_keeps_marks_clamps_boxes_and_drops_mismatched_ones(tmp_path):
    mk = ocr.MARK_OPEN, ocr.MARK_CLOSE

    async def scenario(client, bot):
        H = {"X-Init-Data": init_data(7)}
        store = client.server.app["store"]
        item = store.add(7, photo(size=(300, 400)), "image")
        text = [f"a {mk[0]}b{mk[1]} c {mk[0]}d{mk[1]}"]
        marks = [{"kind": "ocr", "old": "bb", "new": "b", "why": "w", "on": True, "box": [.1, .2, 2, "bad"]},
                 {"kind": "wat", "old": "d", "new": "d", "on": False, "box": [.5, .5, .1, .1]}]
        r = await client.put(f"/api/items/{item.id}/text", json={"text": text, "marks": marks}, headers=H)
        kept = store.load(7).items[0].marks
        await client.put(f"/api/items/{item.id}/text", json={"text": text, "marks": marks[:1]}, headers=H)  # число пометок не сходится
        return r.status, kept, store.load(7).items[0].marks

    status, kept, mismatched = run_client(tmp_path, scenario)
    assert status == 200 and mismatched is None
    assert kept[0] == {"kind": "ocr", "old": "bb", "new": "b", "why": "w", "on": True, "box": None}  # битую рамку отбрасываем
    assert kept[1]["kind"] == "un" and kept[1]["on"] is False and kept[1]["box"] == [.5, .5, .1, .1]
