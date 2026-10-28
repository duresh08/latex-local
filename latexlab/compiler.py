"""Compile a project the way Overleaf does.

Overleaf copies your project into a separate compile directory and runs

    latexmk -cd -jobname=output -synctex=1 -interaction=batchmode -f -pdf main.tex

there, so auxiliary files never clutter the project. We do the same: the
project is mirrored (incrementally) into a private build folder under the
LaTeX Lab app directory, and only the PDF and SyncTeX data come back.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import List, Optional, Tuple

from . import config, toolchain
from .logparser import parse_blg, parse_log
from .project import IGNORED_DIRS, IGNORED_FILES, Project
from .synctex import SyncTex

DATA_DIR = Path(__file__).resolve().parent / "data"
DEFAULT_RC = DATA_DIR / "latexmkrc"
LATEXMK_ENGINE_FLAGS = {"pdflatex": "-pdf", "xelatex": "-xelatex", "lualatex": "-lualatex", "latex": "-pdfdvi"}
RERUN_RE = re.compile(r"(Rerun to get|Please rerun|Rerun LaTeX|Label\(s\) may have changed|has changed\. Rerun)", re.I)
DOCKER_MOUNT = "/compile"
MAX_LOG = 3_000_000


def _rel_to(child: str, parent: str) -> Optional[str]:
    c, p = os.path.normpath(child), os.path.normpath(parent)
    if os.path.normcase(c) == os.path.normcase(p):
        return ""
    if os.path.normcase(c).startswith(os.path.normcase(p) + os.sep):
        return c[len(p) + 1:].replace("\\", "/")
    return None


def _read_text(path: Path, limit: int = MAX_LOG) -> str:
    try:
        data = path.read_bytes()
    except OSError:
        return ""
    if len(data) > limit:
        data = data[-limit:]
    return data.decode("utf-8", errors="replace")


def _kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        if toolchain.WINDOWS:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, **toolchain.popen_kwargs())
        else:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        try:
            proc.kill()
        except OSError:
            pass


class Builder:
    def __init__(self, project: Project):
        self.project = project
        self.root = config.build_dir(project.root)
        self.src = self.root / "src"
        self.lock = threading.Lock()
        self.proc: Optional[subprocess.Popen] = None
        self.container: Optional[str] = None
        self.stop_requested = False
        self.running = False
        self._sync_cache: Optional[Tuple[int, SyncTex]] = None

    # ----------------------------------------------------------- source mirror
    def sync_sources(self) -> int:
        self.src.mkdir(parents=True, exist_ok=True)
        manifest_path = self.root / "manifest.json"
        try:
            old = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            old = {}
        new, copied = {}, 0
        for dirpath, dirnames, filenames in os.walk(self.project.root):
            dirnames[:] = [d for d in dirnames if d not in IGNORED_DIRS]
            for fn in filenames:
                if fn in IGNORED_FILES or fn.endswith(".latexlab-tmp"):
                    continue
                full = os.path.join(dirpath, fn)
                rel = _rel_to(full, str(self.project.root))
                if rel is None:
                    continue
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                sig = [st.st_size, st.st_mtime_ns]
                new[rel] = sig
                dest = self.src / rel
                if old.get(rel) != sig or not dest.exists():
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(full, dest)
                    copied += 1
        for rel in set(old) - set(new):
            try:
                (self.src / rel).unlink()
            except OSError:
                pass
        config.atomic_write_bytes(manifest_path, json.dumps(new).encode("utf-8"))
        return copied

    def clear_cache(self) -> None:
        with self.lock:
            self._sync_cache = None
            if self.root.exists():
                shutil.rmtree(self.root, ignore_errors=True)

    # ----------------------------------------------------------------- running
    def _run(self, cmd: List[str], cwd: Path, env: dict, deadline: float) -> Tuple[int, str, str]:
        """Returns (returncode, output, state) where state is ok | timeout | stopped | error."""
        try:
            self.proc = subprocess.Popen(
                cmd, cwd=str(cwd), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, **toolchain.popen_kwargs(new_group=True),
            )
        except OSError as exc:
            return -1, f"Could not start {cmd[0]}: {exc}", "error"
        chunks: List[bytes] = []
        state = "ok"
        while True:
            remaining = deadline - time.time()
            if self.stop_requested:
                state = "stopped"
            elif remaining <= 0:
                state = "timeout"
            if state != "ok":
                if self.container:
                    subprocess.run([toolchain.get().docker or "docker", "kill", self.container],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **toolchain.popen_kwargs())
                _kill_tree(self.proc)
                out, _ = self.proc.communicate()
                chunks.append(out or b"")
                break
            try:
                out, _ = self.proc.communicate(timeout=min(0.5, max(remaining, 0.05)))
                chunks.append(out or b"")
                break
            except subprocess.TimeoutExpired:
                continue
        rc = self.proc.returncode if self.proc.returncode is not None else -1
        self.proc = None
        return rc, b"".join(chunks).decode("utf-8", errors="replace"), state

    def stop(self) -> bool:
        if not self.running:
            return False
        self.stop_requested = True
        return True

    def _engine_args(self, settings: dict) -> List[str]:
        args = ["-synctex=1", "-interaction=batchmode", "-file-line-error"]
        args.append("-halt-on-error" if settings.get("haltOnError") else "")
        if settings.get("shellEscape"):
            args.append("-shell-escape")
        return [a for a in args if a]

    def _latexmk_cmd(self, latexmk: str, settings: dict, main_rel: str, rc: str) -> List[str]:
        cmd = [latexmk, "-cd", "-jobname=output", "-synctex=1", "-interaction=batchmode", "-file-line-error",
               LATEXMK_ENGINE_FLAGS[settings["compiler"]], "-r", rc]
        cmd.append("-halt-on-error" if settings.get("haltOnError") else "-f")
        if settings.get("shellEscape"):
            cmd.append("-shell-escape")
        cmd.append(main_rel)
        return cmd

    def _run_builtin(self, tc: toolchain.Toolchain, settings: dict, main_rel: str, env: dict, deadline: float):
        """latexmk-free fallback: engine, then bibtex/biber/makeindex, then rerun until stable."""
        compiler = settings["compiler"]
        engine = tc.programs.get(compiler)
        main_path = self.src / main_rel
        cwd = main_path.parent
        cmd = [engine] + self._engine_args(settings) + ["-jobname=output", main_path.name]
        transcript: List[str] = []
        state, rc = "ok", 0
        bcf_before = None
        for attempt in range(1, 6):
            transcript.append(f"=== {compiler} pass {attempt} ===")
            rc, out, state = self._run(cmd, cwd, env, deadline)
            transcript.append(out)
            if state != "ok":
                break
            log = _read_text(cwd / "output.log")
            if "Fatal error occurred" in log or "Emergency stop" in log and not (cwd / "output.pdf").exists():
                break
            if rc != 0 and settings.get("haltOnError"):
                break
            ran_tools = False
            if attempt == 1 or (attempt == 2 and bcf_before is not None):
                bcf = cwd / "output.bcf"
                aux = _read_text(cwd / "output.aux", 2_000_000)
                if bcf.exists() and tc.programs.get("biber"):
                    sig = bcf.read_bytes()
                    if sig != bcf_before:
                        transcript.append("=== biber ===")
                        _, out, state = self._run([tc.programs["biber"], "output"], cwd, env, deadline)
                        transcript.append(out)
                        bcf_before, ran_tools = sig, True
                elif "\\bibdata" in aux and tc.programs.get("bibtex") and attempt == 1:
                    transcript.append("=== bibtex ===")
                    _, out, state = self._run([tc.programs["bibtex"], "output"], cwd, env, deadline)
                    transcript.append(out)
                    ran_tools = True
                if attempt == 1 and (cwd / "output.idx").exists() and tc.programs.get("makeindex"):
                    transcript.append("=== makeindex ===")
                    _, out, state = self._run([tc.programs["makeindex"], "output.idx"], cwd, env, deadline)
                    transcript.append(out)
                    ran_tools = True
                if attempt == 1 and (cwd / "output.glo").exists() and tc.programs.get("makeglossaries"):
                    transcript.append("=== makeglossaries ===")
                    _, out, state = self._run([tc.programs["makeglossaries"], "output"], cwd, env, deadline)
                    transcript.append(out)
                    ran_tools = True
                if state != "ok":
                    break
            needs_rerun = ran_tools or bool(RERUN_RE.search(log)) or (
                attempt == 1 and ("There were undefined references" in log or (cwd / "output.toc").exists()
                                  or "\\newlabel" in _read_text(cwd / "output.aux", 2_000_000))
            )
            if not needs_rerun:
                break
        return rc, "\n".join(transcript), state

    # ------------------------------------------------------------------ compile
    def compile(self) -> dict:
        with self.lock:
            self.running = True
            self.stop_requested = False
            try:
                return self._compile()
            finally:
                self.running = False
                self.container = None

    def _compile(self) -> dict:
        started = time.time()
        settings = self.project.settings()
        main_rel = settings.get("mainFile")
        if not main_rel:
            return self._fail("error", "No main document found. Create a .tex file with \\documentclass, "
                                       "or choose the main file in Settings.")
        tc = toolchain.get()
        engine, reason = tc.pick_engine(settings["engine"], settings["compiler"], settings["dockerImage"])
        if engine is None:
            # Maybe TeX was installed while LaTeX Lab was running: look again before giving up.
            tc = toolchain.get(refresh=True)
            engine, reason = tc.pick_engine(settings["engine"], settings["compiler"], settings["dockerImage"])
        if engine is None:
            return self._fail("no-engine", reason)
        copied = self.sync_sources()
        env = tc.env()
        deadline = started + int(settings.get("timeout") or 240)
        main_path = self.src / main_rel
        out_dir = main_path.parent
        jobname = "output"
        stale_pdf = out_dir / "output.pdf"
        self.container = None

        if engine == "latexmk":
            cmd = self._latexmk_cmd(tc.programs["latexmk"], settings, main_rel, str(DEFAULT_RC))
            rc, output, state = self._run(cmd, self.src, env, deadline)
            description = f"latexmk · {tc.distro or 'TeX'}"
        elif engine == "builtin":
            rc, output, state = self._run_builtin(tc, settings, main_rel, env, deadline)
            description = f"{settings['compiler']} (built-in runner) · {tc.distro or 'TeX'}"
        elif engine == "docker":
            self.container = f"latexlab-{config.project_key(self.project.root)}-{int(started)}"
            rc_target = "/latexlab/latexmkrc"
            cmd = [tc.docker, "run", "--rm", "--name", self.container, "--network", "none",
                   "-v", f"{self.src}:{DOCKER_MOUNT}", "-v", f"{DEFAULT_RC}:{rc_target}:ro", "-w", DOCKER_MOUNT,
                   "-e", "max_print_line=10000", "-e", "error_line=254", "-e", "half_error_line=238", "-e", "HOME=/tmp"]
            if hasattr(os, "getuid") and not toolchain.WINDOWS:
                cmd += ["--user", f"{os.getuid()}:{os.getgid()}"]
            cmd.append(settings["dockerImage"])
            cmd += self._latexmk_cmd("latexmk", settings, main_rel, rc_target)[0:]
            rc, output, state = self._run(cmd, self.src, env, deadline)
            description = f"Docker · {settings['dockerImage']}"
        else:  # tectonic
            jobname = main_path.stem
            stale_pdf = out_dir / f"{jobname}.pdf"
            cmd = [tc.tectonic, "--synctex", "--keep-logs", "--keep-intermediates"]
            if settings.get("shellEscape"):
                cmd += ["-Z", "shell-escape"]
            cmd.append(main_path.name)
            rc, output, state = self._run(cmd, out_dir, env, deadline)
            description = "Tectonic (XeTeX engine)"

        log_path = out_dir / f"{jobname}.log"
        log_text = _read_text(log_path)
        parsed = parse_log(log_text)
        entries = [self._map_entry(e, out_dir, main_rel, engine) for e in parsed["entries"]]
        blg_path = out_dir / f"{jobname}.blg"
        blg_text = _read_text(blg_path, 500_000)
        try:
            if blg_text and blg_path.stat().st_mtime >= started - 1:
                tool = "biber" if "biber" in blg_text[:400].lower() else "bibtex"
                entries += [self._map_entry(e, out_dir, main_rel, engine) for e in parse_blg(blg_text, tool)]
        except OSError:
            pass

        pdf_fresh = False
        try:
            if stale_pdf.exists():
                pdf_m = stale_pdf.stat().st_mtime
                log_m = log_path.stat().st_mtime if log_path.exists() else 0
                pdf_fresh = pdf_m >= started - 1 or (log_m < started - 1 and pdf_m >= log_m - 5)
        except OSError:
            pdf_fresh = False
        if pdf_fresh and state == "ok":
            shutil.copyfile(stale_pdf, self.root / "view.pdf")
            sync_src = out_dir / f"{jobname}.synctex.gz"
            view_sync = self.root / "view.synctex.gz"
            if sync_src.exists():
                shutil.copyfile(sync_src, view_sync)
            elif view_sync.exists():
                view_sync.unlink()
            self._sync_cache = None
            meta = {"mainDir": str(out_dir), "engine": engine, "built": time.time()}
            config.atomic_write_bytes(self.root / "view.json", json.dumps(meta).encode("utf-8"))

        if state == "error" and not log_text:
            entries.insert(0, {"level": "error", "message": output.strip()[:500] or "The compiler could not start.",
                               "file": None, "line": None, "content": ""})
        if engine == "latexmk" and rc != 0 and not log_text and "perl" in output.lower():
            entries.insert(0, {"level": "error", "file": None, "line": None, "content": output[-1500:],
                               "message": "latexmk could not run (it needs Perl). Switch Settings > Engine to 'Built-in runner', "
                                          "or install TeX Live, which includes Perl."})

        errors = [e for e in entries if e["level"] == "error"]
        if state == "timeout":
            status = "timeout"
        elif state == "stopped":
            status = "stopped"
        elif errors or not pdf_fresh:
            status = "failure"
            if not errors and not pdf_fresh:
                entries.insert(0, {"level": "error", "file": None, "line": None, "content": output[-3000:],
                                   "message": "No PDF was produced. See the raw output below for details."})
        else:
            status = "success"
        return {
            "status": status,
            "pdf": pdf_fresh and state == "ok",
            "entries": entries,
            "counts": {lvl: sum(1 for e in entries if e["level"] == lvl) for lvl in ("error", "warning", "typesetting")},
            "pages": parsed["pages"],
            "log": log_text,
            "output": output[-200_000:],
            "engine": engine,
            "engineDescription": description,
            "durationMs": int((time.time() - started) * 1000),
            "filesCopied": copied,
            "mainFile": main_rel,
            "builtAt": time.time(),
        }

    def _fail(self, status: str, message: str) -> dict:
        return {
            "status": status, "pdf": False, "pages": None, "log": "", "output": "", "engine": None,
            "engineDescription": "", "durationMs": 0, "counts": {"error": 1, "warning": 0, "typesetting": 0},
            "entries": [{"level": "error", "message": message, "file": None, "line": None, "content": ""}],
        }

    def _map_entry(self, entry: dict, base_dir: Path, main_rel: str, engine: Optional[str]) -> dict:
        entry = dict(entry)
        raw = entry.get("file")
        rel = self.map_path(raw, base_dir, engine) if raw else None
        if raw and rel is None:
            # Message from inside a system package/class: its line number is meaningless to the user.
            entry["external"] = raw
            entry["file"], entry["line"] = None, None
        else:
            entry["file"] = rel
        if entry["file"] is None and entry.get("line") and not entry.get("external"):
            entry["file"] = main_rel
        return entry

    def map_path(self, raw: str, base_dir: Path, engine: Optional[str]) -> Optional[str]:
        p = raw.strip().strip('"')
        if engine == "docker" and (p == DOCKER_MOUNT or p.startswith(DOCKER_MOUNT + "/")):
            p = str(self.src) + p[len(DOCKER_MOUNT):]
        if not os.path.isabs(p):
            p = os.path.join(str(base_dir), p)
        rel = _rel_to(p, str(self.src))
        if rel is None:
            return None
        if not (self.project.root / rel).exists():
            # TeX may print paths without the .tex extension
            if (self.project.root / (rel + ".tex")).exists():
                return rel + ".tex"
            return None
        return rel

    # ------------------------------------------------------------------ viewer
    def pdf_path(self) -> Optional[Path]:
        p = self.root / "view.pdf"
        return p if p.exists() else None

    def _synctex(self) -> Optional[SyncTex]:
        path = self.root / "view.synctex.gz"
        if not path.exists():
            return None
        mtime = path.stat().st_mtime_ns
        if self._sync_cache and self._sync_cache[0] == mtime:
            return self._sync_cache[1]
        try:
            meta = json.loads((self.root / "view.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            meta = {"mainDir": str(self.src), "engine": None}
        base = Path(meta["mainDir"])
        engine = meta.get("engine")
        st = SyncTex(str(path), lambda name: self.map_path(name, base, engine))
        self._sync_cache = (mtime, st)
        return st

    def forward(self, file: str, line: int) -> Optional[dict]:
        st = self._synctex()
        return st.forward(file, line) if st else None

    def inverse(self, page: int, x: float, y: float) -> Optional[dict]:
        st = self._synctex()
        return st.inverse(page, x, y) if st else None
