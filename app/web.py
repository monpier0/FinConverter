"""HTTP API мини-аппа + раздача статики."""

import hashlib
import hmac
import json
import time
from dataclasses import asdict
from urllib.parse import parse_qsl

from aiohttp import web

from .config import ROOT, Config
from .pdf import BuildOptions
from .service import BuildError, build_and_send
from .storage import SessionStore, TooManyItems, UnsupportedFile
from .title import WORK_TYPES, TitlePage

WEBAPP_DIR = ROOT / "webapp"
INIT_DATA_TTL = 24 * 3600


def validate_init_data(init_data: str, bot_token: str) -> dict | None:
    """Проверка подписи Telegram.WebApp.initData (core.telegram.org/bots/webapps#validating-data)."""
    params = dict(parse_qsl(init_data, keep_blank_values=True))
    received = params.pop("hash", None)
    if not received:
        return None
    check = "\n".join(f"{k}={v}" for k, v in sorted(params.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, received):
        return None
    if time.time() - int(params.get("auth_date", 0)) > INIT_DATA_TTL:
        return None
    return json.loads(params.get("user", "{}"))


def thumb_sig(secret: str, uid: int, item_id: str) -> str:
    # <img src> не умеет слать заголовки, поэтому превью подписываем в URL
    return hmac.new(secret.encode(), f"{uid}:{item_id}".encode(), hashlib.sha256).hexdigest()[:20]


@web.middleware
async def auth_middleware(request: web.Request, handler):
    if not request.path.startswith("/api/") or request.path.startswith("/api/thumb/"):
        return await handler(request)
    cfg: Config = request.app["cfg"]
    user = validate_init_data(request.headers.get("X-Init-Data", ""), cfg.bot_token)
    if user and user.get("id"):
        request["uid"] = int(user["id"])
    elif cfg.dev_user_id:
        request["uid"] = cfg.dev_user_id
    else:
        return web.json_response({"error": "Открой мини-апп из Telegram"}, status=401)
    return await handler(request)


def _session_json(request: web.Request) -> web.Response:
    uid = request["uid"]
    store: SessionStore = request.app["store"]
    cfg: Config = request.app["cfg"]
    session = store.load(uid)
    items = []
    for item in session.items:
        data = asdict(item)
        data.pop("file")
        if item.kind == "image":
            data["thumb"] = f"/api/thumb/{uid}/{item.id}?s={thumb_sig(cfg.bot_token, uid, item.id)}"
        items.append(data)
    return web.json_response({
        "items": items,
        "options": asdict(session.options),
        "title": asdict(store.load_title(uid)),
        "work_types": WORK_TYPES,
        "max_items": store.max_items,
    })


async def get_session(request: web.Request):
    return _session_json(request)


async def upload(request: web.Request):
    store: SessionStore = request.app["store"]
    reader = await request.multipart()
    errors = []
    async for part in reader:
        if part.name != "file":
            continue
        data = await part.read(decode=False)
        name = part.filename or ""
        kind = "pdf" if name.lower().endswith(".pdf") or part.headers.get("Content-Type") == "application/pdf" else "image"
        try:
            store.add(request["uid"], bytes(data), kind, name)
        except TooManyItems:
            errors.append(f"Максимум {store.max_items} файлов")
            break
        except UnsupportedFile:
            errors.append(f"Не удалось открыть {name or 'файл'}")
    resp = _session_json(request)
    if errors:
        body = json.loads(resp.body)
        body["errors"] = errors
        return web.json_response(body)
    return resp


async def reorder(request: web.Request):
    body = await request.json()
    request.app["store"].reorder(request["uid"], [str(i) for i in body.get("ids", [])])
    return _session_json(request)


async def rotate(request: web.Request):
    body = await request.json()
    request.app["store"].rotate(request["uid"], request.match_info["item_id"], int(body.get("rotation", 0)))
    return _session_json(request)


async def delete_item(request: web.Request):
    request.app["store"].remove(request["uid"], request.match_info["item_id"])
    return _session_json(request)


async def clear(request: web.Request):
    request.app["store"].clear(request["uid"])
    return _session_json(request)


async def set_options(request: web.Request):
    opts = BuildOptions.from_dict(await request.json())
    request.app["store"].set_options(request["uid"], opts)
    return _session_json(request)


async def set_title(request: web.Request):
    request.app["store"].save_title(request["uid"], TitlePage.from_dict(await request.json()))
    return _session_json(request)


async def build(request: web.Request):
    store: SessionStore = request.app["store"]
    if request.can_read_body:
        body = await request.json()
        store.set_options(request["uid"], BuildOptions.from_dict(body))
        if isinstance(body.get("title"), dict):
            store.save_title(request["uid"], TitlePage.from_dict(body["title"]))
    try:
        pages, size = await build_and_send(request.app["bot"], store, request["uid"])
    except BuildError as e:
        return web.json_response({"error": e.message}, status=400)
    return web.json_response({"ok": True, "pages": pages, "size": size})


async def thumb(request: web.Request):
    cfg: Config = request.app["cfg"]
    uid, item_id = int(request.match_info["uid"]), request.match_info["item_id"]
    if not hmac.compare_digest(request.query.get("s", ""), thumb_sig(cfg.bot_token, uid, item_id)):
        raise web.HTTPForbidden()
    path = request.app["store"].thumb_path(uid, item_id)
    if not path.exists():
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={"Cache-Control": "private, max-age=86400"})


async def index(request: web.Request):
    return web.FileResponse(WEBAPP_DIR / "index.html", headers={"Cache-Control": "no-cache"})


def create_app(cfg: Config, store: SessionStore, bot) -> web.Application:
    app = web.Application(middlewares=[auth_middleware], client_max_size=25 * 1024 * 1024)
    app["cfg"], app["store"], app["bot"] = cfg, store, bot
    app.router.add_get("/", index)
    app.router.add_static("/static/", WEBAPP_DIR)
    app.router.add_get("/api/session", get_session)
    app.router.add_post("/api/upload", upload)
    app.router.add_post("/api/order", reorder)
    app.router.add_post("/api/items/{item_id}/rotate", rotate)
    app.router.add_delete("/api/items/{item_id}", delete_item)
    app.router.add_post("/api/clear", clear)
    app.router.add_post("/api/options", set_options)
    app.router.add_post("/api/title", set_title)
    app.router.add_post("/api/build", build)
    app.router.add_get("/api/thumb/{uid}/{item_id}", thumb)
    return app
