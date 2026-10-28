"""Command line entry point.

    latexlab                    open the start page
    latexlab path/to/project    open a project folder
    latexlab doctor             check your TeX / git setup
    latexlab shortcut           (Windows) add LaTeX Lab to the Desktop and Start menu
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import urllib.request
import webbrowser
from pathlib import Path

from . import __version__, config, toolchain

INSTANCE_FILE = "instance.json"


def _app_browser() -> list:
    """A Chromium browser that can open the editor as a standalone app window."""
    cands = []
    if toolchain.WINDOWS:
        for base in (os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), os.environ.get("ProgramFiles", r"C:\Program Files"),
                     os.environ.get("LOCALAPPDATA", "")):
            cands += [os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
                      os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")]
    elif toolchain.MAC:
        cands += ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                  "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    else:
        for name in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge"):
            found = shutil.which(name)
            if found:
                cands.append(found)
    return [c for c in cands if c and os.path.isfile(c)]


def open_ui(url: str, mode: str) -> None:
    if mode == "none":
        return
    if mode == "app":
        for exe in _app_browser():
            try:
                subprocess.Popen([exe, f"--app={url}", "--new-window"], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, **toolchain.popen_kwargs(new_group=True))
                return
            except OSError:
                continue
    webbrowser.open(url)


def cmd_doctor() -> int:
    tc = toolchain.get()
    rep = tc.report()
    print(f"LaTeX Lab {__version__} on {rep['platform']}\n")
    for c in rep["checks"]:
        mark = {"ok": "OK  ", "warn": "WARN", "optional": "--  ", "missing": "MISS"}[c["level"]]
        print(f"  [{mark}] {c['name']:<20} {c['detail']}")
    print()
    if rep["ready"]:
        print(f"Ready. Compiles will use: {rep['engine']}")
        return 0
    print("Not ready: " + rep["engineReason"])
    if rep["platform"] == "windows":
        print("\nRecommended (matches Overleaf): install TeX Live from https://tug.org/texlive/windows.html\n"
              "  -> download install-tl-windows.exe, run it, keep the default 'full' scheme.\n"
              "Lighter alternative: winget install -e --id MiKTeX.MiKTeX")
    elif rep["platform"] == "mac":
        print("\nInstall MacTeX (matches Overleaf):  brew install --cask mactex-no-gui")
    else:
        print("\nInstall TeX Live:  sudo apt install texlive-full latexmk   (or your distro's equivalent)")
    return 1


def _local_opener():
    # Never send requests for 127.0.0.1 through a system/corporate proxy.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def running_instance():
    """The already-running LaTeX Lab (port + token), if there is one."""
    try:
        info = json.loads((config.app_dir() / INSTANCE_FILE).read_text(encoding="utf-8"))
        req = urllib.request.Request(f"http://127.0.0.1:{info['port']}/api/state", headers={"X-LatexLab-Token": info["token"]})
        with _local_opener().open(req, timeout=1.5) as res:
            return info if res.status == 200 else None
    except (OSError, ValueError, KeyError):
        return None


def hand_over(info: dict, project: str) -> None:
    if project:
        body = json.dumps({"path": str(Path(project).expanduser().resolve())}).encode("utf-8")
        req = urllib.request.Request(f"http://127.0.0.1:{info['port']}/api/project/open", data=body, method="POST",
                                     headers={"X-LatexLab-Token": info["token"], "Content-Type": "application/json"})
        _local_opener().open(req, timeout=10).read()


def cmd_shortcut() -> int:
    if not toolchain.WINDOWS:
        print("Shortcuts are only created automatically on Windows. Run 'latexlab' (or python3 -m latexlab) to start.")
        return 1
    exe = Path(sys.executable)
    windowless = exe.with_name("pythonw.exe")
    target = windowless if windowless.exists() else exe
    workdir = Path(__file__).resolve().parent.parent
    icon_path = Path(__file__).resolve().parent / "data" / "latexlab.ico"
    script = (
        "$ws = New-Object -ComObject WScript.Shell; "
        "foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) { "
        "  $s = $ws.CreateShortcut((Join-Path $dir 'LaTeX Lab.lnk')); "
        "  $s.TargetPath = $env:LL_TARGET; $s.Arguments = '-m latexlab'; $s.WorkingDirectory = $env:LL_WORKDIR; "
        "  $s.IconLocation = $env:LL_ICON; $s.Description = 'LaTeX Lab - local LaTeX editor'; $s.Save() }"
    )
    env = dict(os.environ, LL_TARGET=str(target), LL_WORKDIR=str(workdir), LL_ICON=str(icon_path))
    res = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], env=env)
    if res.returncode == 0:
        print("Added 'LaTeX Lab' to your Desktop and Start menu.")
    return res.returncode


IDLE_EXIT_SECONDS = 20 * 60


def _exit_when_idle(app, srv) -> None:
    """Windowless mode has no console to close, so stop once no window has talked to us for a while."""
    import time
    while True:
        time.sleep(60)
        if time.time() - app.last_seen > IDLE_EXIT_SECONDS:
            print("No LaTeX Lab window has been open for a while; stopping.")
            srv.shutdown()
            return


def main(argv=None) -> None:
    windowless = sys.stdout is None or sys.stderr is None
    if windowless:
        # Started without a console (pythonw / desktop shortcut): keep a log file instead.
        log = open(config.app_dir() / "latexlab.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = log

    parser = argparse.ArgumentParser(prog="latexlab", description="Local, offline, Overleaf-style LaTeX editor.")
    parser.add_argument("project", nargs="?", help="project folder to open (or 'doctor')")
    parser.add_argument("--port", type=int, default=int(os.environ.get("LATEXLAB_PORT", "8765")))
    parser.add_argument("--browser", choices=["app", "tab", "none"], default=os.environ.get("LATEXLAB_BROWSER", "app"),
                        help="app: standalone window (Edge/Chrome), tab: normal browser tab, none: don't open")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--version", action="version", version=f"LaTeX Lab {__version__}")
    args = parser.parse_args(argv)

    if args.project == "doctor":
        sys.exit(cmd_doctor())
    if args.project == "shortcut":
        sys.exit(cmd_shortcut())
    if args.project and not Path(args.project).expanduser().is_dir():
        sys.exit(f"Folder not found: {args.project}")

    existing = running_instance()
    if existing:
        hand_over(existing, args.project)
        url = f"http://127.0.0.1:{existing['port']}/"
        print(f"LaTeX Lab is already running at {url}; opening it.")
        open_ui(url, args.browser)
        return

    from .server import App, make_server

    app = App(verbose=args.verbose)
    if args.project:
        app.open_project(str(Path(args.project).expanduser()))

    # Probe TeX in the background so the first page load is instant.
    threading.Thread(target=toolchain.get, daemon=True).start()

    srv = make_server(app, args.port)
    app.server = srv
    url = f"http://127.0.0.1:{app.port}/"
    instance = config.app_dir() / INSTANCE_FILE
    config.atomic_write_bytes(instance, json.dumps({"port": app.port, "token": app.token, "pid": os.getpid()}).encode("utf-8"))
    print(f"LaTeX Lab {__version__} is running at {url}")
    if app.project:
        print(f"Project: {app.project.root}")
    print("Keep this window open while you work. Press Ctrl+C (or close this window) to quit.")
    threading.Timer(0.4, open_ui, args=(url, args.browser)).start()
    if windowless:
        threading.Thread(target=_exit_when_idle, args=(app, srv), daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nBye!")
    finally:
        srv.server_close()
        try:
            if json.loads(instance.read_text(encoding="utf-8")).get("pid") == os.getpid():
                instance.unlink()
        except (OSError, ValueError):
            pass


if __name__ == "__main__":
    main()
