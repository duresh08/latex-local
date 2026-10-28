import unittest

from latexlab.logparser import parse_blg, parse_log

FILE_LINE_LOG = r"""This is pdfTeX, Version 3.141592653-2.6-1.40.25 (TeX Live 2023) (preloaded format=pdflatex)
(./main.tex
LaTeX2e <2023-11-01>
(/usr/share/texlive/texmf-dist/tex/latex/base/report.cls
Document Class: report 2023/05/17 v1.4n Standard LaTeX document class
(/usr/share/texlive/texmf-dist/tex/latex/base/size11.clo))
(./output.aux (./chapters/introduction.aux) (./chapters/methods.aux))
(./chapters/introduction.tex
Chapter 1.

LaTeX Warning: Reference `fig:missing' on page 1 undefined on input line 12.

[1]) (./chapters/methods.tex
Chapter 2.
./chapters/methods.tex:4: Undefined control sequence.
l.4 Let $p_t$ \badcommand
                          denote the price
Overfull \hbox (205.89406pt too wide) detected at line 26
[]\T1/lmr/m/n/10.95 aaaaaaaa (with parens

Package natbib Warning: Citation `nokey' on page 3 undefined on input line 30.

[2])
LaTeX Warning: There were undefined references.

 )
Output written on output.pdf (5 pages, 123456 bytes).
"""

CLASSIC_LOG = r"""(./main.tex (/usr/share/texlive/texmf-dist/tex/latex/base/article.cls)
! LaTeX Error: File `doesnotexist.sty' not found.

Type X to quit or <RETURN> to proceed,
or enter new name. (Default extension: sty)

Enter file name:
! Emergency stop.
<read *>

l.9 \usepackage
               {microtype}^^M
*** (cannot \read from terminal in nonstop modes)
"""

WINDOWS_LOG = r"""(C:/Users/Dhruv Suresh/AppData/Roaming/LaTeXLab/build/abc/src/main.tex
("C:/Users/Dhruv Suresh/AppData/Roaming/LaTeXLab/build/abc/src/my chapter.tex"
C:/Users/Dhruv Suresh/AppData/Roaming/LaTeXLab/build/abc/src/my chapter.tex:7: Missing $ inserted.
<inserted text>
                $
l.7 x_
      1
)
"""


class LogParserTests(unittest.TestCase):
    def test_file_line_errors_and_warnings_are_attributed_to_the_right_file(self):
        res = parse_log(FILE_LINE_LOG)
        self.assertEqual(res["pages"], 5)
        by_msg = {e["message"]: e for e in res["entries"]}
        err = by_msg["Undefined control sequence."]
        self.assertEqual((err["level"], err["file"], err["line"]), ("error", "./chapters/methods.tex", 4))
        self.assertIn("\\badcommand", err["content"])
        self.assertIn("hint", err)
        ref = next(e for e in res["entries"] if "fig:missing" in e["message"])
        self.assertEqual((ref["level"], ref["file"], ref["line"]), ("warning", "./chapters/introduction.tex", 12))
        cite = next(e for e in res["entries"] if "nokey" in e["message"])
        self.assertEqual((cite["file"], cite["line"]), ("./chapters/methods.tex", 30))
        self.assertTrue(cite["message"].startswith("Package natbib: "))
        box = next(e for e in res["entries"] if e["level"] == "typesetting")
        self.assertEqual((box["file"], box["line"]), ("./chapters/methods.tex", 26))
        self.assertTrue(any(e["message"] == "There were undefined references." for e in res["entries"]))

    def test_missing_package_finds_line_after_emergency_stop(self):
        res = parse_log(CLASSIC_LOG)
        errors = [e for e in res["entries"] if e["level"] == "error"]
        self.assertEqual(len(errors), 1, errors)
        self.assertEqual(errors[0]["line"], 9)
        self.assertEqual(errors[0]["file"], "./main.tex")
        self.assertIn("tlmgr install doesnotexist", errors[0]["hint"])

    def test_windows_paths_with_spaces(self):
        res = parse_log(WINDOWS_LOG)
        err = res["entries"][0]
        self.assertEqual(err["line"], 7)
        self.assertTrue(err["file"].endswith("my chapter.tex"))
        self.assertIn("math mode", err["hint"])

    def test_empty_log(self):
        self.assertEqual(parse_log("")["entries"], [])


class BlgTests(unittest.TestCase):
    def test_biber(self):
        text = "[0] Config.pm:307> INFO - This is Biber 2.19\n[123] Biber.pm:1234> WARN - I didn't find a database entry for 'nokey' (section 0)\n[124] Utils.pm:1> ERROR - Cannot find 'refs.bib'!\n"
        out = parse_blg(text, "biber")
        self.assertEqual([e["level"] for e in out], ["warning", "error"])

    def test_bibtex(self):
        text = 'Warning--I didn\'t find a database entry for "smith2020"\nI was expecting a `,\' or a `}\'---line 23 of file refs.bib\n'
        out = parse_blg(text, "bibtex")
        self.assertEqual(out[0]["level"], "warning")
        self.assertEqual((out[1]["level"], out[1]["file"], out[1]["line"]), ("error", "refs.bib", 23))


if __name__ == "__main__":
    unittest.main()
