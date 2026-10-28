// LaTeX language support for CodeMirror: highlighting + Overleaf-style autocomplete.

import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { snippet, startCompletion } from '@codemirror/autocomplete';

export const latexLanguage = StreamLanguage.define(stex);

export const latexLanguageData = latexLanguage.data.of({
  closeBrackets: { brackets: ['(', '[', '{', '$'] },
  commentTokens: { line: '%' },
});

// [name, argument template, description]. `{}` becomes a tab-stop.
const COMMANDS = [
  ['part', '{}', 'Part heading'], ['chapter', '{}', 'Chapter heading'], ['section', '{}', 'Section heading'],
  ['subsection', '{}', 'Subsection heading'], ['subsubsection', '{}', 'Subsubsection heading'], ['paragraph', '{}', 'Paragraph heading'],
  ['section*', '{}', 'Unnumbered section'], ['subsection*', '{}', 'Unnumbered subsection'], ['chapter*', '{}', 'Unnumbered chapter'],
  ['label', '{}', 'Label for cross-references'], ['ref', '{}', 'Reference a label'], ['eqref', '{}', 'Equation reference'],
  ['pageref', '{}', 'Page of a label'], ['cref', '{}', 'cleveref reference'], ['Cref', '{}', 'cleveref reference (capitalised)'],
  ['autoref', '{}', 'hyperref auto reference'], ['nameref', '{}', 'Name of a label'],
  ['cite', '{}', 'Citation'], ['citep', '{}', 'natbib parenthetical citation'], ['citet', '{}', 'natbib textual citation'],
  ['parencite', '{}', 'biblatex parenthetical citation'], ['textcite', '{}', 'biblatex textual citation'],
  ['autocite', '{}', 'biblatex auto citation'], ['footcite', '{}', 'biblatex footnote citation'], ['nocite', '{}', 'Add to bibliography without citing'],
  ['citeauthor', '{}', 'Author of a citation'], ['citeyear', '{}', 'Year of a citation'],
  ['textbf', '{}', 'Bold'], ['textit', '{}', 'Italic'], ['emph', '{}', 'Emphasis'], ['underline', '{}', 'Underline'],
  ['texttt', '{}', 'Monospace'], ['textsc', '{}', 'Small caps'], ['textrm', '{}', 'Roman'], ['textsf', '{}', 'Sans serif'],
  ['textsuperscript', '{}', 'Superscript text'], ['textsubscript', '{}', 'Subscript text'], ['textcolor', '{}{}', 'Coloured text'],
  ['footnote', '{}', 'Footnote'], ['marginpar', '{}', 'Margin note'], ['url', '{}', 'URL'], ['href', '{}{}', 'Hyperlink'],
  ['includegraphics', '{}', 'Insert an image'], ['includegraphics[width=\\linewidth]', '{}', 'Insert an image (full width)'],
  ['caption', '{}', 'Caption'], ['centering', '', 'Centre the contents'], ['input', '{}', 'Insert another file'],
  ['include', '{}', 'Include a chapter file (new page)'], ['includeonly', '{}', 'Compile only some \\include files'],
  ['usepackage', '{}', 'Load a package'], ['usepackage[]', '{}', 'Load a package with options'], ['documentclass', '{}', 'Document class'],
  ['documentclass[]', '{}', 'Document class with options'], ['begin', '', 'Start an environment'], ['end', '{}', 'End an environment'],
  ['item', '', 'List item'], ['item[]', '', 'Labelled list item'], ['title', '{}', 'Document title'], ['author', '{}', 'Document author'],
  ['date', '{}', 'Document date'], ['today', '', "Today's date"], ['maketitle', '', 'Typeset the title'],
  ['tableofcontents', '', 'Table of contents'], ['listoffigures', '', 'List of figures'], ['listoftables', '', 'List of tables'],
  ['appendix', '', 'Start the appendices'], ['bibliography', '{}', 'BibTeX bibliography file'], ['bibliographystyle', '{}', 'BibTeX style'],
  ['printbibliography', '', 'biblatex: print bibliography'], ['addbibresource', '{}', 'biblatex: add .bib file'],
  ['newcommand', '{}{}', 'Define a command'], ['renewcommand', '{}{}', 'Redefine a command'], ['newenvironment', '{}{}{}', 'Define an environment'],
  ['DeclareMathOperator', '{}{}', 'Define a math operator'], ['newtheorem', '{}{}', 'Define a theorem environment'],
  ['setlength', '{}{}', 'Set a length'], ['vspace', '{}', 'Vertical space'], ['hspace', '{}', 'Horizontal space'],
  ['vspace*', '{}', 'Vertical space (kept at page top)'], ['newpage', '', 'New page'], ['clearpage', '', 'Flush floats and start a new page'],
  ['cleardoublepage', '', 'Start on a right-hand page'], ['linebreak', '', 'Break the line'], ['noindent', '', 'No paragraph indent'],
  ['smallskip', '', 'Small vertical skip'], ['medskip', '', 'Medium vertical skip'], ['bigskip', '', 'Big vertical skip'],
  ['hfill', '', 'Horizontal fill'], ['vfill', '', 'Vertical fill'], ['quad', '', 'Space'], ['qquad', '', 'Double space'],
  ['linewidth', '', 'Line width length'], ['textwidth', '', 'Text width length'], ['columnwidth', '', 'Column width'],
  ['tiny', '', 'Font size'], ['scriptsize', '', 'Font size'], ['footnotesize', '', 'Font size'], ['small', '', 'Font size'],
  ['normalsize', '', 'Font size'], ['large', '', 'Font size'], ['Large', '', 'Font size'], ['LARGE', '', 'Font size'], ['huge', '', 'Font size'],
  ['Huge', '', 'Font size'], ['hline', '', 'Table rule'], ['toprule', '', 'booktabs top rule'], ['midrule', '', 'booktabs middle rule'],
  ['bottomrule', '', 'booktabs bottom rule'], ['cline', '{}', 'Partial table rule'], ['multicolumn', '{}{}{}', 'Span columns'],
  ['multirow', '{}{}{}', 'Span rows'], ['frac', '{}{}', 'Fraction'], ['dfrac', '{}{}', 'Display-style fraction'], ['tfrac', '{}{}', 'Text-style fraction'],
  ['sqrt', '{}', 'Square root'], ['sqrt[]', '{}', 'n-th root'], ['sum', '', 'Sum'], ['prod', '', 'Product'], ['int', '', 'Integral'],
  ['iint', '', 'Double integral'], ['oint', '', 'Contour integral'], ['lim', '', 'Limit'], ['limits', '', 'Limits placement'],
  ['infty', '', 'Infinity'], ['partial', '', 'Partial derivative'], ['nabla', '', 'Nabla'], ['cdot', '', 'Centred dot'], ['cdots', '', 'Centred dots'],
  ['ldots', '', 'Dots'], ['vdots', '', 'Vertical dots'], ['ddots', '', 'Diagonal dots'], ['times', '', 'Times'], ['div', '', 'Divide'],
  ['pm', '', 'Plus-minus'], ['mp', '', 'Minus-plus'], ['leq', '', '≤'], ['geq', '', '≥'], ['neq', '', '≠'], ['approx', '', '≈'], ['equiv', '', '≡'],
  ['sim', '', '∼'], ['simeq', '', '≃'], ['propto', '', '∝'], ['ll', '', '≪'], ['gg', '', '≫'], ['in', '', '∈'], ['notin', '', '∉'],
  ['subset', '', '⊂'], ['subseteq', '', '⊆'], ['supset', '', '⊃'], ['cup', '', '∪'], ['cap', '', '∩'], ['setminus', '', '∖'],
  ['emptyset', '', '∅'], ['forall', '', '∀'], ['exists', '', '∃'], ['neg', '', '¬'], ['land', '', '∧'], ['lor', '', '∨'],
  ['to', '', '→'], ['rightarrow', '', '→'], ['leftarrow', '', '←'], ['Rightarrow', '', '⇒'], ['Leftarrow', '', '⇐'],
  ['leftrightarrow', '', '↔'], ['Leftrightarrow', '', '⇔'], ['iff', '', '⟺'], ['implies', '', '⟹'], ['mapsto', '', '↦'],
  ['mathbb', '{}', 'Blackboard bold'], ['mathcal', '{}', 'Calligraphic'], ['mathbf', '{}', 'Bold math'], ['mathrm', '{}', 'Roman math'],
  ['mathit', '{}', 'Italic math'], ['mathsf', '{}', 'Sans-serif math'], ['mathfrak', '{}', 'Fraktur'], ['boldsymbol', '{}', 'Bold symbol'],
  ['operatorname', '{}', 'Operator name'], ['text', '{}', 'Text inside math'], ['left', '', 'Scalable left delimiter'],
  ['right', '', 'Scalable right delimiter'], ['big', '', 'Bigger delimiter'], ['Big', '', 'Bigger delimiter'], ['bigg', '', 'Bigger delimiter'],
  ['hat', '{}', 'Hat accent'], ['widehat', '{}', 'Wide hat'], ['bar', '{}', 'Bar accent'], ['overline', '{}', 'Overline'],
  ['tilde', '{}', 'Tilde accent'], ['widetilde', '{}', 'Wide tilde'], ['vec', '{}', 'Vector arrow'], ['dot', '{}', 'Dot accent'],
  ['ddot', '{}', 'Double dot accent'], ['underbrace', '{}', 'Underbrace'], ['overbrace', '{}', 'Overbrace'], ['binom', '{}{}', 'Binomial'],
  ['log', '', 'Logarithm'], ['ln', '', 'Natural log'], ['exp', '', 'Exponential'], ['sin', '', 'Sine'], ['cos', '', 'Cosine'], ['tan', '', 'Tangent'],
  ['max', '', 'Maximum'], ['min', '', 'Minimum'], ['sup', '', 'Supremum'], ['inf', '', 'Infimum'], ['arg', '', 'Argument'], ['det', '', 'Determinant'],
  ['Pr', '', 'Probability'], ['mid', '', 'Divides / such that'], ['top', '', 'Transpose'], ['intercal', '', 'Transpose'],
  ['alpha', '', 'α'], ['beta', '', 'β'], ['gamma', '', 'γ'], ['delta', '', 'δ'], ['epsilon', '', 'ϵ'], ['varepsilon', '', 'ε'], ['zeta', '', 'ζ'],
  ['eta', '', 'η'], ['theta', '', 'θ'], ['vartheta', '', 'ϑ'], ['iota', '', 'ι'], ['kappa', '', 'κ'], ['lambda', '', 'λ'], ['mu', '', 'μ'],
  ['nu', '', 'ν'], ['xi', '', 'ξ'], ['pi', '', 'π'], ['rho', '', 'ρ'], ['sigma', '', 'σ'], ['tau', '', 'τ'], ['upsilon', '', 'υ'], ['phi', '', 'ϕ'],
  ['varphi', '', 'φ'], ['chi', '', 'χ'], ['psi', '', 'ψ'], ['omega', '', 'ω'], ['Gamma', '', 'Γ'], ['Delta', '', 'Δ'], ['Theta', '', 'Θ'],
  ['Lambda', '', 'Λ'], ['Xi', '', 'Ξ'], ['Pi', '', 'Π'], ['Sigma', '', 'Σ'], ['Upsilon', '', 'Υ'], ['Phi', '', 'Φ'], ['Psi', '', 'Ψ'], ['Omega', '', 'Ω'],
  ['qedhere', '', 'Place QED symbol here'], ['si', '{}', 'siunitx unit'], ['SI', '{}{}', 'siunitx quantity'], ['num', '{}', 'siunitx number'],
  ['lipsum', '', 'Dummy text'], ['todo', '{}', 'todonotes note'], ['enquote', '{}', 'csquotes quotation'], ['subfile', '{}', 'subfiles include'],
  ['graphicspath', '{}', 'Image search folders'], ['hypersetup', '{}', 'hyperref options'], ['geometry', '{}', 'Page geometry'],
  ['pagestyle', '{}', 'Page style'], ['thispagestyle', '{}', 'Page style for this page'], ['pagenumbering', '{}', 'Page numbering style'],
  ['setcounter', '{}{}', 'Set a counter'], ['addtocounter', '{}{}', 'Add to a counter'], ['arabic', '{}', 'Arabic counter'],
  ['renewcommand*', '{}{}', 'Redefine a command'], ['newline', '', 'New line'], ['par', '', 'End paragraph'], ['protect', '', 'Protect fragile command'],
  ['phantom', '{}', 'Invisible box'], ['mbox', '{}', 'Unbreakable box'], ['makebox', '{}', 'Box'], ['fbox', '{}', 'Framed box'], ['parbox', '{}{}', 'Paragraph box'],
  ['raisebox', '{}{}', 'Raised box'], ['rule', '{}{}', 'Rule'], ['color', '{}', 'Switch colour'], ['definecolor', '{}{}{}', 'Define a colour'],
  ['tikz', '{}', 'Inline TikZ'], ['node', '', 'TikZ node'], ['draw', '', 'TikZ draw'], ['fill', '', 'TikZ fill'],
];

const ENVIRONMENTS = {
  itemize: '\t\\item ${}', enumerate: '\t\\item ${}', description: '\t\\item[${}] ',
  equation: '\t${}', 'equation*': '\t${}', align: '\t${}', 'align*': '\t${}', gather: '\t${}', 'gather*': '\t${}',
  multline: '\t${}', split: '\t${}', cases: '\t${} & ', matrix: '\t${}', pmatrix: '\t${}', bmatrix: '\t${}', vmatrix: '\t${}',
  figure: '[${htbp}]\n\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{${}}\n\t\\caption{${}}\n\t\\label{fig:${}}',
  'figure*': '[${htbp}]\n\t\\centering\n\t\\includegraphics[width=\\textwidth]{${}}\n\t\\caption{${}}\n\t\\label{fig:${}}',
  table: '[${htbp}]\n\t\\centering\n\t\\begin{tabular}{${ll}}\n\t\t${}\n\t\\end{tabular}\n\t\\caption{${}}\n\t\\label{tab:${}}',
  tabular: '{${ll}}\n\t${}', tabularx: '{\\linewidth}{${lX}}\n\t${}', longtable: '{${ll}}\n\t${}',
  center: '\t${}', flushleft: '\t${}', flushright: '\t${}', minipage: '{${0.45\\linewidth}}\n\t${}', abstract: '\t${}',
  quote: '\t${}', quotation: '\t${}', verbatim: '${}', theorem: '\t${}', lemma: '\t${}', proposition: '\t${}', corollary: '\t${}',
  definition: '\t${}', remark: '\t${}', example: '\t${}', proof: '\t${}', frame: '{${Title}}\n\t${}', block: '{${Title}}\n\t${}',
  columns: '\n\t\\begin{column}{0.5\\textwidth}\n\t\t${}\n\t\\end{column}', column: '{${0.5\\textwidth}}\n\t${}',
  lstlisting: '${}', minted: '{${python}}\n${}', tikzpicture: '\n\t${}', axis: '\n\t${}', subfigure: '{${0.45\\linewidth}}\n\t\\centering\n\t${}',
  thebibliography: '{${99}}\n\t\\bibitem{${}} ', appendices: '\t${}', algorithm: '\n\t\\caption{${}}\n\t${}', algorithmic: '\n\t${}',
  document: '\n${}\n', titlepage: '\t${}', landscape: '\t${}', comment: '${}', array: '{${cc}}\n\t${}', alignat: '{${2}}\n\t${}',
  'align*': '\t${}',
};

const PACKAGES = 'amsmath amssymb amsthm mathtools graphicx xcolor hyperref cleveref geometry fancyhdr booktabs tabularx longtable multirow array siunitx tikz pgfplots caption subcaption float wrapfig enumitem natbib biblatex csquotes babel inputenc fontenc lmodern microtype setspace parskip titlesec tocloft listings minted algorithm algpseudocode algorithm2e url xspace todonotes lipsum blindtext appendix glossaries acronym nomencl makeidx imakeidx physics bm mathrsfs dsfont bbm cancel tcolorbox mdframed pdfpages standalone subfiles import etoolbox xparse ifthen calc fontspec unicode-math polyglossia ragged2e changepage afterpage placeins threeparttable dcolumn rotating pdflscape textcomp gensymb mhchem chemfig circuitikz forest tikz-cd datetime2 lastpage hyphenat footmisc sectsty authblk thmtools upgreek esint stmaryrd'.split(' ');
const CLASSES = 'article report book memoir beamer amsart amsbook scrartcl scrreprt scrbook standalone letter IEEEtran revtex4-2 elsarticle llncs acmart moderncv'.split(' ');

const REF_CMDS = /^(ref|eqref|pageref|cref|Cref|cpageref|autoref|nameref|vref|vpageref|labelcref|subref|hyperref)$/;
const CITE_CMDS = /^(cite[a-zA-Z]*|[pP]arencite|[tT]extcite|[aA]utocite|[fF]ootcite|[sS]martcite|[sS]upercite|nocite|fullcite|footfullcite|citeauthor|citeyear|citetitle|citep|citet|citealt|citealp)\*?$/;
const INPUT_CMDS = /^(input|include|subfile|import|subimport|includeonly|InputIfFileExists|lstinputlisting|inputminted)$/;
const IMAGE_EXT = /\.(png|jpe?g|pdf|eps|svg|gif|bmp|tiff?)$/i;

function template(argSpec) {
  return argSpec.replace(/\{\}/g, '{${}}');
}

function commandOptions(symbols) {
  const seen = new Set();
  const out = [];
  for (const [name, args, detail] of COMMANDS) {
    if (seen.has(name)) continue;
    seen.add(name);
    const label = `\\${name}`;
    if (name === 'begin') {
      out.push({
        label, detail, type: 'keyword', boost: 5,
        apply: (view, completion, from, to) => {
          view.dispatch({ changes: { from, to, insert: '\\begin{' }, selection: { anchor: from + 7 } });
          startCompletion(view);
        },
      });
    } else if (args) {
      out.push({ label, detail, type: 'function', apply: snippet(`${label}${template(args)}`) });
    } else {
      out.push({ label, detail, type: 'keyword' });
    }
  }
  for (const cmd of symbols.commands || []) {
    if (seen.has(cmd.name)) continue;
    seen.add(cmd.name);
    const label = `\\${cmd.name}`;
    const detail = `defined in ${cmd.file}`;
    if (cmd.args > 0) out.push({ label, detail, type: 'variable', boost: 2, apply: snippet(label + '{${}}'.repeat(cmd.args)) });
    else out.push({ label, detail, type: 'variable', boost: 2 });
  }
  return out;
}

function environmentOptions(symbols, isBegin) {
  const names = new Set(Object.keys(ENVIRONMENTS));
  for (const env of symbols.environments || []) names.add(env.name);
  return [...names].map((name) => {
    const body = (ENVIRONMENTS[name] ?? '\t${}').replace(/^\n/, '').replace(/\n$/, '');
    if (!isBegin) return { label: name, type: 'type' };
    // `{` was usually auto-closed already, so the completion owns the `}` after the cursor.
    const lines = body.split('\n');
    const tpl = body.startsWith('{') || body.startsWith('[')
      ? `${name}}${lines[0]}\n${lines.slice(1).join('\n') || '\t${}'}\n\\end{${name}}`
      : `${name}}\n${body}\n\\end{${name}}`;
    const apply = (view, completion, from, to) => {
      const end = view.state.sliceDoc(to, to + 1) === '}' ? to + 1 : to;
      snippet(tpl)(view, completion, from, end);
    };
    return { label: name, type: 'type', apply };
  });
}

/**
 * The completion source. `getSymbols` returns the latest project symbols:
 * { labels, bib, commands, environments, files }.
 */
export function latexCompletionSource(getSymbols) {
  return (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const symbols = getSymbols();

    const arg = before.match(/\\([a-zA-Z]+\*?)\s*(?:\[[^\]]*\])*\{([^{}]*)$/);
    if (arg) {
      const cmd = arg[1];
      const text = arg[2];
      const comma = text.lastIndexOf(',');
      const word = text.slice(comma + 1).replace(/^\s+/, '');
      const from = context.pos - word.length;
      const validFor = /^[^},\s]*$/;
      if (REF_CMDS.test(cmd)) {
        return { from, validFor, options: (symbols.labels || []).map((l) => ({ label: l.label, detail: `${l.file}:${l.line}`, info: l.context, type: 'constant' })) };
      }
      if (CITE_CMDS.test(cmd)) {
        return {
          from, validFor,
          options: (symbols.bib || []).map((b) => ({
            label: b.key, type: 'text',
            detail: [b.author && b.author.split(' and ')[0].split(',')[0], b.year || (b.date || '').slice(0, 4)].filter(Boolean).join(', '),
            info: b.title || b.type,
          })),
        };
      }
      if (cmd === 'begin' || cmd === 'end') {
        return { from: context.pos - text.length, validFor: /^[a-zA-Z*]*$/, options: environmentOptions(symbols, cmd === 'begin') };
      }
      const files = symbols.files || [];
      if (INPUT_CMDS.test(cmd)) {
        const stripExt = cmd === 'include' || cmd === 'includeonly' || cmd === 'subfile';
        return {
          from, validFor: /^[^},]*$/,
          options: files.filter((f) => /\.(tex|ltx)$/i.test(f) || /^(lstinputlisting|inputminted)$/.test(cmd))
            .map((f) => ({ label: stripExt ? f.replace(/\.tex$/i, '') : f, type: 'text' })),
        };
      }
      if (cmd === 'includegraphics' || cmd === 'includepdf' || cmd === 'includesvg') {
        return { from, validFor: /^[^}]*$/, options: files.filter((f) => IMAGE_EXT.test(f)).map((f) => ({ label: f, type: 'text' })) };
      }
      if (cmd === 'bibliography' || cmd === 'addbibresource') {
        const strip = cmd === 'bibliography';
        return { from, validFor, options: files.filter((f) => /\.bib$/i.test(f)).map((f) => ({ label: strip ? f.replace(/\.bib$/i, '') : f, type: 'text' })) };
      }
      if (cmd === 'usepackage' || cmd === 'RequirePackage') {
        return { from, validFor, options: PACKAGES.map((p) => ({ label: p, type: 'namespace' })) };
      }
      if (cmd === 'documentclass') {
        return { from, validFor, options: CLASSES.map((c) => ({ label: c, type: 'class' })) };
      }
      return null;
    }

    const cmd = context.matchBefore(/\\[a-zA-Z@*]*/);
    if (cmd && (cmd.to - cmd.from > 1 || context.explicit)) {
      return { from: cmd.from, validFor: /^\\[a-zA-Z@*]*$/, options: commandOptions(symbols) };
    }
    return null;
  };
}

/** Section outline for the current document. */
const OUTLINE_RE = /\\(part|chapter|section|subsection|subsubsection|paragraph)(\*?)\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/;
const LEVELS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };

export function buildOutline(doc) {
  const items = [];
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    if (!text.includes('\\')) continue;
    const code = text.replace(/(^|[^\\])%.*/, '$1');
    const m = code.match(OUTLINE_RE);
    if (m) items.push({ level: LEVELS[m[1]], kind: m[1], starred: !!m[2], title: m[3].replace(/\\[a-zA-Z]+\s*/g, '').replace(/[{}]/g, '').trim() || m[3], line: i });
  }
  return items;
}
