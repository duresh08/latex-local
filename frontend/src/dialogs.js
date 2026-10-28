// Settings, setup guide (TeX installation help), quick open, folder browser.

import { api } from './api.js';
import { clear, copyText, h, icon, modal, toast } from './dom.js';

// ---------------------------------------------------------------- setup guide
function cmd(text) {
  return h('div', { class: 'cmd-row' }, h('code', { class: 'cmd' }, text),
    h('button', { class: 'icon-btn', title: 'Copy', onclick: () => copyText(text).then(() => toast('Copied', 'success', 1200)) }, icon('copy', 14)));
}

function externalLink(url, label) {
  return h('a', { href: url, target: '_blank', rel: 'noopener' }, label || url);
}

function stepsFor(platform) {
  if (platform === 'windows') {
    return [
      h('h3', null, 'Option A: TeX Live (recommended, the same distribution Overleaf runs)'),
      h('ol', null,
        h('li', null, 'Download ', h('strong', null, 'install-tl-windows.exe'), ' from ', externalLink('https://tug.org/texlive/windows.html', 'tug.org/texlive/windows.html'), '.'),
        h('li', null, 'Run it and click ', h('strong', null, 'Install'), '. Keep the default ', h('em', null, 'full'), ' scheme. That gives you every package Overleaf has, so your project will compile here exactly as it does there. It is about 8 GB and takes 1–2 hours, once.'),
        h('li', null, 'When it finishes, click ', h('strong', null, 'Check again'), ' below. You don\'t need to restart Windows; LaTeX Lab finds C:\\texlive\\<year> by itself.')),
      h('p', { class: 'muted small' }, 'After this, compiling never needs the internet.'),
      h('h3', null, 'Option B: MiKTeX (smaller, downloads packages as needed)'),
      cmd('winget install -e --id MiKTeX.MiKTeX'),
      h('p', { class: 'muted small' }, 'Then open MiKTeX Console → Settings → "Always install missing packages on-the-fly". MiKTeX needs internet the first time each new package is used. LaTeX Lab works around MiKTeX\'s missing Perl automatically.'),
      h('h3', null, 'Option C: Docker (an exact TeX Live image)'),
      h('p', { class: 'muted small' }, 'If you already use Docker Desktop:'),
      cmd('docker pull texlive/texlive:latest'),
      h('p', { class: 'muted small' }, 'Then choose Settings → Engine → Docker.'),
      h('h3', null, 'Git (for GitHub sync)'),
      cmd('winget install --id Git.Git -e'),
    ];
  }
  if (platform === 'mac') {
    return [
      h('h3', null, 'MacTeX (recommended, the same TeX Live Overleaf runs)'),
      cmd('brew install --cask mactex-no-gui'),
      h('p', { class: 'muted small' }, 'Or download MacTeX.pkg from ', externalLink('https://tug.org/mactex/', 'tug.org/mactex'), '. LaTeX Lab finds /Library/TeX/texbin by itself.'),
      h('h3', null, 'Git'), cmd('xcode-select --install'),
    ];
  }
  return [
    h('h3', null, 'TeX Live'),
    cmd('sudo apt install texlive-full latexmk biber'),
    h('p', { class: 'muted small' }, 'Fedora: sudo dnf install texlive-scheme-full latexmk. Or use the upstream installer from tug.org/texlive.'),
    h('h3', null, 'Git'), cmd('sudo apt install git'),
  ];
}

export async function showSetupGuide({ onChanged } = {}) {
  const body = h('div', { class: 'setup' });
  const m = modal({ title: 'Set up LaTeX on this computer', body, wide: true, actions: [{ label: 'Close', primary: true }] });
  const render = async (refresh) => {
    clear(body).append(h('p', { class: 'muted' }, 'Checking your installation…'));
    let rep;
    try {
      rep = await api.get('/api/doctor', { refresh: refresh ? '1' : '0' });
    } catch (err) {
      clear(body).append(h('p', { class: 'error-text' }, err.message));
      return;
    }
    clear(body);
    body.append(h('div', { class: `setup-status ${rep.ready ? 'ok' : 'bad'}` },
      icon(rep.ready ? 'check' : 'alert', 18),
      h('span', null, rep.ready ? `Ready to compile with ${rep.engine === 'builtin' ? 'the built-in runner' : rep.engine} (${rep.distro || 'TeX'}).` : rep.engineReason)));
    body.append(h('table', { class: 'checks' }, rep.checks.map((c) => h('tr', { class: `check-${c.level}` },
      h('td', null, icon(c.level === 'ok' ? 'check' : c.level === 'missing' ? 'x' : c.level === 'warn' ? 'alert' : 'minus', 14)),
      h('td', null, c.name), h('td', { class: 'muted small' }, c.detail)))));
    const binInput = h('input', { class: 'input', value: rep.texBinOverride || '', placeholder: rep.platform === 'windows' ? 'C:\\texlive\\2025\\bin\\windows' : '/usr/local/texlive/2025/bin/x86_64-linux', spellcheck: false });
    body.append(
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => render(true) }, icon('refresh', 14), 'Check again')),
      h('details', { class: 'setup-steps', open: !rep.ready }, h('summary', null, rep.ready ? 'Installation instructions' : 'How to install LaTeX'), ...stepsFor(rep.platform)),
      h('details', { class: 'setup-steps' }, h('summary', null, 'Installed but not detected?'),
        h('p', { class: 'muted small' }, 'Paste the folder that contains pdflatex', rep.platform === 'windows' ? '.exe' : '', ':'),
        h('div', { class: 'row' }, binInput, h('button', {
          class: 'btn', onclick: async () => {
            try {
              await api.put('/api/app-settings', { texBinDir: binInput.value });
              toast('Saved', 'success', 1500);
              render(true);
              onChanged && onChanged();
            } catch (err) { toast(err.message, 'error'); }
          },
        }, 'Use this folder'))));
  };
  render(false);
  return m;
}

// ---------------------------------------------------------------- settings
export function showSettings({ settings, prefs, onSettings, onPrefs, onSetup }) {
  const sel = (value, options, onChange) => {
    const s = h('select', { class: 'input', onchange: () => onChange(s.value) },
      options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
    return s;
  };
  const check = (value, label, onChange) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: !!value, onchange: (e) => onChange(e.target.checked) }), label);
  const update = async (changes) => {
    try {
      const s = await api.put('/api/settings', changes);
      onSettings(s);
    } catch (err) { toast(err.message, 'error'); }
  };
  const mains = settings.mainCandidates && settings.mainCandidates.length ? settings.mainCandidates : (settings.mainFile ? [settings.mainFile] : []);
  if (settings.mainFile && !mains.includes(settings.mainFile)) mains.unshift(settings.mainFile);
  const timeout = h('input', { class: 'input narrow', type: 'number', min: 10, max: 3600, value: settings.timeout, onchange: (e) => update({ timeout: Number(e.target.value) }) });
  const image = h('input', { class: 'input', value: settings.dockerImage, spellcheck: false, onchange: (e) => update({ dockerImage: e.target.value }) });
  const fontSize = h('input', { class: 'input narrow', type: 'number', min: 9, max: 32, value: prefs.fontSize, onchange: (e) => onPrefs({ fontSize: Number(e.target.value) || 14 }) });

  const body = h('div', { class: 'settings' },
    h('h3', null, 'Compiler'),
    h('div', { class: 'grid' },
      h('label', null, 'Main document'), sel(settings.mainFile || '', mains.map((m) => [m, m]), (v) => update({ mainFile: v })),
      h('label', null, 'Compiler'), sel(settings.compiler, [['pdflatex', 'pdfLaTeX (Overleaf default)'], ['xelatex', 'XeLaTeX'], ['lualatex', 'LuaLaTeX'], ['latex', 'LaTeX (DVI → PDF)']], (v) => update({ compiler: v })),
      h('label', null, 'Engine'), sel(settings.engine, [['auto', 'Automatic (recommended)'], ['latexmk', 'latexmk (like Overleaf)'], ['builtin', 'Built-in runner (no Perl needed)'], ['docker', 'Docker'], ['tectonic', 'Tectonic']], (v) => update({ engine: v })),
      h('label', null, 'Timeout (seconds)'), timeout,
      h('label', null, 'Docker image'), image),
    check(settings.shellEscape, 'Allow shell escape (needed by minted, svg, some TikZ externalisation; Overleaf allows it)', (v) => update({ shellEscape: v })),
    check(settings.haltOnError, 'Stop on first error', (v) => update({ haltOnError: v })),
    h('h3', null, 'Editor'),
    h('div', { class: 'grid' },
      h('label', null, 'Theme'), sel(prefs.theme, [['light', 'Light'], ['dark', 'Dark']], (v) => onPrefs({ theme: v })),
      h('label', null, 'Font size'), fontSize),
    check(prefs.lineWrapping, 'Wrap long lines', (v) => onPrefs({ lineWrapping: v })),
    check(prefs.spellcheck, 'Spell check (uses your browser\'s dictionary, works offline)', (v) => onPrefs({ spellcheck: v })),
    check(prefs.autoCompile, 'Auto-compile after you stop typing', (v) => onPrefs({ autoCompile: v })),
    h('h3', null, 'LaTeX installation'),
    h('button', { class: 'btn', onclick: () => onSetup() }, icon('wrench', 14), 'Open the setup guide'));
  return modal({ title: 'Settings', body, actions: [{ label: 'Done', primary: true }] });
}

// ---------------------------------------------------------------- quick open
function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let last = -1;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return -1;
    score += idx === last + 1 ? 3 : 1;
    if (idx === 0 || '/._- '.includes(t[idx - 1])) score += 2;
    last = idx;
    ti = idx + 1;
  }
  return score - t.length * 0.01;
}

export function showQuickOpen(files, onPick) {
  const input = h('input', { class: 'input', placeholder: 'Type a file name…', spellcheck: false });
  const list = h('div', { class: 'quick-list' });
  let items = [];
  let selected = 0;
  const m = modal({ title: 'Go to file', body: h('div', { class: 'quick' }, input, list), className: 'quick-modal' });
  const render = () => {
    const q = input.value.trim();
    items = (q ? files.map((f) => [fuzzyScore(q, f), f]).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]).map(([, f]) => f) : files).slice(0, 60);
    selected = Math.min(selected, Math.max(0, items.length - 1));
    clear(list);
    items.forEach((f, i) => list.append(h('button', {
      class: `quick-item ${i === selected ? 'sel' : ''}`,
      onclick: () => { m.close(); onPick(f); },
    }, h('span', null, f.split('/').pop()), h('span', { class: 'muted small' }, f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''))));
  };
  input.addEventListener('input', () => { selected = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { selected = Math.min(items.length - 1, selected + 1); render(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { selected = Math.max(0, selected - 1); render(); e.preventDefault(); }
    if (e.key === 'Enter' && items[selected]) { m.close(); onPick(items[selected]); }
  });
  render();
}

// ---------------------------------------------------------------- folder browser
export function browseFolder(start, onPick, { title = 'Choose a folder', okText = 'Choose this folder' } = {}) {
  const pathEl = h('input', { class: 'input', spellcheck: false });
  const list = h('div', { class: 'browse-list' });
  const note = h('p', { class: 'muted small' });
  let current = '';
  const go = async (path) => {
    let data;
    try {
      data = await api.get('/api/browse', { path });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    current = data.path;
    pathEl.value = data.path;
    clear(list);
    if (data.parent !== null && data.parent !== undefined) {
      list.append(h('button', { class: 'browse-item', onclick: () => go(data.parent) }, icon('arrowUp', 14), '..'));
    }
    for (const s of data.shortcuts || []) list.append(h('button', { class: 'browse-item shortcut', onclick: () => go(s.path) }, icon('home', 14), s.name));
    for (const d of data.dirs) list.append(h('button', { class: 'browse-item', ondblclick: () => go(d.path), onclick: () => go(d.path) }, icon('folder', 14), d.name));
    if (!data.dirs.length && data.path) list.append(h('p', { class: 'muted small pad' }, 'No sub-folders.'));
    note.textContent = data.hasTex ? 'This folder contains .tex files.' : '';
  };
  pathEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(pathEl.value); });
  modal({
    title, wide: true,
    body: h('div', { class: 'browse' }, pathEl, list, note),
    actions: [{ label: 'Cancel' }, { label: okText, primary: true, onClick: () => { if (!current) return false; onPick(current); return true; } }],
  });
  go(start || '');
}
