"""Обновление бота из git по команде /update.

Работает, когда клон репозитория лежит в ROOT (в Docker его монтируют в /app):
подтягиваем новый код, доустанавливаем зависимости, а перезапуск делает Docker (restart policy).
"""

import asyncio
import json
import os
import sys
from pathlib import Path

from . import config

MARKER = "_update.json"  # кому сообщить «перезапустился» после старта


class UpdateError(Exception):
    pass


async def _run(*args: str, timeout: int = 120) -> str:
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=config.ROOT, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},  # приватный репозиторий без доступа — ошибка, а не зависание
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise UpdateError(f"{args[0]} не ответил за {timeout} с") from None
    text = out.decode("utf-8", "replace").strip()
    if proc.returncode:
        raise UpdateError(text[-600:] or f"{args[0]} завершился с кодом {proc.returncode}")
    return text


def _git(*args: str, timeout: int = 120):
    # safe.directory: смонтированный клон может принадлежать другому пользователю хоста
    return _run("git", "-c", f"safe.directory={config.ROOT}", *args, timeout=timeout)


def available() -> bool:
    return (config.ROOT / ".git").exists()


async def version() -> str:
    return await _git("log", "-1", "--format=%h %s")


async def update() -> list[str]:
    """Подтягивает новый код (git pull --ff-only). Возвращает новые коммиты, пусто — если обновлений нет."""
    old = await _git("rev-parse", "HEAD")
    await _git("fetch", "--quiet")
    new = await _git("rev-parse", "@{u}")
    if old == new:
        return []
    commits = (await _git("log", "--format=%h %s", "-n", "10", f"{old}..{new}")).splitlines()
    changed = (await _git("diff", "--name-only", old, new)).splitlines()
    await _git("merge", "--ff-only", new)
    if "requirements.txt" in changed:
        try:
            await _run(sys.executable, "-m", "pip", "install", "-q", "-r", "requirements.txt", timeout=600)
        except UpdateError as e:
            raise UpdateError(f"Код обновлён, но зависимости не поставились, бот не перезапущен:\n{e}") from e
    return commits


def mark_restart(data_dir: Path, uid: int) -> None:
    (data_dir / MARKER).write_text(json.dumps({"uid": uid}), "utf-8")


def pop_restart(data_dir: Path) -> int | None:
    path = data_dir / MARKER
    if not path.exists():
        return None
    try:
        return int(json.loads(path.read_text("utf-8"))["uid"])
    except (ValueError, KeyError, OSError):
        return None
    finally:
        path.unlink(missing_ok=True)
