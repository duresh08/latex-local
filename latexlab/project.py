"""A LaTeX project on disk: safe file access, main-file detection, symbols, search."""

from __future__ import annotations

import hashlib
import io
import os
import re
import shutil
import time
import zipfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from . import config

IGNORED_DIRS = {".git", ".hg", ".svn", "__pycache__", "node_modules", ".latexlab", ".vscode", ".idea"}
IGNORED_FILES = {".DS_Store", "Thumbs.db", "desktop.ini"}
BINARY_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp", ".ico", ".pdf", ".eps", ".ps",
    ".zip", ".gz", ".tar", ".7z", ".rar", ".otf", ".ttf", ".woff", ".woff2", ".pfb", ".mp4", ".mov",
    ".mp3", ".wav", ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt", ".dvi", ".xdv", ".synctex",
    ".jar", ".exe", ".dll", ".so", ".dylib", ".pyc", ".npy", ".pkl", ".h5", ".parquet",
}
TEXLIKE_EXTS = {".tex", ".ltx", ".sty", ".cls", ".bib", ".bbx", ".cbx", ".def", ".cfg", ".tikz", ".pgf", ".dtx", ".ins"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".pdf", ".eps", ".svg", ".bmp", ".tif", ".tiff", ".webp"}

COMMENT_RE = re.compile(r"(?<!\\)%.*")
DOCCLASS_RE = re.compile(r"^\s*\\documentclass", re.M)
LABEL_RE = re.compile(r"\\label\s*\{([^}]+)\}")
BIBITEM_RE = re.compile(r"\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}")
BIB_ENTRY_RE = re.compile(r"@\s*(\w+)\s*[{(]\s*([^,\s{}()]+)\s*,")
NEWCMD_RE = re.compile(
    r"\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|"
    r"NewDocumentCommand|RenewDocumentCommand|DeclareDocumentCommand)\*?\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*(?:\[(\d)\])?"
)
DEF_RE = re.compile(r"\\(?:def|gdef|edef|let)\s*\\([A-Za-z@]+)")
NEWENV_RE = re.compile(
    r"\\(?:newenvironment|renewenvironment|newtheorem|declaretheorem|NewDocumentEnvironment|newtcolorbox|newmdenv|lstnewenvironment)"
    r"\*?\s*(?:\[[^\]]*\])?\s*\{([A-Za-z@*]+)\}"
)
BIB_FIELD_RE = {
    f: re.compile(rf"\b{f}\s*=\s*[{{\"](.*?)[}}\"]\s*,?\s*$", re.I | re.M) for f in ("title", "author", "year", "date")
}

NEW_PROJECT_TEMPLATE = r"""\documentclass[11pt]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath, amssymb, graphicx}
\usepackage[margin=1in]{geometry}
\usepackage{hyperref}

\title{%(title)s}
\author{}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}
Start writing here. Press \texttt{Ctrl+S} to save and compile.

\end{document}
"""


class ProjectError(Exception):
    status = 400


class NotFound(ProjectError):
    status = 404


class Conflict(ProjectError):
    status = 409

    def __init__(self, message: str, version: Optional[str] = None):
        super().__init__(message)
        self.version = version


def file_version(path: Path) -> Optional[str]:
    try:
        st = path.stat()
    except OSError:
        return None
    return f"{st.st_mtime_ns}-{st.st_size}"


def is_probably_binary(path: Path) -> bool:
    if path.suffix.lower() in BINARY_EXTS:
        return True
    try:
        with open(path, "rb") as fh:
            chunk = fh.read(8192)
    except OSError:
        return True
    return b"\x00" in chunk


def decode_text(data: bytes) -> Tuple[str, str]:
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", errors="replace"), "utf-8-sig"
    try:
        return data.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return data.decode("latin-1"), "latin-1"


def strip_comments(text: str) -> str:
    return COMMENT_RE.sub("", text)


def _write_with_retry(path: Path, data: bytes) -> None:
    """Atomic replace; Windows can refuse while another program (antivirus, Dropbox) holds the file."""
    tmp = path.with_name(f".{path.name}.latexlab-tmp")
    for attempt in range(6):
        try:
            with open(tmp, "wb") as fh:
                fh.write(data)
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.05 * (attempt + 1))
    try:
        tmp.unlink()
    except OSError:
        pass
    with open(path, "wb") as fh:
        fh.write(data)


class Project:
    def __init__(self, root: Path):
        root = Path(root).expanduser().resolve()
        if not root.is_dir():
            raise NotFound(f"Folder not found: {root}")
        self.root = root
        self.name = root.name
        self.settings_store = config.project_settings(root)
        self._symbol_cache: Dict[str, Tuple[str, dict]] = {}

    # ------------------------------------------------------------------ paths
    def resolve(self, rel: str, must_exist: bool = False) -> Path:
        rel = (rel or "").replace("\\", "/").strip().strip("/")
        parts = [p for p in rel.split("/") if p not in ("", ".")]
        if any(p == ".." for p in parts):
            raise ProjectError("Paths may not contain '..'")
        path = self.root.joinpath(*parts) if parts else self.root
        resolved = path.resolve()
        if resolved != self.root and self.root not in resolved.parents:
            raise ProjectError("Path is outside the project")
        if parts and parts[0] in (".git",):
            raise ProjectError("The .git folder is managed by git, not the editor")
        if must_exist and not path.exists():
            raise NotFound(f"Not found: {rel}")
        return path

    def rel(self, path: Path) -> str:
        return Path(path).resolve().relative_to(self.root).as_posix()

    # ------------------------------------------------------------------- tree
    def walk_files(self) -> List[Tuple[str, os.stat_result]]:
        out = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS)
            base = Path(dirpath)
            for fn in filenames:
                if fn in IGNORED_FILES or fn.endswith(".latexlab-tmp"):
                    continue
                full = base / fn
                try:
                    st = full.stat()
                except OSError:
                    continue
                out.append((full.relative_to(self.root).as_posix(), st))
        return out

    def tree(self) -> dict:
        def node_for(dir_path: Path, rel: str) -> dict:
            children = []
            try:
                entries = list(os.scandir(dir_path))
            except OSError:
                entries = []
            dirs = sorted((e for e in entries if e.is_dir() and e.name not in IGNORED_DIRS), key=lambda e: e.name.lower())
            files = sorted(
                (e for e in entries if e.is_file() and e.name not in IGNORED_FILES and not e.name.endswith(".latexlab-tmp")),
                key=lambda e: e.name.lower(),
            )
            for d in dirs:
                children.append(node_for(Path(d.path), f"{rel}/{d.name}" if rel else d.name))
            for f in files:
                try:
                    size = f.stat().st_size
                except OSError:
                    size = 0
                children.append({"name": f.name, "path": f"{rel}/{f.name}" if rel else f.name, "type": "file", "size": size})
            return {"name": dir_path.name if rel else self.name, "path": rel, "type": "dir", "children": children}

        return node_for(self.root, "")

    def signature(self) -> str:
        h = hashlib.sha1()
        for rel, st in self.walk_files():
            h.update(f"{rel}\0{st.st_mtime_ns}\0{st.st_size}\n".encode("utf-8", "surrogateescape"))
        return h.hexdigest()

    def versions(self, paths: List[str]) -> Dict[str, Optional[str]]:
        out = {}
        for p in paths:
            try:
                out[p] = file_version(self.resolve(p))
            except ProjectError:
                out[p] = None
        return out

    # ------------------------------------------------------------------ files
    def read_file(self, rel: str) -> dict:
        path = self.resolve(rel, must_exist=True)
        if path.is_dir():
            raise ProjectError("That is a folder")
        if is_probably_binary(path):
            return {"path": rel, "binary": True, "size": path.stat().st_size, "version": file_version(path)}
        data = path.read_bytes()
        text, encoding = decode_text(data)
        return {
            "path": rel,
            "binary": False,
            "content": text.replace("\r\n", "\n"),
            "eol": "crlf" if b"\r\n" in data else "lf",
            "encoding": encoding,
            "version": file_version(path),
        }

    def read_bytes(self, rel: str) -> Tuple[Path, bytes]:
        path = self.resolve(rel, must_exist=True)
        if path.is_dir():
            raise ProjectError("That is a folder")
        return path, path.read_bytes()

    def write_file(self, rel: str, content: str, base_version: Optional[str] = None, force: bool = False) -> dict:
        path = self.resolve(rel)
        if path.is_dir():
            raise ProjectError("That is a folder")
        eol, encoding = "lf", "utf-8"
        if path.exists():
            current = file_version(path)
            if base_version and not force and current != base_version:
                raise Conflict("The file changed on disk since you opened it", current)
            existing = path.read_bytes()
            eol = "crlf" if b"\r\n" in existing else "lf"
            _, encoding = decode_text(existing)
        text = content.replace("\r\n", "\n")
        if eol == "crlf":
            text = text.replace("\n", "\r\n")
        try:
            data = text.encode(encoding)
        except UnicodeEncodeError:
            data = text.encode("utf-8")
        path.parent.mkdir(parents=True, exist_ok=True)
        _write_with_retry(path, data)
        return {"path": rel, "version": file_version(path)}

    def create(self, rel: str, kind: str, content: str = "") -> dict:
        path = self.resolve(rel)
        if not rel.strip("/"):
            raise ProjectError("A name is required")
        if path.exists():
            raise ProjectError(f"'{rel}' already exists")
        if kind == "dir":
            path.mkdir(parents=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content.encode("utf-8"))
        return {"path": self.rel(path)}

    def rename(self, src: str, dst: str) -> dict:
        a = self.resolve(src, must_exist=True)
        b = self.resolve(dst)
        if a == self.root:
            raise ProjectError("Cannot rename the project root")
        if b.exists() and os.path.normcase(str(a)) != os.path.normcase(str(b)):
            raise ProjectError(f"'{dst}' already exists")
        if b == a or a in b.parents:
            raise ProjectError("Cannot move a folder into itself")
        b.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(a), str(b))
        return {"path": self.rel(b)}

    def delete(self, rel: str) -> dict:
        path = self.resolve(rel, must_exist=True)
        if path == self.root:
            raise ProjectError("Cannot delete the project root")
        if path.is_dir():
            def _onerror(func, p, _exc):
                os.chmod(p, 0o700)
                func(p)
            shutil.rmtree(path, onerror=_onerror)
        else:
            path.unlink()
        return {"path": rel}

    def upload(self, dir_rel: str, name: str, data: bytes, overwrite: bool = False) -> dict:
        name = name.replace("\\", "/").split("/")[-1]
        if not name or name in (".", ".."):
            raise ProjectError("Invalid file name")
        target = self.resolve(f"{dir_rel.strip('/')}/{name}" if dir_rel.strip("/") else name)
        if target.exists() and not overwrite:
            raise Conflict(f"'{self.rel(target) if target.exists() else name}' already exists")
        target.parent.mkdir(parents=True, exist_ok=True)
        _write_with_retry(target, data)
        return {"path": self.rel(target), "version": file_version(target)}

    # --------------------------------------------------------------- settings
    def settings(self) -> dict:
        s = self.settings_store.load()
        candidates = self.main_candidates()
        main = s.get("mainFile")
        try:
            main_ok = bool(main) and (main in candidates or self.resolve(main).is_file())
        except ProjectError:
            main_ok = False
        if not main_ok:
            s["mainFile"] = candidates[0] if candidates else None
        s["mainCandidates"] = candidates
        return s

    def update_settings(self, changes: dict) -> dict:
        allowed = {}
        if "compiler" in changes and changes["compiler"] in ("pdflatex", "xelatex", "lualatex", "latex"):
            allowed["compiler"] = changes["compiler"]
        if "engine" in changes and changes["engine"] in ("auto", "latexmk", "builtin", "docker", "tectonic"):
            allowed["engine"] = changes["engine"]
        if "mainFile" in changes:
            mf = changes["mainFile"]
            if mf and not self.resolve(mf).is_file():
                raise ProjectError(f"Main file not found: {mf}")
            allowed["mainFile"] = mf or None
        for key in ("shellEscape", "haltOnError"):
            if key in changes:
                allowed[key] = bool(changes[key])
        if "timeout" in changes:
            allowed["timeout"] = max(10, min(3600, int(changes["timeout"])))
        if "dockerImage" in changes and str(changes["dockerImage"]).strip():
            allowed["dockerImage"] = str(changes["dockerImage"]).strip()
        self.settings_store.update(allowed)
        return self.settings()

    def main_candidates(self) -> List[str]:
        found = []
        for rel, st in self.walk_files():
            if not rel.lower().endswith((".tex", ".ltx")) or st.st_size > 5_000_000:
                continue
            try:
                head = (self.root / rel).read_text(encoding="utf-8", errors="replace")[:20000]
            except OSError:
                continue
            if DOCCLASS_RE.search(strip_comments(head)):
                found.append(rel)

        def rank(rel: str):
            name = rel.rsplit("/", 1)[-1].lower()
            return (0 if name in ("main.tex", "thesis.tex", "paper.tex", "report.tex") else 1, rel.count("/"), rel.lower())

        return sorted(found, key=rank)

    # ---------------------------------------------------------------- symbols
    def _scan_file(self, rel: str, st: os.stat_result) -> dict:
        key = f"{st.st_mtime_ns}-{st.st_size}"
        cached = self._symbol_cache.get(rel)
        if cached and cached[0] == key:
            return cached[1]
        result: dict = {"labels": [], "bib": [], "commands": [], "environments": []}
        try:
            text = (self.root / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = ""
        if rel.lower().endswith(".bib"):
            for m in BIB_ENTRY_RE.finditer(text):
                kind = m.group(1).lower()
                if kind in ("string", "comment", "preamble"):
                    continue
                body = text[m.end(): m.end() + 3000]
                nxt = body.find("\n@")
                if nxt >= 0:
                    body = body[:nxt]
                info = {"key": m.group(2), "type": kind, "file": rel}
                for field, rx in BIB_FIELD_RE.items():
                    fm = rx.search(body)
                    if fm:
                        info[field] = re.sub(r"[{}]", "", fm.group(1))[:160]
                result["bib"].append(info)
        else:
            lines = text.split("\n")
            for i, raw in enumerate(lines):
                line = strip_comments(raw)
                if "\\" not in line:
                    continue
                for m in LABEL_RE.finditer(line):
                    result["labels"].append({"label": m.group(1).strip(), "file": rel, "line": i + 1, "context": raw.strip()[:120]})
                for m in BIBITEM_RE.finditer(line):
                    result["bib"].append({"key": m.group(1).strip(), "type": "bibitem", "file": rel})
                for m in NEWCMD_RE.finditer(line):
                    result["commands"].append({"name": m.group(1), "args": int(m.group(2) or 0), "file": rel})
                for m in DEF_RE.finditer(line):
                    result["commands"].append({"name": m.group(1), "args": 0, "file": rel})
                for m in NEWENV_RE.finditer(line):
                    result["environments"].append({"name": m.group(1), "file": rel})
        self._symbol_cache[rel] = (key, result)
        return result

    def symbols(self) -> dict:
        out: dict = {"labels": [], "bib": [], "commands": [], "environments": [], "files": []}
        for rel, st in self.walk_files():
            out["files"].append(rel)
            ext = os.path.splitext(rel)[1].lower()
            if ext in TEXLIKE_EXTS and st.st_size < 5_000_000:
                for k, v in self._scan_file(rel, st).items():
                    out[k].extend(v)
        return out

    # ----------------------------------------------------------------- search
    def search(self, query: str, regex: bool = False, case: bool = False, limit: int = 1000) -> dict:
        if not query:
            return {"results": [], "truncated": False}
        flags = 0 if case else re.I
        try:
            rx = re.compile(query if regex else re.escape(query), flags)
        except re.error as exc:
            raise ProjectError(f"Invalid regular expression: {exc}")
        results = []
        for rel, st in self.walk_files():
            if st.st_size > 5_000_000:
                continue
            path = self.root / rel
            if is_probably_binary(path):
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for i, line in enumerate(text.split("\n")):
                m = rx.search(line)
                if m:
                    results.append({"path": rel, "line": i + 1, "col": m.start(), "len": m.end() - m.start(), "text": line[:300]})
                    if len(results) >= limit:
                        return {"results": results, "truncated": True}
        return {"results": results, "truncated": False}


# --------------------------------------------------------------- creating projects
def create_blank(parent: Path, name: str) -> Path:
    target = _new_target(parent, name)
    target.mkdir(parents=True)
    (target / "main.tex").write_text(NEW_PROJECT_TEMPLATE % {"title": name}, encoding="utf-8")
    return target


def import_zip(parent: Path, name: str, data: bytes) -> Path:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ProjectError("That file is not a valid .zip")
    names = [n for n in zf.namelist() if not n.startswith("__MACOSX/") and not n.endswith(".DS_Store")]
    tops = {n.split("/", 1)[0] for n in names if n.strip("/")}
    strip = ""
    if len(tops) == 1 and all(n.startswith(next(iter(tops)) + "/") or n == next(iter(tops)) + "/" for n in names):
        strip = next(iter(tops)) + "/"
    target = _new_target(parent, name)
    target.mkdir(parents=True)
    root = target.resolve()
    for info in zf.infolist():
        n = info.filename
        if n not in names:
            continue
        rel = n[len(strip):] if strip and n.startswith(strip) else n
        rel = rel.replace("\\", "/").lstrip("/")
        if not rel:
            continue
        dest = (root / rel).resolve()
        if dest != root and root not in dest.parents:
            continue  # zip-slip protection
        if info.is_dir():
            dest.mkdir(parents=True, exist_ok=True)
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info) as src, open(dest, "wb") as out:
            shutil.copyfileobj(src, out)
    return target


def _new_target(parent: Path, name: str) -> Path:
    name = (name or "").strip()
    if not name or any(c in name for c in '<>:"/\\|?*') or name in (".", ".."):
        raise ProjectError("Choose a folder name without any of  < > : \" / \\ | ? *")
    parent = Path(parent).expanduser()
    parent.mkdir(parents=True, exist_ok=True)
    target = parent / name
    if target.exists():
        raise ProjectError(f"{target} already exists")
    return target
