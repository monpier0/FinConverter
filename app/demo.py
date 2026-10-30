"""Только интерфейс мини-аппа, без бота и токена: python -m app.demo → http://localhost:8080/?demo"""

import os

from aiohttp import web

from .web import WEBAPP_DIR, index


def main() -> None:
    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_static("/static/", WEBAPP_DIR)
    port = int(os.getenv("PORT", "8080"))
    print(f"Демо мини-аппа: http://localhost:{port}/?demo")
    web.run_app(app, host="127.0.0.1", port=port, print=None)


if __name__ == "__main__":
    main()
