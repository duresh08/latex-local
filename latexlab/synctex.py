"""A small SyncTeX reader: source line <-> PDF position, without the synctex binary.

Reading the .synctex.gz ourselves means sync works the same with native TeX,
Docker or Tectonic builds, and needs nothing extra installed.
Coordinates returned are PDF points measured from the page's top-left.
"""

from __future__ import annotations

import gzip
import os
import re
from typing import Callable, Dict, List, Optional, Tuple

RECORD_RE = re.compile(
    r"^([\[(vhxkg$r])(\d+),(-?\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?"
)
SP_PER_BP = 65781.76  # TeX scaled points per PDF big point

# (kind, tag, line, x, y, w, h, d) all in big points
Record = Tuple[str, int, int, float, float, float, float, float]


class SyncTex:
    def __init__(self, path: str, map_input: Callable[[str], Optional[str]]):
        """map_input turns a path recorded in the file into a project-relative path (or None)."""
        self.inputs: Dict[int, Optional[str]] = {}
        self.pages: Dict[int, List[Record]] = {}
        opener = gzip.open if path.endswith(".gz") else open
        unit, x_off, y_off, mag = 1.0, 0.0, 0.0, 1000.0
        page = 0
        with opener(path, "rt", encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                line = raw.rstrip("\n")
                if not line:
                    continue
                c = line[0]
                if c in "[(vhxkg$r":
                    m = RECORD_RE.match(line)
                    if not m or not page:
                        continue
                    scale = unit * (mag / 1000.0) / SP_PER_BP
                    x = int(m.group(4)) * scale + x_off
                    y = int(m.group(5)) * scale + y_off
                    w = int(m.group(6) or 0) * scale
                    h = int(m.group(7) or 0) * scale
                    d = int(m.group(8) or 0) * scale
                    self.pages[page].append((c, int(m.group(2)), int(m.group(3)), x, y, w, h, d))
                elif c == "{":
                    try:
                        page = int(line[1:])
                    except ValueError:
                        page = 0
                    self.pages.setdefault(page, [])
                elif c == "}":
                    page = 0
                elif line.startswith("Input:"):
                    _, tag, name = line.split(":", 2)
                    self.inputs[int(tag)] = map_input(name)
                elif line.startswith("Unit:"):
                    unit = float(line[5:] or 1)
                elif line.startswith("Magnification:"):
                    mag = float(line[14:] or 1000)
                elif line.startswith("X Offset:"):
                    x_off = int(line[9:] or 0) / SP_PER_BP
                elif line.startswith("Y Offset:"):
                    y_off = int(line[9:] or 0) / SP_PER_BP

    # ------------------------------------------------------------- forward
    def forward(self, file: str, line: int) -> Optional[dict]:
        tags = {t for t, p in self.inputs.items() if p and os.path.normcase(p) == os.path.normcase(file)}
        if not tags:
            return None
        best_delta = None
        hits: List[Tuple[int, Record]] = []
        for pg, recs in self.pages.items():
            for r in recs:
                if r[1] not in tags or r[2] <= 0:
                    continue
                delta = abs(r[2] - line) + (0 if r[2] >= line else 0.5)  # prefer the line itself, then below
                if best_delta is None or delta < best_delta:
                    best_delta, hits = delta, [(pg, r)]
                elif delta == best_delta:
                    hits.append((pg, r))
        if not hits:
            return None
        page = hits[0][0]
        on_page = [r for pg, r in hits if pg == page]
        boxes = [r for r in on_page if r[0] in "(h" and r[5] > 0]
        rects = []
        for r in boxes or on_page:
            _, _, _, x, y, w, h, d = r
            if w <= 0:
                w, h = 20.0, max(h, 8.0)
            rects.append({"x": x, "y": y - max(h, 6.0), "w": w, "h": max(h, 6.0) + d})
        rects = _merge_rows(rects)
        top = min(r["y"] for r in rects)
        return {"page": page, "y": top, "rects": rects[:12], "line": hits[0][1][2]}

    # ------------------------------------------------------------- inverse
    def inverse(self, page: int, x: float, y: float) -> Optional[dict]:
        recs = self.pages.get(page)
        if not recs:
            return None
        containing = []
        for r in recs:
            kind, tag, ln, rx, ry, w, h, d = r
            if kind in "[(" or (kind in "vh" and w > 0):
                if rx <= x <= rx + w and ry - h <= y <= ry + d and self.inputs.get(tag):
                    containing.append(r)
        if containing:
            box = min(containing, key=lambda r: r[5] * (r[6] + r[7]))
            _, tag, ln, bx, by, bw, bh, bd = box
            # Elements inside the box (kerns, glue, math) carry more precise line numbers.
            inner = [
                r for r in recs
                if r[0] in "xkg$" and self.inputs.get(r[1]) and bx - 1 <= r[3] <= bx + bw + 1 and by - bh - 1 <= r[4] <= by + bd + 1
            ]
            if inner:
                left = [r for r in inner if r[3] <= x + 0.5]
                pick = max(left, key=lambda r: r[3]) if left else min(inner, key=lambda r: r[3])
                return {"file": self.inputs[pick[1]], "line": pick[2]}
            return {"file": self.inputs[tag], "line": ln}
        best = None
        for r in recs:
            if not self.inputs.get(r[1]) or r[2] <= 0:
                continue
            dist = (r[3] - x) ** 2 + (r[4] - y) ** 2
            if best is None or dist < best[0]:
                best = (dist, r)
        if best:
            return {"file": self.inputs[best[1][1]], "line": best[1][2]}
        return None


def _merge_rows(rects: List[dict]) -> List[dict]:
    """Collapse many little boxes on the same baseline into one highlight per row."""
    rows: Dict[int, dict] = {}
    for r in rects:
        key = round(r["y"] / 4)
        if key in rows:
            a = rows[key]
            x1, y1 = min(a["x"], r["x"]), min(a["y"], r["y"])
            x2, y2 = max(a["x"] + a["w"], r["x"] + r["w"]), max(a["y"] + a["h"], r["y"] + r["h"])
            rows[key] = {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}
        else:
            rows[key] = dict(r)
    return sorted(rows.values(), key=lambda r: r["y"])
