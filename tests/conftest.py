"""Общие настройки тестов: шрифт для титульника/PDF из текста, если на машине нет Times New Roman и Liberation Serif."""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

DEJAVU = Path("/usr/share/fonts/truetype/dejavu")
if "TITLE_FONT" not in os.environ and (DEJAVU / "DejaVuSerif.ttf").exists():
    os.environ["TITLE_FONT"] = str(DEJAVU / "DejaVuSerif.ttf")
    os.environ["TITLE_FONT_BOLD"] = str(DEJAVU / "DejaVuSerif-Bold.ttf")
