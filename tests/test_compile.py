"""End-to-end compile tests. Skipped automatically when no TeX installation is present."""

import os
import shutil
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("LATEXLAB_HOME", tempfile.mkdtemp(prefix="latexlab-home-"))

from latexlab import toolchain  # noqa: E402
from latexlab.compiler import Builder  # noqa: E402
from latexlab.project import Project  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "thesis"
TC = toolchain.get()
HAS_TEX = TC.programs.get("pdflatex") is not None


@unittest.skipUnless(HAS_TEX, "no TeX installation")
class CompileTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp()) / "thesis"
        shutil.copytree(FIXTURE, self.root)
        self.p = Project(self.root)
        self.b = Builder(self.p)

    def tearDown(self):
        self.b.clear_cache()

    def compile_with(self, engine):
        self.p.update_settings({"engine": engine})
        return self.b.compile()

    def test_builtin_runner_resolves_bibliography_and_refs(self):
        r = self.compile_with("builtin")
        self.assertEqual(r["status"], "success", r["entries"])
        self.assertEqual(r["pages"], 5)
        self.assertFalse([e for e in r["entries"] if "undefined" in e["message"].lower()])
        self.assertTrue(self.b.pdf_path())
        # The project folder stays clean: no aux files next to the sources.
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["chapters", "figures", "main.tex", "references.bib"])

    @unittest.skipUnless(TC.latexmk_ok, "latexmk not usable")
    def test_latexmk_errors_point_at_chapter_lines(self):
        m = self.root / "chapters" / "methods.tex"
        m.write_text(m.read_text().replace("Let $p_t$ denote", "Let $p_t$ \\nosuchmacro denote"))
        r = self.compile_with("latexmk")
        self.assertEqual(r["status"], "failure")
        err = next(e for e in r["entries"] if e["level"] == "error")
        self.assertEqual((err["file"], err["line"]), ("chapters/methods.tex", 4))

    def test_synctex_round_trip(self):
        self.compile_with("auto")
        fwd = self.b.forward("chapters/methods.tex", 10)
        self.assertIsNotNone(fwd)
        r = fwd["rects"][0]
        inv = self.b.inverse(fwd["page"], r["x"] + 20, r["y"] + r["h"] / 2)
        self.assertEqual(inv["file"], "chapters/methods.tex")
        self.assertIn(inv["line"], (9, 10, 11))

    def test_deleted_sources_disappear_from_build_dir(self):
        self.compile_with("auto")
        (self.root / "chapters" / "introduction.tex").unlink()
        main = self.root / "main.tex"
        main.write_text(main.read_text().replace("\\include{chapters/introduction}\n", ""))
        self.b.sync_sources()
        self.assertFalse((self.b.src / "chapters" / "introduction.tex").exists())

    def test_no_main_file(self):
        empty = Path(tempfile.mkdtemp())
        r = Builder(Project(empty)).compile()
        self.assertEqual(r["status"], "error")


class EngineChoiceTests(unittest.TestCase):
    def test_auto_reports_missing_tex(self):
        tc = toolchain.Toolchain.__new__(toolchain.Toolchain)
        tc.programs = {p: None for p in toolchain.TEX_PROGRAMS}
        tc.latexmk_ok, tc.latexmk_error, tc.docker, tc.tectonic, tc._docker_state = False, "", None, None, {}
        engine, reason = tc.pick_engine("auto", "pdflatex", "texlive/texlive:latest")
        self.assertIsNone(engine)
        self.assertIn("No LaTeX installation", reason)

    def test_auto_falls_back_to_builtin_when_latexmk_is_broken(self):
        tc = toolchain.Toolchain.__new__(toolchain.Toolchain)
        tc.programs = {p: None for p in toolchain.TEX_PROGRAMS}
        tc.programs["pdflatex"] = "pdflatex.exe"
        tc.programs["latexmk"] = "latexmk.exe"
        tc.latexmk_ok, tc.latexmk_error, tc.docker, tc.tectonic, tc._docker_state = False, "perl not found", None, None, {}
        self.assertEqual(tc.pick_engine("auto", "pdflatex", "img")[0], "builtin")
        self.assertIsNone(tc.pick_engine("latexmk", "pdflatex", "img")[0])


if __name__ == "__main__":
    unittest.main()
