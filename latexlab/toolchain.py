"""Find a working TeX installation, even when it is not on PATH.

Most "LaTeX doesn't work in my IDE" problems are PATH problems: the TeX
installer put its binaries somewhere the IDE never looks. We look in the
standard install locations for TeX Live, MiKTeX and MacTeX ourselves and
put the folder we find at the front of PATH for every compile.
"""

from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Dict, List, Optional

from . import config

WINDOWS = sys.platform == "win32"
MAC = sys.platform == "darwin"

TEX_PROGRAMS = [
    "pdflatex", "xelatex", "lualatex", "latex", "latexmk", "biber", "bibtex", "makeindex",
    "makeglossaries", "dvipdfmx", "kpsewhich", "tlmgr", "mpm", "miktex",
]

# Windows: don't flash a console window for every subprocess.
CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200


def popen_kwargs(new_group: bool = False) -> dict:
    if WINDOWS:
        flags = CREATE_NO_WINDOW | (CREATE_NEW_PROCESS_GROUP if new_group else 0)
        return {"creationflags": flags}
    return {"start_new_session": True} if new_group else {}


def run_quick(cmd: List[str], env: Optional[dict] = None, timeout: float = 20, cwd: Optional[str] = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, env=env, cwd=cwd, timeout=timeout, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **popen_kwargs(),
    )


def _year_sorted(paths: List[str]) -> List[str]:
    def key(p: str):
        m = re.search(r"(\d{4})", p)
        return int(m.group(1)) if m else 0
    return sorted(set(paths), key=key, reverse=True)


def candidate_bin_dirs() -> List[str]:
    dirs: List[str] = []
    home = str(Path.home())
    if WINDOWS:
        drives = ["C:", "D:"]
        for d in drives:
            for arch in ("windows", "win64", "win32"):
                dirs += _year_sorted(glob.glob(f"{d}\\texlive\\*\\bin\\{arch}"))
        for arch in ("windows", "win64", "win32"):
            dirs += _year_sorted(glob.glob(os.path.join(home, "texlive", "*", "bin", arch)))
        local = os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData", "Local"))
        progs = [os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")]
        dirs.append(os.path.join(local, "Programs", "MiKTeX", "miktex", "bin", "x64"))
        dirs.append(os.path.join(local, "Programs", "MiKTeX", "miktex", "bin"))
        for p in progs:
            dirs.append(os.path.join(p, "MiKTeX", "miktex", "bin", "x64"))
            dirs.append(os.path.join(p, "MiKTeX 2.9", "miktex", "bin", "x64"))
    elif MAC:
        dirs.append("/Library/TeX/texbin")
        dirs += _year_sorted(glob.glob("/usr/local/texlive/*/bin/universal-darwin"))
        dirs += _year_sorted(glob.glob("/usr/local/texlive/*/bin/*darwin*"))
        dirs += ["/opt/homebrew/bin", "/usr/local/bin"]
    else:
        dirs += _year_sorted(glob.glob("/usr/local/texlive/*/bin/*-linux*"))
        dirs += _year_sorted(glob.glob(os.path.join(home, "texlive", "*", "bin", "*")))
        dirs += ["/usr/bin", "/usr/local/bin"]
    return dirs


def _which(name: str, directory: Optional[str] = None) -> Optional[str]:
    if directory:
        return shutil.which(name, path=directory)
    return shutil.which(name)


def find_tex_bin(override: str = "") -> Optional[str]:
    if override:
        if _which("pdflatex", override) or _which("xelatex", override):
            return override
    on_path = _which("pdflatex") or _which("xelatex") or _which("lualatex")
    if on_path:
        return os.path.dirname(on_path)
    for d in candidate_bin_dirs():
        if os.path.isdir(d) and (_which("pdflatex", d) or _which("xelatex", d)):
            return d
    return None


def find_docker() -> Optional[str]:
    found = _which("docker")
    if found:
        return found
    for cand in (
        r"C:\Program Files\Docker\Docker\resources\bin\docker.exe",
        "/usr/local/bin/docker",
        "/Applications/Docker.app/Contents/Resources/bin/docker",
    ):
        if os.path.isfile(cand):
            return cand
    return None


def find_git() -> Optional[str]:
    found = _which("git")
    if found:
        return found
    if WINDOWS:
        for cand in (r"C:\Program Files\Git\cmd\git.exe", r"C:\Program Files (x86)\Git\cmd\git.exe",
                     os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Git", "cmd", "git.exe")):
            if os.path.isfile(cand):
                return cand
    return None


def find_tectonic() -> Optional[str]:
    found = _which("tectonic")
    if found:
        return found
    for cand in (os.path.join(str(config.app_dir()), "bin", "tectonic.exe" if WINDOWS else "tectonic"),):
        if os.path.isfile(cand):
            return cand
    return None


class Toolchain:
    """Snapshot of what's installed. Cheap to keep around; refreshed on demand."""

    def __init__(self) -> None:
        settings = config.app_settings().load()
        self.override = settings.get("texBinDir") or ""
        self.tex_bin = find_tex_bin(self.override)
        self.programs: Dict[str, Optional[str]] = {}
        for prog in TEX_PROGRAMS:
            self.programs[prog] = _which(prog, self.tex_bin) if self.tex_bin else _which(prog)
            if not self.programs[prog] and self.tex_bin:
                self.programs[prog] = _which(prog)
        self.perl = _which("perl", self.tex_bin) if self.tex_bin else None
        self.perl = self.perl or _which("perl")
        self.git = find_git()
        self.docker = find_docker()
        self.tectonic = find_tectonic()
        self.distro = ""
        self.is_miktex = False
        self.latexmk_ok = False
        self.latexmk_error = ""
        self._docker_state: Dict[str, str] = {}
        self._probe()

    def env(self) -> dict:
        env = dict(os.environ)
        if self.tex_bin:
            env["PATH"] = self.tex_bin + os.pathsep + env.get("PATH", "")
        if self.git:
            git_dir = os.path.dirname(self.git)
            if git_dir not in env.get("PATH", ""):
                env["PATH"] = env["PATH"] + os.pathsep + git_dir
        # Stop TeX from hard-wrapping its log at 79 columns, so errors parse reliably.
        env["max_print_line"] = "10000"
        env["error_line"] = "254"
        env["half_error_line"] = "238"
        return env

    def _probe(self) -> None:
        engine = self.programs.get("pdflatex") or self.programs.get("xelatex")
        env = self.env()
        if engine:
            try:
                out = run_quick([engine, "--version"], env=env, timeout=30).stdout.decode("utf-8", "replace")
                first = out.strip().splitlines()[0] if out.strip() else ""
                self.is_miktex = "MiKTeX" in out
                m = re.search(r"\((TeX Live \d{4}[^)]*|MiKTeX [\d.]+)\)", first)
                self.distro = m.group(1) if m else ("MiKTeX" if self.is_miktex else first[:60])
            except (OSError, subprocess.SubprocessError) as exc:
                self.distro = f"(could not run pdflatex: {exc})"
        lm = self.programs.get("latexmk")
        if lm:
            try:
                res = run_quick([lm, "-v"], env=env, timeout=30)
                text = res.stdout.decode("utf-8", "replace")
                self.latexmk_ok = res.returncode == 0 and "Latexmk" in text
                if not self.latexmk_ok:
                    self.latexmk_error = text.strip()[-400:] or f"exit code {res.returncode}"
            except (OSError, subprocess.SubprocessError) as exc:
                self.latexmk_error = str(exc)

    def docker_state(self, image: str) -> str:
        """'ready', 'no-image', 'not-running' or 'missing'."""
        if not self.docker:
            return "missing"
        if image in self._docker_state:
            return self._docker_state[image]
        try:
            res = run_quick([self.docker, "image", "inspect", image], timeout=15)
            text = res.stdout.decode("utf-8", "replace").lower()
            if res.returncode == 0:
                state = "ready"
            elif "no such image" in text or "no such object" in text:
                state = "no-image"
            else:
                state = "not-running"
        except (OSError, subprocess.SubprocessError):
            state = "not-running"
        self._docker_state[image] = state
        return state

    def pick_engine(self, wanted: str, compiler: str, docker_image: str) -> tuple:
        """Returns (engine, reason). engine is None when nothing can compile."""
        native = self.programs.get(compiler if compiler != "latex" else "latex")
        if wanted == "latexmk":
            if self.latexmk_ok:
                return "latexmk", ""
            return None, "latexmk was selected but it doesn't run here. " + (self.latexmk_error or "It was not found.")
        if wanted == "builtin":
            return ("builtin", "") if native else (None, f"{compiler} was not found.")
        if wanted == "docker":
            st = self.docker_state(docker_image)
            if st == "ready":
                return "docker", ""
            return None, {
                "missing": "Docker is not installed.",
                "not-running": "Docker is installed but not running. Start Docker Desktop.",
                "no-image": f"The Docker image is not downloaded yet. Run:  docker pull {docker_image}",
            }[st]
        if wanted == "tectonic":
            return ("tectonic", "") if self.tectonic else (None, "Tectonic is not installed.")
        # auto
        if self.latexmk_ok and native:
            return "latexmk", ""
        if native and compiler != "latex":
            return "builtin", ""
        if self.docker and self.docker_state(docker_image) == "ready":
            return "docker", ""
        if self.tectonic:
            return "tectonic", ""
        return None, "No LaTeX installation was found. Open the Setup guide to install one."

    def report(self, docker_image: str = config.PROJECT_DEFAULTS["dockerImage"]) -> dict:
        def item(name, ok, detail="", level=None):
            return {"name": name, "ok": bool(ok), "detail": detail, "level": level or ("ok" if ok else "missing")}

        checks = [
            item("TeX distribution", self.tex_bin, f"{self.distro} at {self.tex_bin}" if self.tex_bin else "Not found"),
            item("pdflatex", self.programs.get("pdflatex"), self.programs.get("pdflatex") or ""),
            item("xelatex", self.programs.get("xelatex"), self.programs.get("xelatex") or "", None if self.programs.get("xelatex") else "warn"),
            item("lualatex", self.programs.get("lualatex"), self.programs.get("lualatex") or "", None if self.programs.get("lualatex") else "warn"),
            item(
                "latexmk",
                self.latexmk_ok,
                self.programs.get("latexmk") or "",
                None if self.latexmk_ok else "warn",
            ),
            item("biber", self.programs.get("biber"), self.programs.get("biber") or "Needed for biblatex", None if self.programs.get("biber") else "warn"),
            item("bibtex", self.programs.get("bibtex"), self.programs.get("bibtex") or "", None if self.programs.get("bibtex") else "warn"),
            item("git", self.git, self.git or "Needed for GitHub sync"),
        ]
        if self.programs.get("latexmk") and not self.latexmk_ok:
            checks[4]["detail"] = (
                "Found but it won't start (MiKTeX's latexmk needs Perl). LaTeX Lab will use its built-in runner instead. "
                + (self.latexmk_error[:200] if self.latexmk_error else "")
            )
        elif not self.programs.get("latexmk"):
            checks[4]["detail"] = "Not found. LaTeX Lab will use its built-in runner instead."
        dstate = self.docker_state(docker_image) if self.docker else "missing"
        checks.append(item(
            "Docker (optional)", dstate == "ready",
            {"ready": f"{docker_image} ready", "missing": "Not installed (optional)", "not-running": "Installed, not running",
             "no-image": f"Installed; image not pulled ({docker_image})"}[dstate],
            "ok" if dstate == "ready" else "optional",
        ))
        engine, reason = self.pick_engine("auto", "pdflatex", docker_image)
        return {
            "platform": "windows" if WINDOWS else ("mac" if MAC else "linux"),
            "texBin": self.tex_bin,
            "texBinOverride": self.override,
            "distro": self.distro,
            "miktex": self.is_miktex,
            "engine": engine,
            "engineReason": reason,
            "checks": checks,
            "ready": engine is not None,
        }


_lock = threading.Lock()
_current: Optional[Toolchain] = None


def get(refresh: bool = False) -> Toolchain:
    global _current
    with _lock:
        if _current is None or refresh:
            _current = Toolchain()
        return _current
