"""Local HTTP server for the editor UI. Binds to 127.0.0.1 only.

Every /api request must carry the per-launch token that is embedded in the
page, and the Host header must be localhost, so other websites open in your
browser can't talk to it.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import string
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Dict, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__, config, toolchain
from .compiler import Builder
from .gitops import Git, GitError
from .project import Conflict, NotFound, Project, ProjectError, create_blank, import_zip

STATIC_DIR = Path(__file__).resolve().parent / "static"
MAX_BODY = 1024 * 1024 * 1024  # 1 GB uploads/zips
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
    ".pdf": "application/pdf", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".map": "application/json",
    ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
}


class App:
    def __init__(self, verbose: bool = False):
        self.token = secrets.token_urlsafe(24)
        self.verbose = verbose
        self.project: Optional[Project] = None
        self.builder: Optional[Builder] = None
        self.port = 0
        self.server = None
        self.last_seen = time.time()
        self._lock = threading.Lock()

    def open_project(self, path: str) -> Project:
        project = Project(Path(path))
        with self._lock:
            self.project = project
            self.builder = Builder(project)
        config.remember_project(project.root)
        return project

    def close_project(self) -> None:
        with self._lock:
            self.project, self.builder = None, None

    def require(self) -> Tuple[Project, Builder]:
        p, b = self.project, self.builder
        if not p or not b:
            raise ProjectError("No project is open")
        return p, b

    def state(self) -> dict:
        recent = []
        for p in config.app_settings().load()["recent"]:
            recent.append({"path": p, "name": Path(p).name, "exists": Path(p).is_dir()})
        proj = None
        if self.project:
            proj = {"name": self.project.name, "root": str(self.project.root), "settings": self.project.settings()}
        return {
            "version": __version__,
            "platform": "windows" if toolchain.WINDOWS else ("mac" if toolchain.MAC else "linux"),
            "project": proj,
            "recent": recent,
            "defaultParent": str(config.default_projects_dir()),
            "home": str(Path.home()),
            "sep": os.sep,
        }


ROUTES: Dict[Tuple[str, str], Callable] = {}


def route(method: str, path: str):
    def deco(fn):
        ROUTES[(method, path)] = fn
        return fn
    return deco


class Request:
    def __init__(self, handler: "Handler", query: dict, body: bytes):
        self.handler = handler
        self.query = query
        self.body = body
        self._json = None

    def q(self, name: str, default: str = "") -> str:
        v = self.query.get(name)
        return v[0] if v else default

    @property
    def json(self) -> dict:
        if self._json is None:
            try:
                self._json = json.loads(self.body.decode("utf-8") or "{}")
            except ValueError:
                raise ProjectError("Invalid JSON body")
        return self._json


class Raw:
    def __init__(self, data: bytes, content_type: str, headers: Optional[dict] = None):
        self.data, self.content_type, self.headers = data, content_type, headers or {}


# ======================================================================= routes
@route("GET", "/api/state")
def r_state(app: App, req: Request):
    return app.state()


@route("GET", "/api/ping")
def r_ping(app: App, req: Request):
    return {"ok": True}


@route("POST", "/api/quit")
def r_quit(app: App, req: Request):
    if app.server:
        threading.Timer(0.3, app.server.shutdown).start()
    return {"ok": True}


@route("POST", "/api/project/open")
def r_open(app: App, req: Request):
    app.open_project(req.json.get("path", ""))
    return app.state()


@route("POST", "/api/project/close")
def r_close(app: App, req: Request):
    app.close_project()
    return app.state()


@route("POST", "/api/project/forget")
def r_forget(app: App, req: Request):
    config.forget_project(req.json.get("path", ""))
    return app.state()


@route("POST", "/api/project/new")
def r_new(app: App, req: Request):
    target = create_blank(Path(req.json.get("parent") or config.default_projects_dir()), req.json.get("name", ""))
    app.open_project(str(target))
    return app.state()


@route("POST", "/api/project/clone")
def r_clone(app: App, req: Request):
    url = (req.json.get("url") or "").strip()
    if not url:
        raise ProjectError("Paste the GitHub repository URL")
    name = (req.json.get("name") or "").strip() or re.sub(r"\.git$", "", url.rstrip("/").split("/")[-1].split(":")[-1])
    parent = Path(req.json.get("parent") or config.default_projects_dir()).expanduser()
    dest = parent / name
    if dest.exists() and any(dest.iterdir()):
        raise ProjectError(f"{dest} already exists and isn't empty. Open it instead, or pick another name.")
    Git.clone(url, dest)
    app.open_project(str(dest))
    return app.state()


@route("POST", "/api/project/import-zip")
def r_import_zip(app: App, req: Request):
    parent = Path(req.q("parent") or config.default_projects_dir()).expanduser()
    target = import_zip(parent, req.q("name"), req.body)
    app.open_project(str(target))
    remote = req.q("remote").strip()
    if toolchain.get().git:
        try:
            Git(target).init(remote or None)
        except GitError:
            pass
    return app.state()


@route("GET", "/api/browse")
def r_browse(app: App, req: Request):
    raw = req.q("path").strip()
    if not raw:
        roots = []
        if toolchain.WINDOWS:
            for letter in string.ascii_uppercase:
                d = f"{letter}:\\"
                if os.path.isdir(d):
                    roots.append({"name": d, "path": d})
        else:
            roots.append({"name": "/", "path": "/"})
        home = Path.home()
        shortcuts = [{"name": "Home", "path": str(home)}]
        for sub in ("Documents", "Desktop", "Downloads", "OneDrive", os.path.join("OneDrive", "Documents")):
            if (home / sub).is_dir():
                shortcuts.append({"name": sub.replace(os.sep, " / "), "path": str(home / sub)})
        return {"path": "", "parent": None, "dirs": roots, "shortcuts": shortcuts}
    path = Path(raw).expanduser()
    if not path.is_dir():
        raise NotFound(f"Folder not found: {path}")
    dirs = []
    try:
        entries = sorted(os.scandir(path), key=lambda e: e.name.lower())
    except OSError as exc:
        raise ProjectError(f"Can't open {path}: {exc.strerror}")
    has_tex = False
    for e in entries:
        try:
            if e.is_dir() and not e.name.startswith((".", "$")):
                dirs.append({"name": e.name, "path": e.path})
            elif e.name.lower().endswith(".tex"):
                has_tex = True
        except OSError:
            continue
    parent = str(path.parent) if path.parent != path else ""
    return {"path": str(path), "parent": parent, "dirs": dirs, "hasTex": has_tex}


@route("GET", "/api/tree")
def r_tree(app: App, req: Request):
    p, _ = app.require()
    return {"tree": p.tree(), "signature": p.signature()}


@route("GET", "/api/signature")
def r_signature(app: App, req: Request):
    p, _ = app.require()
    return {"signature": p.signature()}


@route("POST", "/api/versions")
def r_versions(app: App, req: Request):
    p, _ = app.require()
    return {"versions": p.versions(req.json.get("paths") or [])}


@route("GET", "/api/file")
def r_file(app: App, req: Request):
    p, _ = app.require()
    return p.read_file(req.q("path"))


@route("GET", "/api/raw")
def r_raw(app: App, req: Request):
    p, _ = app.require()
    path, data = p.read_bytes(req.q("path"))
    ctype = MIME.get(path.suffix.lower(), "application/octet-stream")
    return Raw(data, ctype, {"Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff"})


@route("PUT", "/api/file")
def r_save(app: App, req: Request):
    p, _ = app.require()
    j = req.json
    return p.write_file(j.get("path", ""), j.get("content", ""), j.get("baseVersion"), bool(j.get("force")))


@route("POST", "/api/fs/create")
def r_create(app: App, req: Request):
    p, _ = app.require()
    return p.create(req.json.get("path", ""), req.json.get("type", "file"), req.json.get("content", ""))


@route("POST", "/api/fs/rename")
def r_rename(app: App, req: Request):
    p, _ = app.require()
    return p.rename(req.json.get("from", ""), req.json.get("to", ""))


@route("POST", "/api/fs/delete")
def r_delete(app: App, req: Request):
    p, _ = app.require()
    return p.delete(req.json.get("path", ""))


@route("POST", "/api/fs/upload")
def r_upload(app: App, req: Request):
    p, _ = app.require()
    return p.upload(req.q("dir"), req.q("name"), req.body, req.q("overwrite") == "1")


@route("GET", "/api/settings")
def r_settings(app: App, req: Request):
    p, _ = app.require()
    return p.settings()


@route("PUT", "/api/settings")
def r_settings_put(app: App, req: Request):
    p, _ = app.require()
    return p.update_settings(req.json)


@route("GET", "/api/symbols")
def r_symbols(app: App, req: Request):
    p, _ = app.require()
    return p.symbols()


@route("GET", "/api/search")
def r_search(app: App, req: Request):
    p, _ = app.require()
    return p.search(req.q("q"), req.q("regex") == "1", req.q("case") == "1")


@route("POST", "/api/compile")
def r_compile(app: App, req: Request):
    _, b = app.require()
    return b.compile()


@route("POST", "/api/compile/stop")
def r_stop(app: App, req: Request):
    _, b = app.require()
    return {"stopping": b.stop()}


@route("POST", "/api/compile/clear")
def r_clear(app: App, req: Request):
    _, b = app.require()
    b.clear_cache()
    return {"ok": True}


@route("GET", "/api/pdf")
def r_pdf(app: App, req: Request):
    _, b = app.require()
    path = b.pdf_path()
    if not path:
        raise NotFound("No PDF yet. Compile first.")
    return Raw(path.read_bytes(), "application/pdf")


@route("GET", "/api/synctex/forward")
def r_forward(app: App, req: Request):
    _, b = app.require()
    return {"result": b.forward(req.q("file"), int(req.q("line", "1") or 1))}


@route("GET", "/api/synctex/inverse")
def r_inverse(app: App, req: Request):
    _, b = app.require()
    return {"result": b.inverse(int(req.q("page", "1")), float(req.q("x", "0")), float(req.q("y", "0")))}


@route("GET", "/api/doctor")
def r_doctor(app: App, req: Request):
    tc = toolchain.get(refresh=req.q("refresh") == "1")
    image = app.project.settings()["dockerImage"] if app.project else config.PROJECT_DEFAULTS["dockerImage"]
    return tc.report(image)


@route("PUT", "/api/app-settings")
def r_app_settings(app: App, req: Request):
    tex_bin = (req.json.get("texBinDir") or "").strip()
    if tex_bin and not os.path.isdir(tex_bin):
        raise ProjectError(f"Folder not found: {tex_bin}")
    config.app_settings().update({"texBinDir": tex_bin})
    return toolchain.get(refresh=True).report()


def _git(app: App) -> Git:
    p, _ = app.require()
    return Git(p.root)


@route("GET", "/api/git/status")
def r_git_status(app: App, req: Request):
    g = _git(app)
    fetch_error = None
    if req.q("fetch") == "1":
        try:
            g.fetch()
        except GitError as exc:
            fetch_error = {"message": str(exc), "kind": exc.kind}
    st = g.status()
    st["fetchError"] = fetch_error
    return st


@route("GET", "/api/git/diff")
def r_git_diff(app: App, req: Request):
    return {"diff": _git(app).diff(req.q("path"))}


@route("GET", "/api/git/log")
def r_git_log(app: App, req: Request):
    return {"log": _git(app).log()}


@route("POST", "/api/git/init")
def r_git_init(app: App, req: Request):
    return _git(app).init(req.json.get("remote") or None)


@route("POST", "/api/git/remote")
def r_git_remote(app: App, req: Request):
    return _git(app).set_remote(req.json.get("url", ""))


@route("POST", "/api/git/identity")
def r_git_identity(app: App, req: Request):
    return _git(app).set_identity(req.json.get("name", ""), req.json.get("email", ""))


@route("POST", "/api/git/commit")
def r_git_commit(app: App, req: Request):
    return _git(app).commit(req.json.get("message", ""))


@route("POST", "/api/git/pull")
def r_git_pull(app: App, req: Request):
    return _git(app).pull()


@route("POST", "/api/git/push")
def r_git_push(app: App, req: Request):
    return _git(app).push()


@route("POST", "/api/git/sync")
def r_git_sync(app: App, req: Request):
    return _git(app).sync(req.json.get("message", ""))


@route("POST", "/api/git/abort-merge")
def r_git_abort(app: App, req: Request):
    return _git(app).abort_merge()


# ====================================================================== handler
class Handler(BaseHTTPRequestHandler):
    server_version = f"LaTeXLab/{__version__}"
    protocol_version = "HTTP/1.1"
    app: App  # set on the class by make_server

    def log_message(self, fmt, *args):
        if self.app.verbose:
            sys.stderr.write("[latexlab] " + (fmt % args) + "\n")

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_HEAD(self):
        self._dispatch("GET")

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        hostname = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
        return hostname in ("127.0.0.1", "localhost", "[::1]")

    def _send(self, status: int, data: bytes, content_type: str, headers: Optional[dict] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _json(self, status: int, obj) -> None:
        self._send(status, json.dumps(obj).encode("utf-8"), "application/json", {"Cache-Control": "no-store"})

    def _dispatch(self, method: str) -> None:
        if not self._host_ok():
            self._send(403, b"Forbidden host", "text/plain")
            return
        url = urlparse(self.path)
        path = unquote(url.path)
        if path.startswith("/api/"):
            self._api(method, path, parse_qs(url.query))
        else:
            self._static(path)

    def _api(self, method: str, path: str, query: dict) -> None:
        if not secrets.compare_digest(self.headers.get("X-LatexLab-Token", ""), self.app.token):
            self._json(403, {"error": "Missing or wrong token. Reload the page."})
            return
        self.app.last_seen = time.time()
        fn = ROUTES.get((method, path))
        if not fn:
            self._json(404, {"error": f"No such endpoint: {method} {path}"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self._json(413, {"error": "That upload is too large"})
            return
        body = self.rfile.read(length) if length else b""
        try:
            result = fn(self.app, Request(self, query, body))
        except Conflict as exc:
            self._json(409, {"error": str(exc), "version": exc.version})
            return
        except ProjectError as exc:
            self._json(exc.status, {"error": str(exc)})
            return
        except GitError as exc:
            self._json(400, {"error": str(exc), "kind": exc.kind, "output": exc.output[-4000:]})
            return
        except (OSError, ValueError) as exc:
            if self.app.verbose:
                traceback.print_exc()
            self._json(400, {"error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001 - surface anything else to the UI
            traceback.print_exc()
            self._json(500, {"error": f"Internal error: {exc}"})
            return
        if isinstance(result, Raw):
            self._send(200, result.data, result.content_type, {"Cache-Control": "no-store", **result.headers})
        else:
            self._json(200, result)

    def _static(self, path: str) -> None:
        if path in ("/", "/index.html"):
            index = STATIC_DIR / "index.html"
            if not index.exists():
                self._send(500, b"The editor UI hasn't been built. Run: cd frontend && npm install && npm run build",
                           "text/plain; charset=utf-8")
                return
            html = index.read_text(encoding="utf-8").replace("__LATEXLAB_TOKEN__", self.app.token)
            self._send(200, html.encode("utf-8"), MIME[".html"], {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})
            return
        rel = path.lstrip("/")
        target = (STATIC_DIR / rel).resolve()
        if STATIC_DIR not in target.parents or not target.is_file():
            self._send(404, b"Not found", "text/plain")
            return
        ctype = MIME.get(target.suffix.lower(), "application/octet-stream")
        cache = "public, max-age=31536000, immutable" if "/assets/" in path else "no-cache"
        self._send(200, target.read_bytes(), ctype, {"Cache-Control": cache})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False if toolchain.WINDOWS else True


def make_server(app: App, port: int, tries: int = 20) -> Server:
    handler = type("BoundHandler", (Handler,), {"app": app})
    last_exc: Optional[OSError] = None
    for p in range(port, port + tries):
        try:
            srv = Server(("127.0.0.1", p), handler)
            app.port = srv.server_address[1]
            return srv
        except OSError as exc:
            last_exc = exc
    raise SystemExit(f"Couldn't find a free port near {port}: {last_exc}")
