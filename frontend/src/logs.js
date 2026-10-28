// Compile log pane (Overleaf-style): errors, warnings, bad boxes, raw log.

import { clear, h, icon } from './dom.js';

const LEVEL_LABEL = { error: 'Error', warning: 'Warning', typesetting: 'Bad box' };

export class LogsView {
  constructor({ onJump, onRecompileFromScratch, onSetup }) {
    this.cb = { onJump, onRecompileFromScratch, onSetup };
    this.result = null;
    this.filter = 'all';
    this.showRaw = false;
    this.el = h('div', { class: 'logs hidden' });
  }

  setResult(result) {
    this.result = result;
    this.render();
  }

  render() {
    clear(this.el);
    const r = this.result;
    if (!r) {
      this.el.append(h('p', { class: 'muted pad' }, 'No compile yet.'));
      return;
    }
    const counts = r.counts || { error: 0, warning: 0, typesetting: 0 };
    const tab = (key, label, n) => h('button', { class: `log-filter ${this.filter === key ? 'on' : ''}`, onclick: () => { this.filter = key; this.showRaw = false; this.render(); } },
      label, n !== undefined ? h('span', { class: `count count-${key}` }, n) : null);
    const summary = r.status === 'success' ? 'Compiled successfully' : r.status === 'timeout' ? 'Compile timed out'
      : r.status === 'stopped' ? 'Compile stopped' : r.status === 'no-engine' ? 'No LaTeX installation found' : 'Compiled with errors';
    this.el.append(h('div', { class: 'logs-header' },
      h('div', { class: 'logs-summary' },
        icon(r.status === 'success' ? 'check' : 'alert', 16, r.status === 'success' ? 'ok' : 'bad'),
        h('strong', null, summary),
        h('span', { class: 'muted small' }, [r.engineDescription, r.durationMs ? `${(r.durationMs / 1000).toFixed(1)} s` : '', r.pages ? `${r.pages} pages` : ''].filter(Boolean).join(' · '))),
      h('div', { class: 'logs-filters' },
        tab('all', 'All', undefined), tab('error', 'Errors', counts.error), tab('warning', 'Warnings', counts.warning), tab('typesetting', 'Bad boxes', counts.typesetting),
        h('span', { class: 'spacer' }),
        h('button', { class: `log-filter ${this.showRaw ? 'on' : ''}`, onclick: () => { this.showRaw = !this.showRaw; this.render(); } }, icon('terminal', 14), 'Raw log'))));

    if (r.status === 'no-engine') {
      this.el.append(h('div', { class: 'log-entry level-error' },
        h('div', { class: 'log-title' }, r.entries[0] ? r.entries[0].message : 'No TeX found.'),
        h('button', { class: 'btn btn-primary btn-sm', onclick: () => this.cb.onSetup() }, icon('wrench', 14), 'Open the setup guide')));
      return;
    }

    if (this.showRaw) {
      this.el.append(h('pre', { class: 'raw-log' }, (r.log || '(no .log file was written)') + (r.output ? `\n\n===== compiler output =====\n${r.output}` : '')));
      return;
    }

    const entries = (r.entries || []).filter((e) => this.filter === 'all' || e.level === this.filter);
    if (!entries.length) {
      this.el.append(h('p', { class: 'muted pad' }, r.status === 'success' ? 'No problems found.' : 'Nothing in this category.'));
    }
    for (const e of entries) {
      const where = e.file ? `${e.file}${e.line ? `, line ${e.line}` : ''}` : e.external ? `in ${e.external.split(/[\\/]/).pop()}` : '';
      const card = h('div', { class: `log-entry level-${e.level}` },
        h('div', { class: 'log-head' },
          h('span', { class: 'log-level' }, LEVEL_LABEL[e.level] || e.level),
          where ? h('button', { class: 'log-where', disabled: !e.file, title: e.file ? 'Go to this line' : e.external || '', onclick: () => e.file && this.cb.onJump(e.file, e.line || 1) }, where) : null),
        h('div', { class: 'log-title' }, e.message),
        e.hint ? h('div', { class: 'log-hint' }, icon('info', 14), h('span', null, e.hint)) : null,
        e.content ? h('details', { class: 'log-details' }, h('summary', null, 'Details'), h('pre', null, e.content)) : null);
      this.el.append(card);
    }
    this.el.append(h('div', { class: 'logs-footer' },
      h('button', { class: 'btn btn-sm', onclick: () => this.cb.onRecompileFromScratch() }, icon('trash', 14), 'Clear cached files & recompile')));
  }
}
