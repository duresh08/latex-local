# Third-party software

The prebuilt editor UI in `latexlab/static/` bundles:

| Component | License | Source |
|---|---|---|
| CodeMirror 6 (`codemirror`, `@codemirror/*`) | MIT | https://codemirror.net |
| `@codemirror/legacy-modes` (sTeX mode) | MIT | https://github.com/codemirror/legacy-modes |
| PDF.js (`pdfjs-dist`) | Apache-2.0 | https://mozilla.github.io/pdf.js/ |
| Lezer / style-mod / w3c-keyname / crelt (CodeMirror dependencies) | MIT | https://lezer.codemirror.net |

LaTeX Lab does not include Overleaf code. Its compile setup copies the
`latexmk` options Overleaf documents publicly (`latexmk -cd -jobname=output
-synctex=1 -interaction=batchmode -f -pdf`).
