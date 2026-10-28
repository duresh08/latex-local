"""Where LaTeX Lab keeps its own state (never inside your project folder)."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import sys
import threading
from pathlib import Path
from typing import Any, Dict

PROJECT_DEFAULTS: Dict[str, Any] = {
    "mainFile": None,          # auto-detected when None
    "compiler": "pdflatex",    # pdflatex | xelatex | lualatex | latex
    "engine": "auto",          # auto | latexmk | builtin | docker | tectonic
    "shellEscape": True,       # Overleaf compiles with \write18 enabled
    "haltOnError": False,      # Overleaf's "Stop on first error"
    "timeout": 240,            # seconds
    "dockerImage": "texlive/texlive:latest",
}

APP_DEFAULTS: Dict[str, Any] = {
    "recent": [],              # most recent first
    "texBinDir": "",           # manual override for the folder holding pdflatex
}


def app_dir() -> Path:
    override = os.environ.get("LATEXLAB_HOME")
    if override:
        base = Path(override)
    elif sys.platform == "win32":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "LaTeXLab"
    else:
        base = Path.home() / ".latexlab"
    base.mkdir(parents=True, exist_ok=True)
    return base


def default_projects_dir() -> Path:
    return Path.home() / "Documents" / "LaTeX"


def project_key(root: Path) -> str:
    norm = os.path.normcase(str(Path(root).resolve()))
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:16]


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.latexlab-tmp")
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


class JsonStore:
    """A small JSON file with defaults, safe to use from several threads."""

    def __init__(self, path: Path, defaults: Dict[str, Any]):
        self.path = path
        self.defaults = defaults
        self._lock = threading.Lock()

    def load(self) -> Dict[str, Any]:
        with self._lock:
            data = copy.deepcopy(self.defaults)
            try:
                stored = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(stored, dict):
                    data.update(stored)
            except (OSError, ValueError):
                pass
            return data

    def update(self, changes: Dict[str, Any]) -> Dict[str, Any]:
        data = self.load()
        data.update({k: v for k, v in changes.items() if k in self.defaults})
        with self._lock:
            atomic_write_bytes(self.path, json.dumps(data, indent=2).encode("utf-8"))
        return data


def app_settings() -> JsonStore:
    return JsonStore(app_dir() / "config.json", APP_DEFAULTS)


def project_settings(root: Path) -> JsonStore:
    return JsonStore(app_dir() / "projects" / f"{project_key(root)}.json", PROJECT_DEFAULTS)


def build_dir(root: Path) -> Path:
    return app_dir() / "build" / project_key(root)


def remember_project(root: Path) -> None:
    store = app_settings()
    root_s = str(Path(root).resolve())
    recent = [p for p in store.load()["recent"] if os.path.normcase(p) != os.path.normcase(root_s)]
    store.update({"recent": [root_s] + recent[:11]})


def forget_project(root: str) -> None:
    store = app_settings()
    store.update({"recent": [p for p in store.load()["recent"] if os.path.normcase(p) != os.path.normcase(root)]})
