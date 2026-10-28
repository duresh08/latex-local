"""Turn a TeX .log (and BibTeX/Biber .blg) into a list of errors and warnings.

TeX doesn't record which file a message belongs to directly; it prints
"(./chapter.tex" when it opens a file and ")" when it closes it. We follow
that stack, like Overleaf's parser does, and also understand the
`file:line: message` form produced by -file-line-error.
"""

from __future__ import annotations

import re
from typing import List, Optional

FILE_LINE_ERROR_RE = re.compile(r"^((?:[A-Za-z]:)?[^:\n]*?\.[A-Za-z0-9]{1,10}):(\d+): (.*)$")
LINE_NO_RE = re.compile(r"^l\.(\d+)(.*)$")
INPUT_LINE_RE = re.compile(r"on input line (\d+)")
LATEX_WARNING_RE = re.compile(r"^(LaTeX|Package|Class|Module)(?: ([\w.@-]+))? Warning: (.*)$")
LATEX_FONT_WARNING_RE = re.compile(r"^LaTeX Font Warning: (.*)$")
LATEX_INFO_CONT_RE = re.compile(r"^\(([\w.@-]+)\)\s+(.*)$")
ENGINE_WARNING_RE = re.compile(r"^(pdfTeX|XeTeX|LuaTeX|luaotfload|dvipdfmx)(?: warning|:warning)[^:]*:\s*(.*)$", re.I)
BADBOX_RE = re.compile(r"^(Over|Under)full \\([hv])box \(([^)]*)\)(.*?)(?:at lines? (\d+)(?:--(\d+))?)?\s*$")
PAGES_RE = re.compile(r"^Output written on .*?\((\d+) pages?")
FILE_TOKEN_RE = re.compile(r'"[^"]+"|[^\s()"{}\[\]<>]+')
FILE_EXT_RE = re.compile(r"\.[A-Za-z0-9]{1,10}$")

HINTS = [
    (re.compile(r"File [`'\"](.+?\.(?:sty|cls|def|cfg|clo|fd|bst|bbx|cbx|tex))' not found"),
     "This file isn't in your TeX installation. TeX Live: run  tlmgr install {pkg}  (or install the 'full' scheme, "
     "which is what Overleaf uses). MiKTeX: open MiKTeX Console > Packages and install it, or enable "
     "'Install missing packages on-the-fly'."),
    (re.compile(r"Undefined control sequence"),
     "A command isn't defined. Check for a typo, or a missing \\usepackage{...}."),
    (re.compile(r"Missing \$ inserted"),
     "Math-only syntax (like _ ^ or \\alpha) was used outside math mode. Wrap it in $...$."),
    (re.compile(r"Environment (\S+) undefined"),
     "This environment needs a package (or is misspelled)."),
    (re.compile(r"I can't write on file"),
     "Another program (often a PDF viewer such as Acrobat) is locking the output file. Close it and recompile."),
    (re.compile(r"Package fontspec Error"),
     "fontspec only works with XeLaTeX or LuaLaTeX. Change the compiler in Settings."),
    (re.compile(r"Emergency stop"),
     "TeX gave up. The first error above is usually the real cause."),
]


def _hint_for(message: str) -> str:
    for rx, text in HINTS:
        m = rx.search(message)
        if m:
            pkg = m.group(1).rsplit(".", 1)[0] if m.groups() else ""
            return text.replace("{pkg}", pkg)
    return ""


def _clean_path(token: str) -> str:
    token = token.strip()
    if len(token) >= 2 and token[0] == '"' and token[-1] == '"':
        token = token[1:-1]
    return token


def _looks_like_file(token: str) -> bool:
    token = _clean_path(token)
    if not token or not FILE_EXT_RE.search(token):
        return False
    if re.match(r"^\d+(\.\d+)*$", token):  # version numbers like (1.40.25)
        return False
    return (
        token.startswith(("./", "../", "/", "~/", ".\\"))
        or re.match(r"^[A-Za-z]:[\\/]", token) is not None
        or "/" in token
        or token.lower().endswith((".tex", ".sty", ".cls", ".cfg", ".def", ".clo", ".fd", ".aux", ".toc", ".lof", ".lot", ".bbl", ".out", ".ldf", ".dict", ".mkii", ".ltx"))
    )


class _Parser:
    def __init__(self, text: str):
        self.lines = text.replace("\r\n", "\n").split("\n")
        self.stack: List[Optional[str]] = []
        self.entries: List[dict] = []
        self.pages: Optional[int] = None
        self.seen = set()

    def current_file(self) -> Optional[str]:
        for item in reversed(self.stack):
            if item:
                return item
        return None

    def add(self, level: str, message: str, file: Optional[str], line: Optional[int], content: str = "") -> None:
        key = (level, message, file, line)
        if key in self.seen:
            return
        self.seen.add(key)
        entry = {"level": level, "message": message.strip(), "file": file, "line": line, "content": content.rstrip()}
        if level == "error":
            hint = _hint_for(message + "\n" + content)
            if hint:
                entry["hint"] = hint
        self.entries.append(entry)

    def scan_parens(self, line: str) -> None:
        i, n = 0, len(line)
        while i < n:
            c = line[i]
            if c == "(":
                m = FILE_TOKEN_RE.match(line, i + 1)
                token = m.group(0) if m else ""
                if token and _looks_like_file(token):
                    path = _clean_path(token)
                    # A filename may be followed directly by ')' (e.g. "(./a.aux)")
                    while path.endswith(")"):
                        path = path[:-1]
                    self.stack.append(path)
                    i = m.end()
                    continue
                self.stack.append(None)
            elif c == ")":
                if self.stack:
                    self.stack.pop()
            i += 1

    def has_error(self) -> bool:
        return any(e["level"] == "error" for e in self.entries)

    def find_line_marker(self, start: int, limit: int = 30) -> Optional[int]:
        """Some errors (e.g. a missing file) print `l.NN` only after a later prompt."""
        for j in range(start, min(start + limit, len(self.lines))):
            text = self.lines[j]
            m = LINE_NO_RE.match(text)
            if m:
                return int(m.group(1))
            if "Emergency stop" in text:
                continue
            if text.startswith("! ") or (j > start and FILE_LINE_ERROR_RE.match(text)):
                return None
        return None

    def collect_context(self, start: int, max_lines: int = 12):
        """Lines after an error, through TeX's `l.NN ...` marker and the line after it."""
        ctx, line_no, i = [], None, start
        while i < len(self.lines) and len(ctx) < max_lines:
            text = self.lines[i]
            m = LINE_NO_RE.match(text)
            ctx.append(text)
            i += 1
            if m:
                line_no = int(m.group(1))
                if i < len(self.lines) and self.lines[i].strip() and not self.lines[i].startswith(("!", "l.")):
                    ctx.append(self.lines[i])
                    i += 1
                break
            if not text.strip() and len(ctx) > 1:
                break
        return ctx, line_no, i

    def run(self) -> None:
        i, n = 0, len(self.lines)
        while i < n:
            line = self.lines[i]

            m = FILE_LINE_ERROR_RE.match(line)
            if m and not line.startswith(("LaTeX ", "Package ", "Class ")):
                message = m.group(3).strip()
                if message.startswith("==> Fatal error occurred") or (message == "Emergency stop." and self.has_error()):
                    i = self.collect_context(i + 1)[2] if message == "Emergency stop." else i + 1
                    continue
                ctx, _, nxt = self.collect_context(i + 1)
                self.add("error", message, _clean_path(m.group(1)), int(m.group(2)), "\n".join(ctx))
                i = max(nxt, i + 1)
                continue

            if line.startswith("! "):
                message = line[2:].strip()
                if message.startswith("==> Fatal error occurred") or (message == "Emergency stop." and self.has_error()):
                    i += 1
                    continue
                ctx, line_no, nxt = self.collect_context(i + 1)
                if line_no is None:
                    line_no = self.find_line_marker(nxt)
                self.add("error", message, self.current_file(), line_no, "\n".join(ctx))
                i = max(nxt, i + 1)
                continue

            m = LATEX_WARNING_RE.match(line) or LATEX_FONT_WARNING_RE.match(line)
            if m:
                parts = [line.split("Warning:", 1)[1].strip()]
                j = i + 1
                while j < n:
                    cont = self.lines[j]
                    cm = LATEX_INFO_CONT_RE.match(cont)
                    if cm:
                        parts.append(cm.group(2).strip())
                    elif cont.startswith(" ") and cont.strip() and not cont.strip().startswith("("):
                        parts.append(cont.strip())
                    else:
                        break
                    j += 1
                message = " ".join(parts)
                lm = INPUT_LINE_RE.search(message)
                source = m.group(2) if m.re is LATEX_WARNING_RE and m.group(1) != "LaTeX" else None
                prefix = f"{m.group(1)} {source}: " if source else ""
                self.add("warning", prefix + message, self.current_file(), int(lm.group(1)) if lm else None)
                i = j
                continue

            m = BADBOX_RE.match(line)
            if m:
                start = m.group(5)
                message = line.strip()
                j = i + 1
                excerpt = []
                while j < n and self.lines[j].strip() and len(excerpt) < 6:
                    excerpt.append(self.lines[j])
                    j += 1
                self.add("typesetting", message, self.current_file(), int(start) if start else None, "\n".join(excerpt))
                i = j
                continue

            m = ENGINE_WARNING_RE.match(line)
            if m:
                self.add("warning", line.strip(), self.current_file(), None)
                i += 1
                continue

            m = PAGES_RE.match(line)
            if m:
                self.pages = int(m.group(1))
            elif line.startswith("No pages of output."):
                self.add("error", "No pages of output were produced.", None, None)
            elif line.startswith("*** (job aborted, no legal \\end found)"):
                self.add("error", "The document has no \\end{document} (job aborted).", self.current_file(), None)

            self.scan_parens(line)
            i += 1


def parse_log(text: str) -> dict:
    p = _Parser(text or "")
    p.run()
    return {"entries": p.entries, "pages": p.pages}


BIBER_RE = re.compile(r"(WARN|ERROR) - (.*)$")
BIBTEX_LOC_RE = re.compile(r"^(.*?)---?line (\d+) of file (.+)$")


def parse_blg(text: str, tool: str) -> List[dict]:
    out: List[dict] = []
    if not text:
        return out
    lines = text.replace("\r\n", "\n").split("\n")
    for idx, line in enumerate(lines):
        m = BIBER_RE.search(line)
        if m:
            level = "error" if m.group(1) == "ERROR" else "warning"
            msg = m.group(2).strip()
            fm = re.search(r"in file '([^']+)'.*?line (\d+)", msg) or re.search(r"([\w./\\-]+\.bib)_\d+\.utf8, line (\d+)", msg)
            out.append({"level": level, "message": f"Biber: {msg}", "file": fm.group(1) if fm else None,
                        "line": int(fm.group(2)) if fm else None, "content": ""})
            continue
        if line.startswith("Warning--"):
            loc = None
            if idx + 1 < len(lines):
                lm = re.match(r"^--line (\d+) of file (.+)$", lines[idx + 1].strip())
                loc = lm
            out.append({"level": "warning", "message": f"BibTeX: {line[len('Warning--'):].strip()}",
                        "file": loc.group(2).strip() if loc else None, "line": int(loc.group(1)) if loc else None, "content": ""})
            continue
        m = BIBTEX_LOC_RE.match(line)
        if m and tool == "bibtex":
            msg = m.group(1).strip() or (lines[idx - 1].strip() if idx else "")
            out.append({"level": "error", "message": f"BibTeX: {msg}", "file": m.group(3).strip(), "line": int(m.group(2)), "content": ""})
            continue
        for marker in ("I couldn't open", "I found no", "Illegal, another \\bibdata"):
            if line.startswith(marker):
                out.append({"level": "error", "message": f"BibTeX: {line.strip()}", "file": None, "line": None, "content": ""})
    return out
