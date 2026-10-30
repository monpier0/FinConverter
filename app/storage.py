"""Сессии пользователей на диске: загруженные фото/PDF, их порядок и настройки сборки.

Все методы синхронные и не содержат await, поэтому внутри event loop
каждый вызов атомарен — альбом из 10 фото не перетрёт манифест.
"""

import json
import shutil
import uuid
from dataclasses import asdict, dataclass, field
from io import BytesIO
from pathlib import Path

from .pdf import BuildOptions, open_image, pdf_page_count
from .title import TitlePage

THUMB_SIZE = (360, 480)


@dataclass
class Item:
    id: str
    kind: str  # "image" | "pdf"
    file: str
    name: str = ""
    rotation: int = 0  # 0/90/180/270, по часовой
    pages: int = 1


@dataclass
class Session:
    items: list[Item] = field(default_factory=list)
    options: BuildOptions = field(default_factory=BuildOptions)


class TooManyItems(Exception):
    pass


class UnsupportedFile(Exception):
    pass


class SessionStore:
    def __init__(self, root: Path, max_items: int = 100):
        self.root = root
        self.max_items = max_items
        root.mkdir(parents=True, exist_ok=True)

    def dir(self, uid: int) -> Path:
        return self.root / str(uid)

    def _manifest(self, uid: int) -> Path:
        return self.dir(uid) / "session.json"

    def load(self, uid: int) -> Session:
        path = self._manifest(uid)
        if not path.exists():
            return Session()
        raw = json.loads(path.read_text("utf-8"))
        return Session(
            items=[Item(**i) for i in raw.get("items", [])],
            options=BuildOptions.from_dict(raw.get("options", {})),
        )

    def save(self, uid: int, session: Session) -> None:
        self.dir(uid).mkdir(parents=True, exist_ok=True)
        data = {"items": [asdict(i) for i in session.items], "options": asdict(session.options)}
        tmp = self._manifest(uid).with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
        tmp.replace(self._manifest(uid))

    def add(self, uid: int, data: bytes, kind: str, name: str = "") -> Item:
        session = self.load(uid)
        if len(session.items) >= self.max_items:
            raise TooManyItems
        item_id = uuid.uuid4().hex[:12]
        folder = self.dir(uid)
        folder.mkdir(parents=True, exist_ok=True)

        if kind == "image":
            try:
                img = open_image(BytesIO(data))
            except Exception as e:
                raise UnsupportedFile from e
            # храним уже нормализованный JPEG — дальше не нужно возиться с HEIC/PNG/EXIF
            file = f"{item_id}.jpg"
            img.save(folder / file, "JPEG", quality=95)
            thumb = img.copy()
            thumb.thumbnail(THUMB_SIZE)
            thumb.save(folder / f"{item_id}.thumb.jpg", "JPEG", quality=80)
            item = Item(id=item_id, kind="image", file=file, name=name)
        else:
            file = f"{item_id}.pdf"
            (folder / file).write_bytes(data)
            try:
                pages = pdf_page_count(folder / file)
            except Exception as e:
                (folder / file).unlink(missing_ok=True)
                raise UnsupportedFile from e
            item = Item(id=item_id, kind="pdf", file=file, name=name, pages=pages)

        session.items.append(item)
        self.save(uid, session)
        return item

    def remove(self, uid: int, item_id: str) -> None:
        session = self.load(uid)
        for item in session.items:
            if item.id == item_id:
                (self.dir(uid) / item.file).unlink(missing_ok=True)
                (self.dir(uid) / f"{item.id}.thumb.jpg").unlink(missing_ok=True)
        session.items = [i for i in session.items if i.id != item_id]
        self.save(uid, session)

    def reorder(self, uid: int, ids: list[str]) -> None:
        session = self.load(uid)
        by_id = {i.id: i for i in session.items}
        ordered = [by_id.pop(i) for i in ids if i in by_id]
        session.items = ordered + list(by_id.values())  # неизвестные id не теряем
        self.save(uid, session)

    def rotate(self, uid: int, item_id: str, rotation: int) -> None:
        session = self.load(uid)
        for item in session.items:
            if item.id == item_id:
                item.rotation = rotation % 360
        self.save(uid, session)

    def set_options(self, uid: int, options: BuildOptions) -> None:
        session = self.load(uid)
        session.options = options
        self.save(uid, session)

    def clear(self, uid: int) -> None:
        """Удаляет файлы, но сохраняет настройки — их обычно не хочется выставлять заново."""
        options = self.load(uid).options
        shutil.rmtree(self.dir(uid), ignore_errors=True)
        if options != BuildOptions():
            options.filename = ""
            self.save(uid, Session(options=options))

    # титульный лист живёт отдельно от сессии: ФИО и группу не нужно вводить заново
    def _title_path(self, uid: int) -> Path:
        return self.root / "_titles" / f"{uid}.json"

    def load_title(self, uid: int) -> TitlePage:
        path = self._title_path(uid)
        if not path.exists():
            return TitlePage()
        return TitlePage.from_dict(json.loads(path.read_text("utf-8")))

    def save_title(self, uid: int, title: TitlePage) -> None:
        path = self._title_path(uid)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(title), ensure_ascii=False), "utf-8")

    # сколько страниц человек уже распознал сегодня (лимит, чтобы один не занял сервер на час)
    def _ocr_path(self, uid: int) -> Path:
        return self.root / "_ocr" / f"{uid}.json"

    def ocr_used(self, uid: int, today: str) -> int:
        path = self._ocr_path(uid)
        if not path.exists():
            return 0
        raw = json.loads(path.read_text("utf-8"))
        return int(raw.get("pages", 0)) if raw.get("date") == today else 0

    def ocr_add(self, uid: int, today: str, pages: int) -> None:
        path = self._ocr_path(uid)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"date": today, "pages": self.ocr_used(uid, today) + pages}), "utf-8")

    def thumb_path(self, uid: int, item_id: str) -> Path:
        return self.dir(uid) / f"{item_id}.thumb.jpg"
