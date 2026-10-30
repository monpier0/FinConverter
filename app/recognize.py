"""Распознавание страниц из мини-аппа: фоновая задача на человека, мини-апп спрашивает ход опросом.

Результат пишется в сессию (Item.text) по мере готовности, поэтому его не потеряешь, если закрыть
мини-апп: при следующем открытии страницы уже с текстом, а идущую задачу приложение подхватит.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from . import ocr
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

    def view(self) -> dict:
        return {"state": self.state, "total": self.total, "done": self.done, "position": self.position,
                "finished": self.finished, "error": self.error}


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
    job = _jobs[uid] = Job(total=len(todo))
    task = asyncio.create_task(_run(job, uid, todo, store, cfg))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return job


def cancel(uid: int) -> None:
    if job := _jobs.get(uid):
        job.cancel = True


def _page_paragraphs(path: Path, rotation: int, opts: BuildOptions) -> list[str]:
    # те же поворот и режим («Скан» сильно помогает), что и в итоговом PDF
    img, _ = _render_page(open_image(path), rotation, opts)
    return ocr.paragraphs(ocr.recognize(img))


async def _run(job: Job, uid: int, todo: list[str], store: SessionStore, cfg: Config) -> None:
    today = date.today().isoformat()

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
                paragraphs = await asyncio.to_thread(_page_paragraphs, store.dir(uid) / item.file, item.rotation, session.options)
                store.set_text(uid, item_id, paragraphs)
                store.ocr_add(uid, today, 1)
                job.done += 1
                job.finished.append(item_id)
            job.state = "done"
    except Exception:
        logging.exception("Распознавание не удалось")
        job.state, job.error = "error", "Не получилось распознать текст. Попробуй ещё раз."
