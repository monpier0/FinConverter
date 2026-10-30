import io
import itertools

import pytest
from pypdf import PdfReader

from app.pdf import BuildOptions, build_pdf
from app.storage import Item
from tests.helpers import photo


@pytest.fixture()
def folder(tmp_path):
    (tmp_path / "a.jpg").write_bytes(photo(["тест"], size=(900, 1200)))
    (tmp_path / "b.jpg").write_bytes(photo(size=(1200, 900)))  # альбомная
    return tmp_path


ITEMS = [Item(id="a", kind="image", file="a.jpg"), Item(id="b", kind="image", file="b.jpg", rotation=90)]


@pytest.mark.parametrize("mode,page,quality", itertools.product(["color", "gray", "scan"], ["original", "a4"], ["high", "medium", "low"]))
def test_all_setting_combinations_build(folder, mode, page, quality):
    data, pages = build_pdf(folder, ITEMS, BuildOptions(mode=mode, page=page, quality=quality))
    assert pages == 2 and len(PdfReader(io.BytesIO(data)).pages) == 2


def test_progress_reports_each_file(folder):
    steps = []
    build_pdf(folder, ITEMS, BuildOptions(), progress=lambda done, total: steps.append((done, total)))
    assert steps == [(1, 2), (2, 2)]


def test_invalid_options_fall_back_to_defaults():
    opts = BuildOptions.from_dict({"mode": "x", "page": "y", "quality": "z", "ocr": 1, "filename": "n" * 200})
    assert (opts.mode, opts.page, opts.quality, opts.ocr, len(opts.filename)) == ("color", "original", "medium", True, 80)
