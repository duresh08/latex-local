import './style.css';

import { api } from './api.js';
import { clear, debounce, h, icon, menuFromButton, modal, modKey, toast } from './dom.js';
import { Editors } from './editor.js';
import { FileTree, Outline, flattenFiles } from './filetree.js';
import { PdfViewer } from './pdfviewer.js';
import { LogsView } from './logs.js';
import { GitPanel, SearchPanel } from './panels.js';
import { showQuickOpen, showSettings, showSetupGuide } from './dialogs.js';
import { buildOutline } from './latex.js';
import { renderStartPage } from './startpage.js';

const PREFS_KEY = 'latexlab.prefs';
const DEFAULT_PREFS = {
  theme: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  fontSize: 14,
  lineWrapping: true,
  spellcheck: true,
  autoCompile: false,
  sidebarWidth: 250,
  pdfWidth: null,
  layout: 'split',
  sidebarPanel: 'files',
  sidebarOpen: true,
};

function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

class LatexLab {
  constructor(root) {
    this.root = root;
    this.prefs = loadPrefs();
    this.symbols = { labels: [], bib: [], commands: [], environments: [], files: [] };
    this.compiling = false;
    this.compileQueued = false;
    this.lastResult = null;
    this.signature = null;
    this.applyTheme();
  }

  savePrefs(changes) {
    Object.assign(this.prefs, changes);
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch { /* ignore */ }
    if ('theme' in changes) this.applyTheme();
    if (this.editors && ['theme', 'fontSize', 'lineWrapping', 'spellcheck'].some((k) => k in changes)) this.editors.applyPrefs(this.prefs);
  }

  applyTheme() {
    document.documentElement.dataset.theme = this.prefs.theme;
  }

  async start() {
    let state;
    try {
      state = await api.get('/api/state');
    } catch (err) {
      clear(this.root).append(h('div', { class: 'fatal' }, h('h1', null, 'LaTeX Lab'), h('p', null, err.message)));
      return;
    }
    this.appState = state;
    if (state.project) this.openWorkspace(state);
    else this.showStart(state);
  }

  showStart(state) {
    this.teardown();
    this.appState = state;
    document.title = 'LaTeX Lab';
    this.root.className = 'app start-mode';
    renderStartPage(this.root, state, { onOpened: (st) => this.openWorkspace(st), onQuit: () => quitApp(this) });
  }

  teardown() {
    clearInterval(this.pollTimer);
    if (this.keyHandler) document.removeEventListener('keydown', this.keyHandler, true);
    if (this.focusHandler) window.removeEventListener('focus', this.focusHandler);
    this.keyHandler = null;
    this.editors = null;
    if (this.viewer) this.viewer.reset();
    this.viewer = null;
  }

  // ======================================================================== workspace
  async openWorkspace(state) {
    this.teardown();
    this.appState = state;
    this.project = state.project;
    this.settings = state.project.settings;
    this.lastResult = null;
    document.title = `${this.project.name} – LaTeX Lab`;
    this.root.className = 'app workspace-mode';
    clear(this.root);

    this.editors = new Editors({
      getSymbols: () => this.symbols,
      prefs: this.prefs,
      onActiveChange: () => { this.tree.render(); this.updateOutline(); },
      onSaved: () => { this.refreshSymbolsSoon(); this.refreshGitSoon(); if (this.prefs.autoCompile) this.autoCompileSoon(); },
      onCompile: () => this.compile(),
      onForwardSync: () => this.forwardSync(),
      onDocChange: () => this.updateOutlineSoon(),
      onTabsChange: () => this.tree && this.tree.render(),
    });
    this.tree = new FileTree({
      projectKey: this.project.root,
      onOpen: (path) => this.editors.open(path),
      onChanged: () => this.refreshTree(),
      onRenamed: (from, to) => { this.editors.renamed(from, to); if (this.settings.mainFile === from) this.reloadSettings(); },
      onDeleted: (path) => this.editors.deleted(path),
      onSetMain: (path) => this.setMain(path),
      getMain: () => this.settings.mainFile,
      getActive: () => this.editors.active,
      isDirty: (path) => { const d = this.editors.docs.get(path); return d ? this.editors.isDirty(d) : false; },
    });
    this.outline = new Outline({ onJump: (line) => this.editors.gotoLine(line, 0) });
    this.search = new SearchPanel({ onOpen: (path, line, col, len) => this.editors.open(path, { line, col, length: len }) });
    this.git = new GitPanel({
      beforeOp: () => this.editors.saveAll(),
      afterOp: () => this.checkExternal(true),
      onOpen: (path) => this.editors.open(path),
      onStatus: (st) => this.updateGitBadge(st),
    });
    this.viewer = new PdfViewer({
      onInverseSync: (page, x, y) => this.inverseSync(page, x, y),
      onPageChange: (cur, total) => { this.pageLabel.textContent = total ? `${cur} / ${total}` : '–'; },
      onZoomChange: (zoom, value) => {
        this.zoomCustom.textContent = `${Math.round(value * 100)}%`;
        const preset = typeof zoom === 'string' ? zoom : String(zoom);
        this.zoomSelect.value = [...this.zoomSelect.options].some((o) => o.value === preset && !o.disabled) ? preset : 'custom';
      },
    });
    this.logs = new LogsView({
      onJump: (file, line) => this.editors.open(file, { line }),
      onRecompileFromScratch: () => this.compile({ fromScratch: true }),
      onSetup: () => showSetupGuide({ onChanged: () => this.compile() }),
    });

    this.buildLayout();
    await this.refreshTree();
    this.refreshSymbols();
    this.git.refresh(true);
    if (this.settings.mainFile) await this.editors.open(this.settings.mainFile, { focus: true });
    // Show the last PDF straight away, then refresh it (and the logs) with a compile, like Overleaf does on open.
    this.loadPdf(true).finally(() => { if (this.settings.mainFile && this.editors) this.compile(); });

    this.pollTimer = setInterval(() => { if (document.visibilityState === 'visible') this.checkExternal(); }, 3000);
    this.focusHandler = () => this.checkExternal();
    window.addEventListener('focus', this.focusHandler);
    this.keyHandler = (e) => this.onKey(e);
    document.addEventListener('keydown', this.keyHandler, true);
  }

  buildLayout() {
    const p = this.prefs;
    // ---- top bar
    const brand = h('button', { class: 'brand', title: 'Menu' }, h('span', { class: 'logo' }, 'L'), h('span', null, 'LaTeX Lab'), icon('chevronDown', 14));
    brand.onclick = () => menuFromButton(brand, [
      { label: 'All projects', icon: 'home', onClick: () => this.backToStart() },
      { label: 'Go to file…', icon: 'search', hint: `${modKey}+P`, onClick: () => this.quickOpen() },
      '-',
      { label: 'Settings', icon: 'settings', onClick: () => this.openSettings() },
      { label: 'LaTeX setup guide', icon: 'wrench', onClick: () => showSetupGuide({ onChanged: () => this.compile() }) },
      { label: 'Keyboard shortcuts', icon: 'info', onClick: () => this.showShortcuts() },
      '-',
      { label: 'Quit LaTeX Lab', icon: 'x', onClick: () => quitApp(this) },
    ]);
    const layoutBtn = (mode, iconName, title) => h('button', {
      class: `seg ${p.layout === mode ? 'on' : ''}`, title, dataset: { mode },
      onclick: () => this.setLayout(mode),
    }, icon(iconName, 15));
    this.layoutSeg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Layout' },
      layoutBtn('editor', 'editorOnly', 'Editor only'), layoutBtn('split', 'columns', 'Editor & PDF'), layoutBtn('pdf', 'pdfOnly', 'PDF only'));
    this.gitBtn = h('button', { class: 'top-btn', title: 'Git & GitHub sync', onclick: () => this.showPanel('git') }, icon('github', 16), h('span', null, 'GitHub'), h('span', { class: 'badge hidden' }));
    const topbar = h('header', { class: 'topbar' },
      brand,
      h('div', { class: 'project-title', title: this.project.root }, this.project.name),
      h('span', { class: 'spacer' }),
      this.layoutSeg,
      this.gitBtn,
      h('button', { class: 'top-btn', title: 'Settings', onclick: () => this.openSettings() }, icon('settings', 16), h('span', null, 'Settings')));

    // ---- activity bar + sidebar
    const act = (name, iconName, title) => h('button', {
      class: `act ${p.sidebarOpen && p.sidebarPanel === name ? 'on' : ''}`, title, dataset: { panel: name },
      onclick: () => this.togglePanel(name),
    }, icon(iconName, 20));
    this.activity = h('nav', { class: 'activity' }, act('files', 'file', 'Files'), act('search', 'search', `Search (${modKey}+Shift+F)`), act('git', 'git', 'Git & GitHub'));
    this.filesWrap = h('div', { class: 'files-wrap' }, this.tree.el, this.outline.el);
    this.sidebar = h('aside', { class: 'sidebar', style: { width: `${p.sidebarWidth}px` } }, this.filesWrap, this.search.el, this.git.el);
    const sideResizer = h('div', { class: 'resizer', title: 'Drag to resize' });

    // ---- pdf pane
    this.compileBtn = h('button', { class: 'compile-btn', title: `Recompile (${modKey}+S)`, onclick: () => this.compile() },
      h('span', { class: 'compile-icon' }, icon('play', 14)), h('span', { class: 'compile-label' }, 'Recompile'));
    const caret = h('button', { class: 'compile-caret', title: 'Compile options' }, icon('chevronDown', 14));
    caret.onclick = () => menuFromButton(caret, [
      { label: 'Auto compile', icon: this.prefs.autoCompile ? 'check' : null, checked: this.prefs.autoCompile, onClick: () => { this.savePrefs({ autoCompile: !this.prefs.autoCompile }); toast(`Auto compile ${this.prefs.autoCompile ? 'on' : 'off'}`, 'info', 1500); } },
      { label: 'Stop compilation', icon: 'stop', disabled: !this.compiling, onClick: () => api.post('/api/compile/stop') },
      { label: 'Clear cached files & recompile', icon: 'trash', onClick: () => this.compile({ fromScratch: true }) },
      '-',
      { label: 'Compiler settings…', icon: 'settings', onClick: () => this.openSettings() },
    ]);
    this.logsBtn = h('button', { class: 'tool-btn logs-btn', title: 'Logs and errors', onclick: () => this.toggleLogs() },
      icon('logs', 15), h('span', null, 'Logs'), h('span', { class: 'count count-error hidden' }), h('span', { class: 'count count-warning hidden' }));
    this.pageLabel = h('span', { class: 'page-label muted small' }, '–');
    this.zoomSelect = h('select', { class: 'zoom-select', title: 'Zoom', onchange: () => {
      const v = this.zoomSelect.value;
      if (v === 'custom') return;
      this.viewer.setZoom(v === 'fit-width' || v === 'fit-page' ? v : Number(v));
    } },
    h('option', { value: 'fit-width' }, 'Fit width'), h('option', { value: 'fit-page' }, 'Fit page'),
    ['0.5', '0.75', '1', '1.25', '1.5', '2'].map((z) => h('option', { value: z }, `${Number(z) * 100}%`)));
    this.zoomCustom = h('option', { value: 'custom', disabled: true }, '100%');
    this.zoomSelect.append(this.zoomCustom);
    const pdfToolbar = h('div', { class: 'pdf-toolbar' },
      h('div', { class: 'compile-group' }, this.compileBtn, caret),
      this.logsBtn,
      h('span', { class: 'spacer' }),
      h('button', { class: 'tool-btn', title: `Show this spot of the code in the PDF (${modKey}+Alt+J). Double-click the PDF to jump back to the code.`, onclick: () => this.forwardSync() }, icon('arrowRight', 15)),
      this.pageLabel,
      h('button', { class: 'icon-btn', title: 'Zoom out', onclick: () => this.viewer.zoomBy(1 / 1.15) }, icon('minus', 15)),
      this.zoomSelect,
      h('button', { class: 'icon-btn', title: 'Zoom in', onclick: () => this.viewer.zoomBy(1.15) }, icon('plus', 15)),
      h('button', { class: 'icon-btn', title: 'Download PDF', onclick: () => this.viewer.downloadName(`${this.project.name}.pdf`) }, icon('download', 15)));
    this.pdfPane = h('section', { class: 'pdf-pane' }, pdfToolbar, h('div', { class: 'pdf-body' }, this.viewer.el, this.logs.el));
    const pdfResizer = h('div', { class: 'resizer', title: 'Drag to resize' });
    this.center = h('div', { class: 'center' }, this.editors.el, pdfResizer, this.pdfPane);
    const main = h('div', { class: 'main' }, this.activity, this.sidebar, sideResizer, this.center);
    this.root.append(topbar, main);

    this.makeResizer(sideResizer, (dx, start) => {
      const w = Math.max(160, Math.min(600, start + dx));
      this.sidebar.style.width = `${w}px`;
      return w;
    }, () => this.sidebar.offsetWidth, (w) => this.savePrefs({ sidebarWidth: w }));
    this.makeResizer(pdfResizer, (dx, start) => {
      const total = this.center.offsetWidth;
      const w = Math.max(240, Math.min(total - 240, start - dx));
      this.pdfPane.style.flex = `0 0 ${w}px`;
      return w;
    }, () => this.pdfPane.offsetWidth, (w) => this.savePrefs({ pdfWidth: w }));
    if (p.pdfWidth) this.pdfPane.style.flex = `0 0 ${p.pdfWidth}px`;
    this.setLayout(p.layout, false);
    this.showPanel(p.sidebarPanel, p.sidebarOpen);
  }

  makeResizer(el, apply, getStart, done) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const x0 = e.clientX;
      const start = getStart();
      let last = start;
      document.body.classList.add('resizing');
      const move = (ev) => { last = apply(ev.clientX - x0, start); };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        document.body.classList.remove('resizing');
        done(last);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  }

  setLayout(mode, save = true) {
    this.center.dataset.layout = mode;
    for (const b of this.layoutSeg.querySelectorAll('.seg')) b.classList.toggle('on', b.dataset.mode === mode);
    if (save) this.savePrefs({ layout: mode });
    if (mode !== 'editor' && this.viewer && this.viewer.doc) setTimeout(() => this.viewer.relayout(true), 30);
  }

  togglePanel(name) {
    if (this.prefs.sidebarOpen && this.prefs.sidebarPanel === name) this.showPanel(name, false);
    else this.showPanel(name, true);
  }

  showPanel(name, open = true) {
    this.savePrefs({ sidebarPanel: name, sidebarOpen: open });
    this.sidebar.classList.toggle('hidden', !open);
    this.sidebar.nextElementSibling.classList.toggle('hidden', !open);
    this.filesWrap.classList.toggle('hidden', name !== 'files');
    this.search.el.classList.toggle('hidden', name !== 'search');
    this.git.el.classList.toggle('hidden', name !== 'git');
    for (const b of this.activity.querySelectorAll('.act')) b.classList.toggle('on', open && b.dataset.panel === name);
    if (open && name === 'git') this.git.refresh(true);
    if (open && name === 'search') setTimeout(() => this.search.focus(), 0);
  }

  // ======================================================================== data
  async refreshTree() {
    try {
      const { tree, signature } = await api.get('/api/tree');
      this.signature = signature;
      this.tree.setTree(tree);
      this.symbols.files = flattenFiles(tree);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async refreshSymbols() {
    try {
      this.symbols = await api.get('/api/symbols');
    } catch { /* not critical */ }
  }

  refreshSymbolsSoon = debounce(() => this.refreshSymbols(), 1500);
  refreshGitSoon = debounce(() => { if (this.git) this.git.refresh(false); }, 2500);
  autoCompileSoon = debounce(() => { if (this.prefs.autoCompile) this.compile(); }, 1200);
  updateOutlineSoon = debounce(() => this.updateOutline(), 400);

  async reloadSettings() {
    try {
      this.settings = await api.get('/api/settings');
      this.tree.render();
    } catch { /* ignore */ }
  }

  async setMain(path) {
    try {
      this.settings = await api.put('/api/settings', { mainFile: path });
      this.tree.render();
      toast(`${path} is now the main document`, 'success', 2000);
      this.compile();
    } catch (err) { toast(err.message, 'error'); }
  }

  updateOutline() {
    if (!this.outline || !this.editors) return;
    const doc = this.editors.activeText();
    const cur = this.editors.cursor();
    this.outline.render(doc ? buildOutline(doc) : [], cur && cur.line);
  }

  async checkExternal(force = false) {
    if (!this.editors || this.checking) return;
    this.checking = true;
    try {
      const { signature } = await api.get('/api/signature');
      if (force || signature !== this.signature) {
        await this.refreshTree();
        const { versions } = await api.post('/api/versions', { paths: [...this.editors.docs.keys()] });
        await this.editors.checkVersions(versions);
        this.refreshSymbolsSoon();
        this.refreshGitSoon();
      }
    } catch { /* server gone? the next action will report it */ } finally {
      this.checking = false;
    }
  }

  updateGitBadge(st) {
    const badge = this.gitBtn.querySelector('.badge');
    if (!st || !st.repo) { badge.classList.add('hidden'); return; }
    const n = (st.changes || []).length;
    const parts = [];
    if (n) parts.push(`${n}`);
    if (st.ahead) parts.push(`↑${st.ahead}`);
    if (st.behind) parts.push(`↓${st.behind}`);
    badge.textContent = parts.join(' ');
    badge.classList.toggle('hidden', !parts.length);
    badge.title = `${n} changed file(s), ${st.ahead || 0} commit(s) to push, ${st.behind || 0} to pull`;
  }

  // ======================================================================== compile & PDF
  async compile({ fromScratch = false } = {}) {
    if (!this.editors) return;
    if (this.compiling) { this.compileQueued = true; return; }
    this.compiling = true;
    this.setCompiling(true);
    try {
      await this.editors.saveAll();
      if (fromScratch) await api.post('/api/compile/clear');
      const r = await api.post('/api/compile');
      if (!this.editors) return;
      this.lastResult = r;
      this.logs.setResult(r);
      this.editors.setDiagnostics(r.entries || []);
      this.updateLogBadges(r);
      if (r.pdf) await this.loadPdf();
      if (r.status === 'no-engine') {
        this.toggleLogs(true);
        showSetupGuide({ onChanged: () => this.compile() });
      } else if (!r.pdf && r.status !== 'stopped') {
        this.toggleLogs(true);
      } else if (r.status === 'success' && this.logsOpen && !(r.counts.warning + r.counts.typesetting)) {
        this.toggleLogs(false);
      }
      if (r.status === 'timeout') toast('The compile took longer than the timeout and was stopped. You can raise the limit in Settings.', 'warning', 8000);
    } catch (err) {
      toast(err.message, 'error', 8000);
    } finally {
      this.compiling = false;
      if (this.editors) this.setCompiling(false);
      if (this.compileQueued) { this.compileQueued = false; this.compile(); }
    }
  }

  setCompiling(on) {
    this.compileBtn.classList.toggle('busy', on);
    clear(this.compileBtn.querySelector('.compile-icon')).append(icon(on ? 'refresh' : 'play', 14, on ? 'spin' : ''));
    this.compileBtn.querySelector('.compile-label').textContent = on ? 'Compiling…' : 'Recompile';
  }

  updateLogBadges(r) {
    const err = this.logsBtn.querySelector('.count-error');
    const warn = this.logsBtn.querySelector('.count-warning');
    const c = r.counts || {};
    err.textContent = c.error || '';
    err.classList.toggle('hidden', !c.error);
    warn.textContent = (c.warning || 0) + (c.typesetting || 0) || '';
    warn.classList.toggle('hidden', !((c.warning || 0) + (c.typesetting || 0)));
    this.compileBtn.classList.toggle('has-errors', !!c.error);
  }

  toggleLogs(force) {
    this.logsOpen = force === undefined ? !this.logsOpen : force;
    this.logs.el.classList.toggle('hidden', !this.logsOpen);
    this.logsBtn.classList.toggle('on', this.logsOpen);
    if (this.logsOpen) this.logs.render();
  }

  async loadPdf(quiet = false) {
    try {
      const res = await api.raw('/api/pdf', { t: Date.now() });
      const buf = await res.arrayBuffer();
      if (this.viewer) await this.viewer.load(buf);
      return true;
    } catch (err) {
      if (!quiet) toast(`Couldn't show the PDF: ${err.message}`, 'error');
      return false;
    }
  }

  async forwardSync() {
    const cur = this.editors.cursor();
    if (!cur) return;
    if (this.prefs.layout === 'editor') this.setLayout('split');
    try {
      const { result } = await api.get('/api/synctex/forward', { file: cur.path, line: cur.line });
      if (!result) { toast('No PDF location for this line (compile first, or the line produces no output).', 'info', 3000); return; }
      if (this.logsOpen) this.toggleLogs(false);
      this.viewer.showLocation(result.page, result.y, result.rects);
    } catch (err) { toast(err.message, 'error'); }
  }

  async inverseSync(page, x, y) {
    try {
      const { result } = await api.get('/api/synctex/inverse', { page, x: x.toFixed(2), y: y.toFixed(2) });
      if (!result || !result.file) { toast('Could not find the source for that spot.', 'info', 2500); return; }
      if (this.prefs.layout === 'pdf') this.setLayout('split');
      await this.editors.open(result.file, { line: result.line });
    } catch (err) { toast(err.message, 'error'); }
  }

  // ======================================================================== misc UI
  openSettings() {
    showSettings({
      settings: this.settings,
      prefs: this.prefs,
      onSettings: (s) => { this.settings = s; this.tree.render(); },
      onPrefs: (changes) => this.savePrefs(changes),
      onSetup: () => showSetupGuide({ onChanged: () => this.compile() }),
    });
  }

  quickOpen() {
    showQuickOpen(this.symbols.files || [], (path) => this.editors.open(path));
  }

  showShortcuts() {
    const rows = [
      [`${modKey}+S`, 'Save and compile'], [`${modKey}+Enter`, 'Compile'], [`${modKey}+P`, 'Go to file'],
      [`${modKey}+Shift+F`, 'Search in all files'], [`${modKey}+F`, 'Find / replace in this file'], [`${modKey}+B / ${modKey}+I`, 'Bold / italic'],
      [`${modKey}+/`, 'Comment / uncomment lines'], [`${modKey}+Alt+J`, 'Show the cursor position in the PDF'], ['Double-click the PDF', 'Jump to that spot in the code'],
      [`${modKey}+Space`, 'Show completions'], [`${modKey}+Z / ${modKey}+Shift+Z`, 'Undo / redo'],
    ];
    modal({
      title: 'Keyboard shortcuts',
      body: h('table', { class: 'shortcuts' }, rows.map(([k, d]) => h('tr', null, h('td', null, h('kbd', null, k)), h('td', null, d)))),
      actions: [{ label: 'Close', primary: true }],
    });
  }

  async backToStart() {
    if (this.editors) await this.editors.saveAll();
    const st = await api.post('/api/project/close');
    this.showStart(st);
  }

  onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if ((key === 's' && !e.shiftKey) || (key === 'enter' && !e.shiftKey && !e.altKey)) {
      // Handled here (capture phase) for the whole app, including inside the editor.
      e.preventDefault();
      e.stopPropagation();
      this.compile();
    } else if (key === 'p' && !e.shiftKey) {
      e.preventDefault();
      this.quickOpen();
    } else if (key === 'f' && e.shiftKey) {
      e.preventDefault();
      const sel = window.getSelection ? String(window.getSelection()) : '';
      this.showPanel('search', true);
      setTimeout(() => this.search.focus(sel.length < 80 ? sel : ''), 0);
    }
  }
}

export async function quitApp(app) {
  if (app && app.editors) await app.editors.saveAll();
  try { await api.post('/api/quit'); } catch { /* already gone */ }
  if (app) app.teardown();
  document.title = 'LaTeX Lab (stopped)';
  clear(document.getElementById('app')).append(h('div', { class: 'fatal' },
    h('h1', null, 'LaTeX Lab has stopped'),
    h('p', null, 'All your files are saved. You can close this window.'),
    h('p', { class: 'muted' }, 'To start again, use the LaTeX Lab shortcut or run  latexlab  in a terminal.')));
}

window.addEventListener('beforeunload', (e) => {
  if (window.latexlab && window.latexlab.editors && window.latexlab.editors.hasUnsaved()) {
    window.latexlab.editors.saveAll();
    e.preventDefault();
    e.returnValue = '';
  }
});

// Heartbeat: lets a windowless LaTeX Lab know a window is still open (runs even when minimised).
setInterval(() => { api.get('/api/ping').catch(() => {}); }, 60_000);

const app = new LatexLab(document.getElementById('app'));
window.latexlab = app;
app.start();
