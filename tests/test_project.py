import io
import os
import tempfile
import unittest
import zipfile
from pathlib import Path

os.environ.setdefault("LATEXLAB_HOME", tempfile.mkdtemp(prefix="latexlab-home-"))

from latexlab.project import Conflict, Project, ProjectError, create_blank, import_zip  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "thesis"


class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.root = self.tmp / "proj"
        self.root.mkdir()
        (self.root / "main.tex").write_text("\\documentclass{article}\n\\begin{document}\nHi\\label{sec:a}\n\\end{document}\n")
        (self.root / "chap.tex").write_text("\\section{A}\\label{sec:b} % \\label{commented}\n")
        (self.root / "refs.bib").write_text("@article{key1,\n  title = {A Title},\n  author = {Doe, J.},\n  year = {2020},\n}\n@string{x = {y}}\n")
        (self.root / ".git").mkdir()
        self.p = Project(self.root)

    def test_path_safety(self):
        for bad in ("../x", "a/../../x", ".git/config"):
            with self.assertRaises(ProjectError):
                self.p.resolve(bad)
        self.assertEqual(self.p.resolve("sub\\file.tex"), self.root / "sub" / "file.tex")

    def test_tree_hides_git(self):
        names = [c["name"] for c in self.p.tree()["children"]]
        self.assertNotIn(".git", names)
        self.assertIn("main.tex", names)

    def test_crlf_and_encoding_preserved(self):
        f = self.root / "win.tex"
        f.write_bytes("caf\xe9\r\nline2\r\n".encode("latin-1"))
        data = self.p.read_file("win.tex")
        self.assertEqual((data["eol"], data["encoding"]), ("crlf", "latin-1"))
        self.assertEqual(data["content"], "caf\xe9\nline2\n")
        self.p.write_file("win.tex", data["content"] + "line3\n", data["version"])
        self.assertEqual(f.read_bytes(), "caf\xe9\r\nline2\r\nline3\r\n".encode("latin-1"))

    def test_conflict_detection(self):
        data = self.p.read_file("main.tex")
        os.utime(self.root / "main.tex", ns=(1, 1))
        with self.assertRaises(Conflict):
            self.p.write_file("main.tex", "x", data["version"])
        self.p.write_file("main.tex", "x", data["version"], force=True)

    def test_symbols(self):
        sym = self.p.symbols()
        labels = {l["label"] for l in sym["labels"]}
        self.assertEqual(labels, {"sec:a", "sec:b"})
        self.assertEqual([b["key"] for b in sym["bib"]], ["key1"])
        self.assertEqual(sym["bib"][0]["title"], "A Title")

    def test_main_detection_and_settings(self):
        s = self.p.settings()
        self.assertEqual(s["mainFile"], "main.tex")
        self.assertEqual(s["mainCandidates"], ["main.tex"])
        with self.assertRaises(ProjectError):
            self.p.update_settings({"mainFile": "nope.tex"})
        s = self.p.update_settings({"compiler": "xelatex", "timeout": 5, "engine": "bogus"})
        self.assertEqual((s["compiler"], s["timeout"], s["engine"]), ("xelatex", 10, "auto"))

    def test_file_ops(self):
        self.p.create("figs", "dir")
        self.p.upload("figs", "a.png", b"\x89PNG\r\n\x1a\n\x00")
        self.assertTrue(self.p.read_file("figs/a.png")["binary"])
        with self.assertRaises(Conflict):
            self.p.upload("figs", "a.png", b"x")
        self.p.rename("figs", "images")
        self.assertTrue((self.root / "images" / "a.png").exists())
        with self.assertRaises(ProjectError):
            self.p.rename("images", "images/inner")
        self.p.delete("images")
        self.assertFalse((self.root / "images").exists())

    def test_search(self):
        res = self.p.search("LABEL", regex=False, case=False)
        self.assertEqual({r["path"] for r in res["results"]}, {"main.tex", "chap.tex"})
        self.assertEqual(self.p.search("LABEL", case=True)["results"], [])


class CreateTests(unittest.TestCase):
    def test_import_zip_strips_single_top_folder_and_blocks_zip_slip(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("thesis/main.tex", "\\documentclass{article}")
            zf.writestr("thesis/chapters/a.tex", "a")
            zf.writestr("thesis/../../evil.txt", "x")
        parent = Path(tempfile.mkdtemp())
        target = import_zip(parent, "imported", buf.getvalue())
        self.assertTrue((target / "main.tex").exists())
        self.assertTrue((target / "chapters" / "a.tex").exists())
        self.assertFalse((parent.parent / "evil.txt").exists())

    def test_overleaf_style_zip_without_top_folder(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            for f in FIXTURE.rglob("*"):
                if f.is_file():
                    zf.write(f, f.relative_to(FIXTURE).as_posix())
        target = import_zip(Path(tempfile.mkdtemp()), "ol", buf.getvalue())
        self.assertTrue((target / "chapters" / "methods.tex").exists())

    def test_blank_and_bad_names(self):
        parent = Path(tempfile.mkdtemp())
        self.assertTrue((create_blank(parent, "paper") / "main.tex").exists())
        for bad in ("", "a/b", "con:fused", "paper"):
            with self.assertRaises(ProjectError):
                create_blank(parent, bad)


if __name__ == "__main__":
    unittest.main()
