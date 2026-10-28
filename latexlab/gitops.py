"""Git operations for syncing a project with GitHub (and therefore Overleaf).

Everything works offline except pull/push/fetch, which report a friendly
"you're offline" message instead of failing obscurely.
"""

from __future__ import annotations

import os
import re
import subprocess
import time
from pathlib import Path
from typing import List, Optional

from . import toolchain

NETWORK_TIMEOUT = 300  # first push may wait for you to sign in to GitHub in the browser
OFFLINE_MARKERS = (
    "could not resolve host", "unable to access", "failed to connect", "network is unreachable",
    "connection timed out", "could not read from remote repository", "temporary failure in name resolution",
    "connection refused", "operation timed out",
)
AUTH_MARKERS = ("authentication failed", "terminal prompts disabled", "could not read username", "permission denied",
                "403", "invalid username or password")


class GitError(Exception):
    status = 400

    def __init__(self, message: str, kind: str = "error", output: str = ""):
        super().__init__(message)
        self.kind = kind
        self.output = output


class Git:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.exe = toolchain.get().git

    # ------------------------------------------------------------ plumbing
    def _env(self) -> dict:
        env = toolchain.get().env()
        env["GIT_TERMINAL_PROMPT"] = "0"   # no hidden terminal to type into; GUI credential managers still work
        env["GIT_OPTIONAL_LOCKS"] = "0"
        env.setdefault("LC_ALL", "C")
        env["LANG"] = "C"
        return env

    def run(self, *args: str, timeout: float = 30, check: bool = True, input_text: Optional[str] = None) -> str:
        if not self.exe:
            raise GitError("Git is not installed. Install it from https://git-scm.com/download/win "
                           "(or: winget install --id Git.Git -e), then restart LaTeX Lab.", "no-git")
        try:
            res = subprocess.run(
                [self.exe, *args], cwd=str(self.root), env=self._env(), timeout=timeout,
                input=input_text.encode("utf-8") if input_text is not None else None,
                stdin=None if input_text is not None else subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, **toolchain.popen_kwargs(),
            )
        except subprocess.TimeoutExpired:
            raise GitError(f"git {args[0]} took too long and was stopped. If you're offline, try again when connected.", "offline")
        out = res.stdout.decode("utf-8", errors="replace")
        err = res.stderr.decode("utf-8", errors="replace")
        if check and res.returncode != 0:
            raise self._explain(args, out + err)
        return out

    def _explain(self, args, text: str) -> GitError:
        low = text.lower()
        if any(m in low for m in OFFLINE_MARKERS):
            return GitError("Can't reach GitHub right now (offline?). Your work is safe locally; "
                            "commits will go up the next time you push.", "offline", text)
        if any(m in low for m in AUTH_MARKERS):
            return GitError("GitHub didn't accept your credentials. On Windows, Git Credential Manager should "
                            "pop up a sign-in window; if it doesn't, run  git push  once in a terminal in this folder.", "auth", text)
        if "please tell me who you are" in low or "unable to auto-detect email" in low:
            return GitError("Git needs your name and email before it can commit.", "identity", text)
        if "non-fast-forward" in low or "fetch first" in low or "rejected" in low:
            return GitError("GitHub has changes you don't have yet (maybe from Overleaf). Pull first, then push. "
                            "'Sync' does both for you.", "behind", text)
        if "conflict" in low:
            return GitError("Some files were changed both here and on GitHub/Overleaf. Open the files marked "
                            "with conflicts, keep the version you want (delete the <<<<<<< ======= >>>>>>> markers), "
                            "then click 'Mark resolved'.", "conflict", text)
        if "not a git repository" in low:
            return GitError("This folder isn't a git repository yet.", "not-repo", text)
        if "no configured push destination" in low or "does not appear to be a git repository" in low:
            return GitError("No GitHub remote is set for this project yet. Add one in the Git panel.", "no-remote", text)
        if "unrelated histories" in low:
            return GitError("This folder and the GitHub repository have separate histories. "
                            "If the GitHub repo already has your Overleaf project, clone it instead of importing a zip.",
                            "unrelated", text)
        tail = text.strip().splitlines()[-6:]
        return GitError(f"git {args[0]} failed: " + " ".join(tail)[:600], "error", text)

    # ------------------------------------------------------------- queries
    def is_repo(self) -> bool:
        if not self.exe:
            return False
        try:
            top = self.run("rev-parse", "--show-toplevel", timeout=10).strip()
        except GitError:
            return False
        return bool(top)

    def status(self) -> dict:
        if not self.exe:
            return {"available": False, "repo": False}
        if not self.is_repo():
            return {"available": True, "repo": False}
        raw = self.run("status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", timeout=30)
        info = {"available": True, "repo": True, "branch": None, "upstream": None, "ahead": 0, "behind": 0,
                "changes": [], "conflicts": [], "merging": False}
        items = raw.split("\0")
        i = 0
        while i < len(items):
            item = items[i]
            if not item:
                i += 1
                continue
            if item.startswith("# branch.head "):
                head = item[len("# branch.head "):]
                info["branch"] = None if head == "(detached)" else head
            elif item.startswith("# branch.upstream "):
                info["upstream"] = item[len("# branch.upstream "):]
            elif item.startswith("# branch.ab "):
                m = re.match(r"# branch\.ab \+(\d+) -(\d+)", item)
                if m:
                    info["ahead"], info["behind"] = int(m.group(1)), int(m.group(2))
            elif item[0] == "1":
                parts = item.split(" ", 8)
                info["changes"].append({"path": parts[8], "status": _xy(parts[1])})
            elif item[0] == "2":
                parts = item.split(" ", 9)
                info["changes"].append({"path": parts[9], "status": "renamed", "from": items[i + 1]})
                i += 1
            elif item[0] == "u":
                parts = item.split(" ", 10)
                info["conflicts"].append(parts[10])
                info["changes"].append({"path": parts[10], "status": "conflict"})
            elif item[0] == "?":
                info["changes"].append({"path": item[2:], "status": "new"})
            i += 1
        top = Path(self.run("rev-parse", "--show-toplevel", timeout=10).strip())
        git_dir = Path(self.run("rev-parse", "--git-dir", timeout=10).strip())
        if not git_dir.is_absolute():
            git_dir = self.root / git_dir
        info["merging"] = (git_dir / "MERGE_HEAD").exists()
        info["remote"] = self.remote_url()
        info["topLevel"] = str(top)
        try:
            prefix = Path(os.path.relpath(self.root.resolve(), top.resolve())).as_posix()
        except ValueError:
            prefix = "."
        info["prefix"] = "" if prefix == "." else prefix
        try:
            self.run("rev-parse", "--verify", "HEAD", timeout=10)
            info["hasCommits"] = True
        except GitError:
            info["hasCommits"] = False
        info["identity"] = self.identity()
        return info

    def identity(self) -> dict:
        name = self.run("config", "user.name", check=False, timeout=10).strip()
        email = self.run("config", "user.email", check=False, timeout=10).strip()
        return {"name": name, "email": email}

    def remote_url(self) -> Optional[str]:
        out = self.run("remote", "get-url", "origin", check=False, timeout=10).strip()
        return out or None

    def diff(self, path: str) -> str:
        tracked = self.run("ls-files", "--error-unmatch", "--", path, check=False, timeout=10).strip()
        if not tracked:
            try:
                return "".join("+" + ln + "\n" for ln in (self.root / path).read_text(encoding="utf-8", errors="replace").split("\n"))
            except OSError:
                return ""
        has_head = self.run("rev-parse", "--verify", "HEAD", check=False, timeout=10).strip()
        args = ["diff", "--no-color", "--no-ext-diff"]
        if has_head:
            args.append("HEAD")
        return self.run(*args, "--", path, timeout=30)

    def log(self, limit: int = 30) -> List[dict]:
        if not self.run("rev-parse", "--verify", "HEAD", check=False, timeout=10).strip():
            return []
        raw = self.run("log", f"-n{limit}", "--pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e", timeout=30)
        out = []
        for rec in raw.split("\x1e"):
            rec = rec.strip("\n")
            if not rec:
                continue
            parts = rec.split("\x1f")
            if len(parts) == 5:
                out.append({"hash": parts[0], "short": parts[1], "author": parts[2], "time": int(parts[3]), "subject": parts[4]})
        return out

    # ------------------------------------------------------------- actions
    def init(self, remote: Optional[str] = None) -> dict:
        if not self.is_repo():
            try:
                self.run("init", "-b", "main", timeout=20)
            except GitError:
                self.run("init", timeout=20)
                self.run("symbolic-ref", "HEAD", "refs/heads/main", timeout=10)
        if remote:
            self.set_remote(remote)
        return self.status()

    def set_remote(self, url: str) -> dict:
        url = url.strip()
        if not re.match(r"^(https://|git@|ssh://|file://|/|[A-Za-z]:[\\/])", url):
            raise GitError("That doesn't look like a git URL. It should look like https://github.com/you/repo.git")
        if self.remote_url():
            self.run("remote", "set-url", "origin", url, timeout=10)
        else:
            self.run("remote", "add", "origin", url, timeout=10)
        return self.status()

    def set_identity(self, name: str, email: str) -> dict:
        if not name.strip() or not email.strip():
            raise GitError("Both name and email are needed.")
        self.run("config", "--global", "user.name", name.strip(), timeout=10)
        self.run("config", "--global", "user.email", email.strip(), timeout=10)
        return self.identity()

    def commit(self, message: str) -> dict:
        message = (message or "").strip() or time.strftime("Edits from LaTeX Lab (%Y-%m-%d %H:%M)")
        self.run("add", "-A", "--", ".", timeout=120)
        staged = self.run("diff", "--cached", "--name-only", timeout=30).strip()
        merging = self.status().get("merging")
        if not staged and not merging:
            return {"committed": False, "message": "Nothing to commit."}
        self.run("commit", "-m", message, timeout=60)
        return {"committed": True, "message": f"Committed: {message}"}

    def _branch(self) -> str:
        b = self.run("rev-parse", "--abbrev-ref", "HEAD", timeout=10).strip()
        if b == "HEAD":
            raise GitError("You're not on a branch (detached HEAD). Check out your main branch first.")
        return b

    def fetch(self) -> None:
        if self.remote_url():
            self.run("fetch", "--quiet", "origin", timeout=25)

    def pull(self) -> dict:
        if not self.remote_url():
            raise GitError("No GitHub remote is set for this project yet. Add one in the Git panel.", "no-remote")
        branch = self._branch()
        st = self.status()
        if not st.get("hasCommits"):
            self.run("fetch", "origin", timeout=NETWORK_TIMEOUT)
            remote_has = self.run("ls-remote", "--heads", "origin", branch, timeout=NETWORK_TIMEOUT).strip()
            if remote_has:
                self.run("pull", "--no-rebase", "--no-edit", "origin", branch, timeout=NETWORK_TIMEOUT)
            return {"message": "Pulled." if remote_has else "GitHub repository is empty; nothing to pull."}
        remote_has = self.run("ls-remote", "--heads", "origin", branch, timeout=NETWORK_TIMEOUT).strip()
        if not remote_has:
            return {"message": f"GitHub doesn't have a '{branch}' branch yet; nothing to pull."}
        out = self.run("pull", "--no-rebase", "--no-edit", "origin", branch, timeout=NETWORK_TIMEOUT)
        if not st.get("upstream"):
            self.run("branch", f"--set-upstream-to=origin/{branch}", branch, check=False, timeout=10)
        return {"message": "Already up to date." if "Already up to date" in out else "Pulled the latest changes from GitHub."}

    def push(self) -> dict:
        if not self.remote_url():
            raise GitError("No GitHub remote is set for this project yet. Add one in the Git panel.", "no-remote")
        branch = self._branch()
        if not self.status().get("hasCommits"):
            raise GitError("There are no commits to push yet. Commit first.")
        self.run("push", "-u", "origin", branch, timeout=NETWORK_TIMEOUT)
        return {"message": f"Pushed to GitHub ({branch})."}

    def sync(self, message: str) -> dict:
        steps = []
        c = self.commit(message)
        steps.append(c["message"])
        if not self.remote_url():
            steps.append("No GitHub remote set, so nothing was sent anywhere.")
            return {"message": " ".join(steps)}
        steps.append(self.pull()["message"])
        steps.append(self.push()["message"])
        return {"message": " ".join(steps)}

    def abort_merge(self) -> dict:
        self.run("merge", "--abort", timeout=30)
        return {"message": "Merge aborted. Your files are back to how they were before the pull."}

    @staticmethod
    def clone(url: str, dest: Path) -> None:
        g = Git(dest.parent)
        dest.parent.mkdir(parents=True, exist_ok=True)
        g.run("clone", url, str(dest), timeout=1200)


def _xy(code: str) -> str:
    x, y = code[0], code[1]
    c = y if y != "." else x
    return {"M": "modified", "A": "added", "D": "deleted", "R": "renamed", "C": "copied", "T": "modified"}.get(c, "modified")
