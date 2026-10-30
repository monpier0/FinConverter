"""Распознавание страниц из мини-аппа: фоновая задача на человека, мини-апп спрашивает ход опросом.

Каждая страница сначала читается Tesseract, потом (если задан ключ API) проверяется моделью: ошибки
распознавания, правописание, пунктуация, вопросы по смыслу. Проверка идёт параллельно с чтением следующей
страницы. Результат пишется в сессию (Item.text) по мере готовности, поэтому его не потеряешь, если закрыть
мини-апп: при следующем открытии страницы уже с текстом, а идущую задачу приложение подхватит.
"""

import asyncio
import logging
from dataclasses import dataclass, field, replace
from datetime import date
from pathlib import Path

from . import ocr, proofread
from .config import Config
from .pdf import BuildOptions, _render_page, open_image
from .storage import SessionStore


class RecognizeError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


@dataclass
class Job:
    state: str = "queued"  # queued | running | done | error | cancelled
    total: int = 0
    done: int = 0
    position: int = 0  # место в очереди, пока state == queued
    finished: list[str] = field(default_factory=list)  # id уже распознанных страниц
    error: str = ""
    cancel: bool = False
    check: bool = False  # страницы проверяются моделью, а не только распознаются
    stage: str = "ocr"  # ocr: читаются страницы | check: всё прочитано, ждём проверки последних

    def view(self) -> dict:
        return {"state": self.state, "total": self.total, "done": self.done, "position": self.position,
                "finished": self.finished, "error": self.error, "check": self.check, "stage": self.stage}


_jobs: dict[int, Job] = {}
_tasks: set[asyncio.Task] = set()  # ссылки на задачи, чтобы их не убрал сборщик мусора


def get(uid: int) -> Job | None:
    return _jobs.get(uid)


def start(uid: int, store: SessionStore, cfg: Config) -> Job:
    """Запускает распознавание страниц без текста. Уже идущую задачу возвращает как есть."""
    job = _jobs.get(uid)
    if job and job.state in ("queued", "running"):
        return job
    todo = [i.id for i in store.load(uid).items if i.kind == "image" and i.text is None]
    if not todo:
        job = _jobs[uid] = Job(state="done")
        return job
    if not ocr.available():
        raise RecognizeError("Распознавание текста сейчас недоступно на сервере.")
    if cfg.ocr_daily_pages and uid not in cfg.admin_ids:
        left = max(cfg.ocr_daily_pages - store.ocr_used(uid, date.today().isoformat()), 0)
        if len(todo) > left:
            raise RecognizeError(
                f"На сегодня осталось {left} стр. распознавания из {cfg.ocr_daily_pages}, а нужно {len(todo)}. "
                "Убери лишние страницы или продолжи завтра."
            )
    checker = proofread.get_checker(cfg)
    job = _jobs[uid] = Job(total=len(todo), check=checker is not None)
    task = asyncio.create_task(_run(job, uid, todo, store, cfg, checker))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return job


def cancel(uid: int) -> None:
    if job := _jobs.get(uid):
        job.cancel = True


def _read_page(path: Path, rotation: int, opts: BuildOptions) -> tuple[list[list[ocr.Token]], tuple[int, int]]:
    # тот же поворот и режим («Скан» сильно помогает), что и в итоговом PDF, но без полей A4: рамки слов
    # считаются в долях самой страницы, чтобы их можно было наложить на фото
    img, _ = _render_page(open_image(path), rotation, replace(opts, page="original"))
    return ocr.layout(ocr.recognize(img)), img.size


async def _check_page(job: Job, uid: int, item_id: str, layout: list[list[ocr.Token]], size: tuple[int, int],
                      store: SessionStore, checker: proofread.Checker | None, today: str) -> None:
    edits = None
    if checker is not None:
        try:
            edits = await checker.check([proofread.marked(tokens) for tokens in layout])
        except Exception:  # любой сбой проверки не должен терять распознанный текст
            logging.exception("Проверка текста не удалась")
    paragraphs, marks = proofread.build(layout, size, edits)
    store.set_text(uid, item_id, paragraphs, marks, checked=edits is not None)
    store.ocr_add(uid, today, 1)
    job.done += 1
    job.finished.append(item_id)


async def _run(job: Job, uid: int, todo: list[str], store: SessionStore, cfg: Config, checker: proofread.Checker | None) -> None:
    today = date.today().isoformat()
    checks: list[asyncio.Task] = []

    async def waiting(place: int) -> None:
        job.position = place

    try:
        async with ocr.turn(cfg.ocr_workers, waiting):
            job.state, job.position = "running", 0
            for item_id in todo:
                if job.cancel:
                    job.state = "cancelled"
                    return
                session = store.load(uid)
                item = next((i for i in session.items if i.id == item_id), None)
                if item is None:  # страницу удалили, пока ждали
                    job.total -= 1
                    continue
                layout, size = await asyncio.to_thread(_read_page, store.dir(uid) / item.file, item.rotation, session.options)
                checks.append(asyncio.create_task(_check_page(job, uid, item_id, layout, size, store, checker, today)))
            job.stage = "check"
        await asyncio.gather(*checks)  # проверка последних страниц идёт уже без очереди на Tesseract
        job.state = "cancelled" if job.cancel else "done"
    except Exception:
        logging.exception("Распознавание не удалось")
        job.state, job.error = "error", "Не получилось распознать текст. Попробуй ещё раз."
    finally:
        for task in checks:
            if not task.done():
                task.cancel()
