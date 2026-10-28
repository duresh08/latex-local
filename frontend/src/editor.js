// The code editor: one CodeMirror view, one EditorState per open file (so each tab keeps its undo history).

import { Annotation, Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration, EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, lintKeymap, setDiagnostics } from '@codemirror/lint';
import { oneDark } from '@codemirror/theme-one-dark';

import { api } from './api.js';
import { clear, fileIcon, formatBytes, h, icon, toast } from './dom.js';
import { latexCompletionSource, latexLanguage, latexLanguageData } from './latex.js';

const External = Annotation.define();
const flashEffect = StateEffect.define();
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        deco = e.value === null ? Decoration.none : Decoration.set([Decoration.line({ class: 'cm-flash-line' }).range(e.value)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const MONO = '"Cascadia Code", "Cascadia Mono", Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace';

function wrapWith(before, after) {
  return (view) => {
    view.dispatch(view.state.changeByRange((range) => {
      if (range.empty) {
        return { changes: { from: range.from, insert: before + after }, range: EditorSelection.cursor(range.from + before.length) };
      }
      return {
        changes: [{ from: range.from, insert: before }, { from: range.to, insert: after }],
        range: EditorSelection.range(range.from + before.length, range.to + before.length),
      };
    }));
    return true;
  };
}

export class Editors {
  constructor({ getSymbols, prefs, onActiveChange, onSaved, onCompile, onForwardSync, onDocChange, onTabsChange }) {
    this.getSymbols = getSymbols;
    this.prefs = prefs;
    this.cb = { onActiveChange, onSaved, onCompile, onForwardSync, onDocChange, onTabsChange };
    this.docs = new Map();
    this.order = [];
    this.active = null;
    this.diagnostics = new Map();
    this.blobUrls = new Map();

    this.themeC = new Compartment();
    this.fontC = new Compartment();
    this.wrapC = new Compartment();
    this.spellC = new Compartment();

    this.tabsEl = h('div', { class: 'tabs', role: 'tablist' });
    this.bannerEl = h('div', { class: 'banner hidden' });
    this.hostEl = h('div', { class: 'editor-host' });
    this.binaryEl = h('div', { class: 'binary-host hidden' });
    this.emptyEl = h('div', { class: 'editor-empty' },
      h('div', null, icon('tex', 36)),
      h('p', null, 'Open a file from the file tree on the left.'),
      h('p', { class: 'muted' }, 'Ctrl+P: quick open · Ctrl+S: save & compile · Ctrl+Enter: compile'));
    this.statusEl = h('div', { class: 'statusbar' });
    this.el = h('section', { class: 'editor-pane' }, this.tabsEl, this.bannerEl, this.hostEl, this.binaryEl, this.emptyEl, this.statusEl);

    this.view = new EditorView({ parent: this.hostEl, state: EditorState.create({ doc: '', extensions: this.extensions() }) });
    this.showPane('empty');
  }

  // ------------------------------------------------------------ setup
  themeExt() {
    return this.prefs.theme === 'dark' ? oneDark : [];
  }

  fontExt() {
    return EditorView.theme({
      '&': { fontSize: `${this.prefs.fontSize}px` },
      '.cm-content, .cm-gutters': { fontFamily: MONO },
    });
  }

  extensions() {
    const self = this;
    return [
      Prec.high(keymap.of([
        { key: 'Mod-b', preventDefault: true, run: wrapWith('\\textbf{', '}') },
        { key: 'Mod-i', preventDefault: true, run: wrapWith('\\textit{', '}') },
        { key: 'Mod-Alt-j', preventDefault: true, run: () => { self.cb.onForwardSync(); return true; } },
        { key: 'Mod-/', run: toggleComment },
      ])),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ override: [latexCompletionSource(() => self.getSymbols())], icons: true, activateOnTyping: true, maxRenderedOptions: 80 }),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      lintGutter(),
      flashField,
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
      latexLanguage,
      latexLanguageData,
      this.themeC.of(this.themeExt()),
      this.fontC.of(this.fontExt()),
      this.wrapC.of(this.prefs.lineWrapping ? EditorView.lineWrapping : []),
      this.spellC.of(EditorView.contentAttributes.of({ spellcheck: this.prefs.spellcheck ? 'true' : 'false', autocorrect: 'off', autocapitalize: 'off' })),
      EditorView.updateListener.of((u) => self.onUpdate(u)),
    ];
  }

  applyPrefs(prefs) {
    this.prefs = prefs;
    const effects = [
      this.themeC.reconfigure(this.themeExt()),
      this.fontC.reconfigure(this.fontExt()),
      this.wrapC.reconfigure(prefs.lineWrapping ? EditorView.lineWrapping : []),
      this.spellC.reconfigure(EditorView.contentAttributes.of({ spellcheck: prefs.spellcheck ? 'true' : 'false', autocorrect: 'off', autocapitalize: 'off' })),
    ];
    for (const doc of this.docs.values()) {
      if (doc.binary) continue;
      if (doc.path === this.active) this.view.dispatch({ effects });
      else doc.state = doc.state.update({ effects }).state;
    }
  }

  onUpdate(u) {
    const doc = this.docs.get(this.active);
    if (!doc || doc.binary) return;
    doc.state = u.state;
    if (u.docChanged) {
      const external = u.transactions.some((t) => t.annotation(External));
      if (!external) this.scheduleSave(doc);
      const dirty = this.isDirty(doc);
      if (dirty !== doc.dirtyShown) {
        doc.dirtyShown = dirty;
        this.renderTabs();
      }
      this.cb.onDocChange && this.cb.onDocChange(doc.path, u.state.doc);
    }
    if (u.selectionSet || u.docChanged) this.renderStatus();
  }

  // ------------------------------------------------------------ tabs
  showPane(which) {
    this.hostEl.classList.toggle('hidden', which !== 'text');
    this.binaryEl.classList.toggle('hidden', which !== 'binary');
    this.emptyEl.classList.toggle('hidden', which !== 'empty');
  }

  isDirty(doc) {
    return !doc.binary && !doc.state.doc.eq(doc.saved);
  }

  renderTabs() {
    for (const d of this.docs.values()) d.dirtyShown = this.isDirty(d);
    clear(this.tabsEl);
    for (const path of this.order) {
      const doc = this.docs.get(path);
      const name = path.split('/').pop();
      const tab = h('div', {
        class: `tab ${path === this.active ? 'active' : ''} ${doc.conflict ? 'conflict' : ''}`,
        role: 'tab', title: path, 'aria-selected': path === this.active ? 'true' : 'false',
        onclick: () => this.activate(path),
        onauxclick: (e) => { if (e.button === 1) this.close(path); },
      }, fileIcon(path), h('span', { class: 'tab-name' }, name),
      this.isDirty(doc) ? h('span', { class: 'dirty-dot', title: 'Unsaved changes' }) : null,
      h('button', { class: 'tab-close', title: 'Close', onclick: (e) => { e.stopPropagation(); this.close(path); } }, icon('x', 13)));
      this.tabsEl.append(tab);
    }
    const activeTab = this.tabsEl.querySelector('.tab.active');
    if (activeTab) activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.cb.onTabsChange && this.cb.onTabsChange();
  }

  renderStatus() {
    clear(this.statusEl);
    const doc = this.docs.get(this.active);
    if (!doc) return;
    if (doc.binary) {
      this.statusEl.append(h('span', null, `${doc.path} · ${formatBytes(doc.size || 0)}`));
      return;
    }
    const st = doc.state;
    const head = st.selection.main.head;
    const line = st.doc.lineAt(head);
    const saving = doc.saving ? 'Saving…' : this.isDirty(doc) ? 'Unsaved' : 'Saved';
    this.statusEl.append(...[
      h('span', null, `Ln ${line.number}, Col ${head - line.from + 1}`),
      st.selection.main.empty ? null : h('span', null, `${Math.abs(st.selection.main.to - st.selection.main.from)} selected`),
      h('span', { class: 'spacer' }),
      h('span', { class: `save-state ${saving === 'Unsaved' ? 'unsaved' : ''}` }, saving),
      h('span', null, doc.encoding === 'latin-1' ? 'Latin-1' : 'UTF-8'),
      h('span', null, doc.eol === 'crlf' ? 'CRLF' : 'LF'),
    ].filter(Boolean));
  }

  async open(path, { line, col, length, focus = true } = {}) {
    let doc = this.docs.get(path);
    if (!doc) {
      let data;
      try {
        data = await api.get('/api/file', { path });
      } catch (err) {
        toast(`Couldn't open ${path}: ${err.message}`, 'error');
        return false;
      }
      if (data.binary) {
        doc = { path, binary: true, size: data.size, version: data.version };
      } else {
        const state = EditorState.create({ doc: data.content, extensions: this.extensions() });
        doc = { path, binary: false, state, saved: state.doc, version: data.version, eol: data.eol, encoding: data.encoding, conflict: null, scroll: null };
      }
      this.docs.set(path, doc);
      this.order.push(path);
      this.applyDiagnostics(doc);
    }
    await this.activate(path);
    if (line && !doc.binary) this.gotoLine(line, col || 0, { length, focus });
    else if (focus && !doc.binary) this.view.focus();
    return true;
  }

  async activate(path) {
    const doc = this.docs.get(path);
    if (!doc) return;
    const prev = this.docs.get(this.active);
    if (prev && !prev.binary && prev.path !== path) {
      prev.state = this.view.state;
      prev.scroll = { top: this.view.scrollDOM.scrollTop, left: this.view.scrollDOM.scrollLeft };
    }
    this.active = path;
    if (doc.binary) {
      this.showPane('binary');
      await this.renderBinary(doc);
    } else {
      this.showPane('text');
      if (this.view.state !== doc.state) this.view.setState(doc.state);
      const scroll = doc.scroll;
      if (scroll) requestAnimationFrame(() => { this.view.scrollDOM.scrollTop = scroll.top; this.view.scrollDOM.scrollLeft = scroll.left; });
    }
    this.renderTabs();
    this.renderStatus();
    this.renderBanner();
    this.cb.onActiveChange && this.cb.onActiveChange(path);
  }

  async renderBinary(doc) {
    clear(this.binaryEl);
    const ext = doc.path.split('.').pop().toLowerCase();
    const viewable = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'pdf'].includes(ext);
    if (!viewable) {
      this.binaryEl.append(h('div', { class: 'binary-msg' }, icon('file', 32), h('p', null, `${doc.path}`), h('p', { class: 'muted' }, `Binary file · ${formatBytes(doc.size || 0)}`)));
      return;
    }
    let url = this.blobUrls.get(doc.path);
    if (!url || url.version !== doc.version) {
      try {
        const res = await api.raw('/api/raw', { path: doc.path });
        const blob = new Blob([await res.arrayBuffer()], { type: res.headers.get('Content-Type') || '' });
        if (url) URL.revokeObjectURL(url.url);
        url = { url: URL.createObjectURL(blob), version: doc.version };
        this.blobUrls.set(doc.path, url);
      } catch (err) {
        this.binaryEl.append(h('p', { class: 'binary-msg' }, `Couldn't load: ${err.message}`));
        return;
      }
    }
    if (this.active !== doc.path) return;
    this.binaryEl.append(ext === 'pdf'
      ? h('iframe', { class: 'binary-pdf', src: url.url, title: doc.path })
      : h('div', { class: 'binary-img-wrap' }, h('img', { class: 'binary-img', src: url.url, alt: doc.path }),
        h('p', { class: 'muted' }, `${doc.path} · ${formatBytes(doc.size || 0)}`)));
  }

  async close(path) {
    const doc = this.docs.get(path);
    if (!doc) return;
    if (this.isDirty(doc)) await this.save(path);
    clearTimeout(doc.saveTimer);
    this.docs.delete(path);
    const idx = this.order.indexOf(path);
    this.order.splice(idx, 1);
    const blob = this.blobUrls.get(path);
    if (blob) { URL.revokeObjectURL(blob.url); this.blobUrls.delete(path); }
    if (this.active === path) {
      this.active = null;
      const next = this.order[Math.min(idx, this.order.length - 1)];
      if (next) await this.activate(next);
      else {
        this.view.setState(EditorState.create({ doc: '', extensions: this.extensions() }));
        this.showPane('empty');
        this.renderBanner();
        this.cb.onActiveChange && this.cb.onActiveChange(null);
      }
    }
    this.renderTabs();
    this.renderStatus();
  }

  closeAll() {
    for (const doc of this.docs.values()) clearTimeout(doc.saveTimer);
    this.docs.clear();
    this.order = [];
    this.active = null;
    this.view.setState(EditorState.create({ doc: '', extensions: this.extensions() }));
    this.showPane('empty');
    this.renderTabs();
  }

  /** A file or folder was renamed in the tree: keep its tabs open under the new path. */
  renamed(from, to) {
    const moves = [];
    for (const path of this.order) {
      if (path === from || path.startsWith(`${from}/`)) moves.push([path, to + path.slice(from.length)]);
    }
    for (const [a, b] of moves) {
      const doc = this.docs.get(a);
      this.docs.delete(a);
      doc.path = b;
      this.docs.set(b, doc);
      this.order[this.order.indexOf(a)] = b;
      if (this.active === a) this.active = b;
    }
    if (moves.length) { this.renderTabs(); this.cb.onActiveChange && this.cb.onActiveChange(this.active); }
  }

  deleted(path) {
    for (const p of [...this.order]) {
      if (p === path || p.startsWith(`${path}/`)) {
        const doc = this.docs.get(p);
        doc.saved = doc.binary ? null : doc.state.doc; // don't try to save it back
        this.close(p);
      }
    }
  }

  // ------------------------------------------------------------ saving
  scheduleSave(doc) {
    clearTimeout(doc.saveTimer);
    doc.saveTimer = setTimeout(() => this.save(doc.path), 700);
  }

  async save(path, { force = false } = {}) {
    const doc = this.docs.get(path);
    if (!doc || doc.binary) return true;
    clearTimeout(doc.saveTimer);
    if (doc.saving) {
      await doc.saving;
      if (!this.docs.has(path)) return true;
    }
    if (doc.conflict && !force) return false;
    const text = doc.state.doc;
    if (!force && text.eq(doc.saved)) return true;
    doc.saving = (async () => {
      try {
        const res = await api.put('/api/file', { path, content: text.toString(), baseVersion: doc.version, force });
        doc.version = res.version;
        doc.saved = text;
        doc.conflict = null;
        this.cb.onSaved && this.cb.onSaved(path);
        return true;
      } catch (err) {
        if (err.status === 409) {
          doc.conflict = { version: err.data.version };
          this.renderBanner();
        } else {
          toast(`Couldn't save ${path}: ${err.message}`, 'error', 8000);
        }
        return false;
      } finally {
        doc.saving = null;
        this.renderTabs();
        this.renderStatus();
      }
    })();
    this.renderStatus();
    return doc.saving;
  }

  async saveAll() {
    const results = await Promise.all([...this.docs.keys()].map((p) => this.save(p)));
    return results.every(Boolean);
  }

  hasUnsaved() {
    return [...this.docs.values()].some((d) => this.isDirty(d));
  }

  // ------------------------------------------------------------ external changes
  async checkVersions(versions) {
    for (const [path, version] of Object.entries(versions)) {
      const doc = this.docs.get(path);
      if (!doc || doc.saving || doc.version === version) continue;
      if (version === null) {
        if (!this.isDirty(doc)) this.deleted(path);
        continue;
      }
      if (doc.binary) {
        doc.version = version;
        if (this.active === path) this.renderBinary(doc);
      } else if (this.isDirty(doc)) {
        doc.conflict = { version };
        this.renderBanner();
        this.renderTabs();
      } else {
        await this.reload(path);
      }
    }
  }

  async reload(path) {
    const doc = this.docs.get(path);
    if (!doc || doc.binary) return;
    const data = await api.get('/api/file', { path });
    const old = doc.state.doc.toString();
    const next = data.content;
    // Replace only the part that changed, so the cursor and scroll position survive.
    let start = 0;
    while (start < old.length && start < next.length && old[start] === next[start]) start++;
    let endOld = old.length;
    let endNew = next.length;
    while (endOld > start && endNew > start && old[endOld - 1] === next[endNew - 1]) { endOld--; endNew--; }
    const spec = { changes: { from: start, to: endOld, insert: next.slice(start, endNew) }, annotations: External.of(true) };
    if (this.active === path) this.view.dispatch(spec);
    else doc.state = doc.state.update(spec).state;
    doc.saved = doc.state.doc;
    doc.version = data.version;
    doc.eol = data.eol;
    doc.conflict = null;
    this.renderBanner();
    this.renderTabs();
    this.renderStatus();
  }

  renderBanner() {
    clear(this.bannerEl);
    const doc = this.docs.get(this.active);
    if (!doc || !doc.conflict) {
      this.bannerEl.classList.add('hidden');
      return;
    }
    this.bannerEl.classList.remove('hidden');
    this.bannerEl.append(
      icon('alert', 16),
      h('span', null, `${doc.path} was changed outside LaTeX Lab (for example by a git pull) while you had unsaved edits.`),
      h('button', { class: 'btn btn-sm', onclick: () => this.reload(doc.path) }, 'Load the version on disk'),
      h('button', { class: 'btn btn-sm', onclick: () => this.save(doc.path, { force: true }) }, 'Keep mine (overwrite)'),
    );
  }

  // ------------------------------------------------------------ navigation
  gotoLine(line, col = 0, { length = 0, focus = true, flash = true } = {}) {
    const st = this.view.state;
    const ln = st.doc.line(Math.max(1, Math.min(line, st.doc.lines)));
    const pos = ln.from + Math.min(col, ln.length);
    this.view.dispatch({
      selection: length ? EditorSelection.range(pos, Math.min(pos + length, ln.to)) : EditorSelection.cursor(pos),
      effects: [EditorView.scrollIntoView(pos, { y: 'center' }), ...(flash ? [flashEffect.of(ln.from)] : [])],
    });
    if (flash) {
      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => {
        if (this.docs.get(this.active) && !this.docs.get(this.active).binary) this.view.dispatch({ effects: flashEffect.of(null) });
      }, 1400);
    }
    if (focus) this.view.focus();
  }

  cursor() {
    const doc = this.docs.get(this.active);
    if (!doc || doc.binary) return null;
    const st = this.view.state;
    const head = st.selection.main.head;
    const line = st.doc.lineAt(head);
    return { path: doc.path, line: line.number, col: head - line.from };
  }

  activeText() {
    const doc = this.docs.get(this.active);
    return doc && !doc.binary ? this.view.state.doc : null;
  }

  insertText(text) {
    const doc = this.docs.get(this.active);
    if (!doc || doc.binary) return;
    this.view.dispatch(this.view.state.replaceSelection(text));
    this.view.focus();
  }

  // ------------------------------------------------------------ diagnostics
  setDiagnostics(entries) {
    this.diagnostics = new Map();
    for (const e of entries) {
      if (!e.file || !e.line) continue;
      if (!this.diagnostics.has(e.file)) this.diagnostics.set(e.file, []);
      this.diagnostics.get(e.file).push(e);
    }
    for (const doc of this.docs.values()) this.applyDiagnostics(doc);
  }

  applyDiagnostics(doc) {
    if (doc.binary) return;
    const st = doc.path === this.active ? this.view.state : doc.state;
    const list = (this.diagnostics.get(doc.path) || []).map((e) => {
      const line = st.doc.line(Math.max(1, Math.min(e.line, st.doc.lines)));
      return {
        from: line.from, to: line.to,
        severity: e.level === 'error' ? 'error' : e.level === 'warning' ? 'warning' : 'info',
        message: e.hint ? `${e.message}\n\n${e.hint}` : e.message,
        source: 'LaTeX',
      };
    });
    const spec = setDiagnostics(st, list);
    if (doc.path === this.active) this.view.dispatch(spec);
    else doc.state = st.update(spec).state;
  }
}
