import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import aiohttp
import pytest
from aiohttp.test_utils import TestClient, TestServer
from unittest.mock import MagicMock

from app import ocr, proofread
from app.ocr import MARK_CLOSE as C, MARK_OPEN as O, Token
from app.proofread import Edit, build, clean_marks
from app.storage import SessionStore
from app.web import create_app
from tests.helpers import config, init_data, photo
from tests.test_web import needs_ocr

SIZE = (1000, 1000)


def T(text, x, unsure=False, y=0):
    return Token(text, unsure, (x, y, x + 50, y + 20))


def page():
    return [
        [T("Валовой", 0), T("продукт", 100), T("всех", 200, True), T("конечньх", 300, True), T("товаров", 400)],
        [T("Банк", 0), T("управляет", 100), T("ставкой", 200), T("её", 300), T("повышение", 400)],
        [T("рост", 0), T("цен,", 100), T("а", 200), T("не", 300), T("цен.", 400)],
    ]


def test_build_applies_auto_fixes_and_only_suggests_meaning():
    edits = [
        Edit(0, "конечньх", "конечных", "ocr", "ошибка"),
        Edit(1, "ставкой", "ставкой:", "punct", "двоеточие"),
        Edit(2, "цен.", "выпуска.", "ask", "оговорка"),
    ]
    paras, marks = build(page(), SIZE, edits)
    assert paras[0] == f"Валовой продукт всех {O}конечных{C} товаров"
    assert paras[1] == f"Банк управляет {O}ставкой:{C} её повышение"
    assert paras[2] == f"рост цен, а не {O}цен.{C}"  # у вопроса по смыслу текст остаётся прежним
    assert [(m["kind"], m["on"]) for m in marks] == [("ocr", True), ("punct", True), ("ask", False)]
    assert marks[0]["old"] == "конечньх" and marks[0]["new"] == "конечных" and marks[0]["why"] == "ошибка"
    assert marks[2]["old"] == "цен." and marks[2]["new"] == "выпуска."
    assert marks[0]["box"] == [.3, 0.0, .05, .02]


def test_unsure_words_are_marked_only_when_there_was_no_check():
    paras, marks = build(page(), SIZE, None)
    assert paras[0].count(O) == 2 and [m["kind"] for m in marks] == ["un", "un"]
    paras, marks = build(page(), SIZE, [])  # проверили и ничего не нашли: сомнения распознавания больше не показываем
    assert O not in paras[0] and marks == []


def test_edit_spanning_several_words_and_part_of_a_word():
    layout = [[T("в", 0), T("следствие", 100), T("спада,", 200), T("циклическои", 300)]]
    edits = [Edit(0, "в следствие", "вследствие", "spell", "слитно"), Edit(0, "ческои", "ческой", "ocr", "й")]
    paras, marks = build(layout, SIZE, edits)
    assert paras == [f"{O}вследствие{C} спада, {O}циклической{C}"]
    assert marks[0]["old"] == "в следствие" and marks[0]["box"] == [0.0, 0.0, .15, .02]  # рамка охватывает оба слова
    assert marks[1]["old"] == "циклическои" and marks[1]["new"] == "циклической"  # правка слова целиком, хоть модель дала кусок


def test_bad_edits_are_skipped():
    layout = [[T("цена", 0), T("растёт,", 100), T("цена", 200), T("падает", 300)]]
    edits = [
        Edit(0, "цена", "цены", "spell", "дважды в тексте"),
        Edit(5, "падает", "падёт", "spell", "нет такого абзаца"),
        Edit(0, "нет такого", "x", "ocr", "нет фрагмента"),
        Edit(0, "растёт,", "растёт,", "punct", "без изменений"),
        Edit(0, "падает", "", "spell", "пустая замена"),
        Edit(0, "падает", "падаёт", "magic", "неизвестный вид"),
        Edit(0, "растёт, цена", "растут, цены", "spell", "пересекается со следующей"),
        Edit(0, "цена падает", "цены падают", "spell", "пересекается с предыдущей"),
    ]
    paras, marks = build(layout, SIZE, edits)
    assert paras == [f"цена {O}растут, цены{C} падает"] and len(marks) == 1


def test_clean_marks():
    text = [f"{O}a{C} b"]
    assert clean_marks(None, text) is None
    assert clean_marks([{"kind": "ocr"}, {"kind": "ocr"}], text) is None  # пометок в тексте одна
    assert clean_marks("мусор", text) is None
    ok = clean_marks([{"kind": "bad", "old": "x" * 999, "box": [2, -1, 0.5, 0.5]}], text)
    assert ok[0]["kind"] == "un" and len(ok[0]["old"]) == 300 and ok[0]["box"] == [1.0, 0.0, 0.5, 0.5]


anthropic = pytest.importorskip("anthropic")


def fake_checker(reply=None, error=None):
    checker = object.__new__(proofread.Checker)
    checker._anthropic, checker.model, checker._gate = anthropic, "m", asyncio.Semaphore(1)
    create = AsyncMock(side_effect=error) if error else AsyncMock(return_value=reply)
    checker.client = SimpleNamespace(messages=SimpleNamespace(create=create))
    return checker, create


def reply(text, stop="end_turn"):
    return SimpleNamespace(stop_reason=stop, content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=text)])


def test_checker_parses_edits_and_sends_marked_paragraphs():
    checker, create = fake_checker(reply('{"edits": [{"par": 1, "old": "a", "new": "b", "kind": "ocr", "why": "w"}, {"par": "x"}]}'))
    edits = asyncio.run(checker.check(["⟦a⟧ текст", "второй"]))
    assert edits == [Edit(0, "a", "b", "ocr", "w")]  # номер абзаца с единицы; битая правка пропущена
    kwargs = create.await_args.kwargs
    assert kwargs["model"] == "m" and "[1] ⟦a⟧ текст\n[2] второй" in kwargs["messages"][0]["content"]
    assert kwargs["output_config"]["format"]["type"] == "json_schema" and "temperature" not in kwargs


@pytest.mark.parametrize("bad", [reply("{}", stop="refusal"), reply("{}", stop="max_tokens"), reply("не json"), reply('{"x": 1}')])
def test_checker_raises_on_unusable_reply(bad):
    checker, _ = fake_checker(bad)
    with pytest.raises(proofread.CheckError):
        asyncio.run(checker.check(["текст"]))


def test_checker_wraps_api_errors():
    checker, _ = fake_checker(error=anthropic.APIConnectionError(request=MagicMock()))
    with pytest.raises(proofread.CheckError):
        asyncio.run(checker.check(["текст"]))


def test_no_key_no_checker(tmp_path):
    assert proofread.get_checker(config(tmp_path)) is None


class FakeChecker:
    def __init__(self, fail=False):
        self.fail, self.calls = fail, []

    async def check(self, paragraphs):
        self.calls.append(paragraphs)
        if self.fail:
            raise proofread.CheckError("нет связи")
        return [Edit(0, "страница.", "страница!", "punct", "знак")] if "Вторая" in paragraphs[0] else []


def recognize_with(tmp_path, monkeypatch, checker):
    monkeypatch.setattr(proofread, "get_checker", lambda cfg: checker)
    cfg = config(tmp_path)

    async def main():
        bot = MagicMock()
        async with TestClient(TestServer(create_app(cfg, SessionStore(cfg.data_dir, cfg.max_items), bot))) as client:
            H = {"X-Init-Data": init_data(7)}
            for lines in (["Первая страница."], ["Вторая страница."]):
                fd = aiohttp.FormData()
                fd.add_field("file", photo(lines), filename="p.jpg", content_type="image/jpeg")
                await client.post("/api/upload", data=fd, headers=H)
            first = await (await client.post("/api/ocr", headers=H)).json()
            for _ in range(150):
                job = await (await client.get("/api/ocr", headers=H)).json()
                if job["state"] in ("done", "error"):
                    break
                await asyncio.sleep(0.2)
            return first, job, (await (await client.get("/api/session", headers=H)).json())["items"]

    return asyncio.run(main())


@needs_ocr
def test_recognition_runs_the_check_and_stores_marks(tmp_path, monkeypatch):
    checker = FakeChecker()
    first, job, items = recognize_with(tmp_path, monkeypatch, checker)
    assert first["check"] is True and job["state"] == "done" and job["done"] == 2 and job["stage"] == "check"
    assert len(checker.calls) == 2 and all(i["checked"] for i in items)
    assert items[0]["marks"] == [] and items[0]["text"] == ["Первая страница."]
    assert items[1]["text"] == [f"Вторая {O}страница!{C}"] and items[1]["marks"][0]["old"] == "страница."
    assert items[1]["marks"][0]["box"] and items[1]["marks"][0]["on"] is True


@needs_ocr
def test_failed_check_keeps_plain_recognized_text(tmp_path, monkeypatch):
    _, job, items = recognize_with(tmp_path, monkeypatch, FakeChecker(fail=True))
    assert job["state"] == "done" and job["done"] == 2
    assert not any(i["checked"] for i in items) and "страница" in ocr.plain(items[1]["text"][0])


@needs_ocr
def test_without_checker_recognition_works_as_before(tmp_path, monkeypatch):
    first, job, items = recognize_with(tmp_path, monkeypatch, None)
    assert first["check"] is False and job["state"] == "done" and not any(i["checked"] for i in items)
