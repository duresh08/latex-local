// Sidebar panels: project-wide search and Git/GitHub sync.

import { api } from './api.js';
import { clear, confirmDialog, debounce, h, icon, modal, timeAgo, toast } from './dom.js';

export class SearchPanel {
  constructor({ onOpen }) {
    this.onOpen = onOpen;
    this.opts = { case: false, regex: false };
    this.input = h('input', { class: 'input', type: 'search', placeholder: 'Search all files…', spellcheck: false });
    const toggle = (key, label, title) => {
      const b = h('button', { class: 'toggle-btn', title, 'aria-pressed': 'false', onclick: () => {
        this.opts[key] = !this.opts[key];
        b.classList.toggle('on', this.opts[key]);
        b.setAttribute('aria-pressed', String(this.opts[key]));
        this.run();
      } }, label);
      return b;
    };
    this.resultsEl = h('div', { class: 'search-results' });
    this.el = h('div', { class: 'panel search-panel' },
      h('div', { class: 'panel-header' }, h('span', { class: 'panel-title' }, 'Search')),
      h('div', { class: 'search-box' }, this.input, toggle('case', 'Aa', 'Match case'), toggle('regex', '.*', 'Regular expression')),
      this.resultsEl);
    this.input.addEventListener('input', debounce(() => this.run(), 250));
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.run(); });
  }

  focus(text) {
    if (text) this.input.value = text;
    this.input.focus();
    this.input.select();
    if (text) this.run();
  }

  async run() {
    const q = this.input.value;
    clear(this.resultsEl);
    if (!q) return;
    let data;
    try {
      data = await api.get('/api/search', { q, regex: this.opts.regex ? '1' : '0', case: this.opts.case ? '1' : '0' });
    } catch (err) {
      this.resultsEl.append(h('p', { class: 'muted pad' }, err.message));
      return;
    }
    if (q !== this.input.value) return;
    if (!data.results.length) {
      this.resultsEl.append(h('p', { class: 'muted pad' }, 'No results.'));
      return;
    }
    const byFile = new Map();
    for (const r of data.results) {
      if (!byFile.has(r.path)) byFile.set(r.path, []);
      byFile.get(r.path).push(r);
    }
    this.resultsEl.append(h('p', { class: 'muted pad small' }, `${data.results.length}${data.truncated ? '+' : ''} matches in ${byFile.size} files`));
    for (const [path, rows] of byFile) {
      this.resultsEl.append(h('div', { class: 'search-file' }, path));
      for (const r of rows) {
        const start = Math.max(0, r.col - 30);
        const pre = (start > 0 ? '…' : '') + r.text.slice(start, r.col);
        this.resultsEl.append(h('button', {
          class: 'search-hit', title: `${path}:${r.line}`,
          onclick: () => this.onOpen(path, r.line, r.col, r.len),
        }, h('span', { class: 'hit-line' }, r.line), h('span', null, pre, h('mark', null, r.text.slice(r.col, r.col + r.len)), r.text.slice(r.col + r.len, r.col + r.len + 80))));
      }
    }
  }
}

const STATUS_LABEL = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', new: 'U', conflict: '!' };

export class GitPanel {
  constructor({ beforeOp, afterOp, onOpen, onStatus }) {
    this.cb = { beforeOp, afterOp, onOpen, onStatus };
    this.status = null;
    this.busy = false;
    this.bodyEl = h('div', { class: 'git-body' });
    this.el = h('div', { class: 'panel git-panel' },
      h('div', { class: 'panel-header' }, h('span', { class: 'panel-title' }, 'Git & GitHub'), h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn', title: 'Refresh (checks GitHub for new commits)', onclick: () => this.refresh(true) }, icon('refresh', 16))),
      this.bodyEl);
  }

  async refresh(fetch = false) {
    // Local status is instant; checking GitHub can be slow (or impossible offline), so it comes second.
    await this.load(false);
    if (fetch && this.status && this.status.repo && this.status.remote && !this.busy) {
      await this.load(true);
      if (this.status.fetchError && this.status.fetchError.kind === 'offline') toast('Offline: showing local state only.', 'info', 2500);
    }
    return this.status;
  }

  async load(fetch) {
    try {
      this.status = await api.get('/api/git/status', { fetch: fetch ? '1' : '0' });
    } catch (err) {
      this.status = { error: err.message };
    }
    this.render();
    this.cb.onStatus && this.cb.onStatus(this.status);
    if (this.status && this.status.repo) this.loadLog();
  }

  async loadLog() {
    try {
      const { log } = await api.get('/api/git/log');
      const el = this.bodyEl.querySelector('.git-log');
      if (!el) return;
      clear(el);
      if (!log.length) el.append(h('p', { class: 'muted small' }, 'No commits yet.'));
      for (const c of log.slice(0, 15)) {
        el.append(h('div', { class: 'commit', title: `${c.hash}\n${c.author}` },
          h('span', { class: 'commit-subject' }, c.subject),
          h('span', { class: 'commit-meta' }, `${c.short} · ${c.author} · ${timeAgo(c.time)}`)));
      }
    } catch { /* ignore */ }
  }

  async op(label, fn) {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      if (this.cb.beforeOp) await this.cb.beforeOp();
      const res = await fn();
      if (res && res.message) toast(res.message, 'success', 4500);
      return res;
    } catch (err) {
      const kind = err.data && err.data.kind;
      toast(err.message, kind === 'offline' ? 'warning' : 'error', 9000);
      if (kind === 'identity') this.askIdentity();
      if (err.data && err.data.output) console.warn(`[git ${label}]`, err.data.output);
    } finally {
      this.busy = false;
      await this.refresh(false);
      if (this.cb.afterOp) await this.cb.afterOp();
    }
  }

  askIdentity() {
    const id = (this.status && this.status.identity) || {};
    const name = h('input', { class: 'input', value: id.name || '', placeholder: 'Your Name' });
    const email = h('input', { class: 'input', value: id.email || '', placeholder: 'you@example.com (use your GitHub email)' });
    modal({
      title: 'Who is committing?',
      body: h('div', { class: 'form' },
        h('p', { class: 'muted' }, 'Git records a name and email with every commit. This is saved in your global git settings, once.'),
        h('label', null, 'Name'), name, h('label', null, 'Email'), email),
      actions: [
        { label: 'Cancel' },
        { label: 'Save', primary: true, onClick: () => { this.op('identity', () => api.post('/api/git/identity', { name: name.value, email: email.value })); } },
      ],
    });
  }

  async showDiff(path) {
    let diff = '';
    try {
      diff = (await api.get('/api/git/diff', { path })).diff;
    } catch (err) { diff = err.message; }
    const lines = diff.split('\n').map((ln) => h('div', {
      class: ln.startsWith('+') && !ln.startsWith('+++') ? 'd-add' : ln.startsWith('-') && !ln.startsWith('---') ? 'd-del' : ln.startsWith('@@') ? 'd-hunk' : '',
    }, ln || ' '));
    modal({
      title: `Changes in ${path}`, wide: true,
      body: h('div', { class: 'diff' }, diff.trim() ? lines : h('p', { class: 'muted' }, 'No textual changes (binary file, or only line endings changed).')),
      actions: [{ label: 'Open file', onClick: () => this.cb.onOpen(path) }, { label: 'Close', primary: true }],
    });
  }

  render() {
    clear(this.bodyEl);
    const st = this.status;
    if (!st) { this.bodyEl.append(h('p', { class: 'muted pad' }, 'Loading…')); return; }
    if (st.error) { this.bodyEl.append(h('p', { class: 'pad error-text' }, st.error)); return; }
    if (!st.available) {
      this.bodyEl.append(h('div', { class: 'git-section' },
        h('p', null, 'Git is not installed, so GitHub sync is off. Everything else works.'),
        h('p', { class: 'muted' }, 'Windows: open PowerShell and run'), h('code', { class: 'cmd' }, 'winget install --id Git.Git -e'),
        h('p', { class: 'muted' }, 'then restart LaTeX Lab.')));
      return;
    }
    if (!st.repo) {
      const remote = h('input', { class: 'input', placeholder: 'https://github.com/you/your-thesis.git (optional)', spellcheck: false });
      this.bodyEl.append(h('div', { class: 'git-section' },
        h('p', null, 'This folder is not a git repository yet.'),
        h('p', { class: 'muted small' }, 'Initialise one to track versions locally. Add a GitHub URL to back it up and sync it with Overleaf.'),
        remote,
        h('button', { class: 'btn btn-primary block', disabled: this.busy, onclick: () => this.op('init', () => api.post('/api/git/init', { remote: remote.value.trim() })) }, icon('git', 15), 'Initialise git')));
      return;
    }

    const branchLine = h('div', { class: 'git-branch' }, icon('git', 15), h('strong', null, st.branch || '(detached)'),
      st.upstream ? h('span', { class: 'muted small' }, `↔ ${st.upstream}`) : null);
    const syncState = [];
    if (st.ahead) syncState.push(h('span', { class: 'pill pill-ahead', title: 'Commits here that GitHub does not have yet' }, icon('arrowUp', 12), `${st.ahead} to push`));
    if (st.behind) syncState.push(h('span', { class: 'pill pill-behind', title: 'Commits on GitHub you do not have yet' }, icon('arrowDown', 12), `${st.behind} to pull`));
    if (!st.ahead && !st.behind && st.upstream) {
      syncState.push((st.changes || []).length
        ? h('span', { class: 'pill', title: 'All commits are on GitHub; you have edits that are not committed yet' }, icon('check', 12), 'Commits on GitHub')
        : h('span', { class: 'pill pill-ok' }, icon('check', 12), 'Everything is on GitHub'));
    }

    const remoteBox = st.remote
      ? h('div', { class: 'git-remote muted small', title: st.remote }, icon('github', 13), st.remote.replace(/^https:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, ''),
        h('button', { class: 'link-btn', onclick: () => this.editRemote() }, 'change'))
      : h('div', { class: 'git-section warn-box' }, h('p', null, 'No GitHub remote yet.'),
        h('button', { class: 'btn btn-sm', onclick: () => this.editRemote() }, 'Connect a GitHub repository'));

    this.bodyEl.append(h('div', { class: 'git-section' }, branchLine, remoteBox, syncState.length ? h('div', { class: 'pills' }, syncState) : null));

    if (!st.identity || !st.identity.name || !st.identity.email) {
      this.bodyEl.append(h('div', { class: 'git-section warn-box' },
        h('p', null, 'Set your name and email so you can commit.'),
        h('button', { class: 'btn btn-sm', onclick: () => this.askIdentity() }, 'Set name & email')));
    }

    if (st.merging || (st.conflicts && st.conflicts.length)) {
      this.bodyEl.append(h('div', { class: 'git-section danger-box' },
        h('p', null, h('strong', null, 'Merge in progress.'), ' Some files were changed both here and on GitHub/Overleaf.'),
        st.conflicts.length ? h('ul', { class: 'conflict-list' }, st.conflicts.map((p) => h('li', null, h('button', { class: 'link-btn', onclick: () => this.cb.onOpen(p) }, p)))) : null,
        h('p', { class: 'muted small' }, 'Open each file, keep the text you want, and delete the <<<<<<<, ======= and >>>>>>> marker lines. Then:'),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-primary btn-sm', disabled: this.busy, onclick: () => this.op('commit', () => api.post('/api/git/commit', { message: 'Merge GitHub changes' })) }, 'Mark resolved & commit'),
          h('button', { class: 'btn btn-sm', disabled: this.busy, onclick: async () => { if (await confirmDialog('Undo the pull and go back to your files as they were before it?', { okText: 'Abort merge' })) this.op('abort', () => api.post('/api/git/abort-merge')); } }, 'Abort merge'))));
    }

    const changes = st.changes || [];
    const message = h('textarea', { class: 'input commit-msg', rows: 2, placeholder: 'Describe your changes (optional)', spellcheck: true });
    message.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.op('commit', () => api.post('/api/git/commit', { message: message.value })); }
    });
    const list = h('div', { class: 'changes' }, changes.length ? changes.map((c) => h('button', {
      class: `change change-${c.status}`, title: `${c.status}: ${c.path}`, onclick: () => (c.status === 'deleted' ? null : this.showDiff(c.path)),
    }, h('span', { class: 'change-code' }, STATUS_LABEL[c.status] || 'M'), h('span', { class: 'change-path' }, c.path))) : h('p', { class: 'muted small' }, 'No local changes.'));

    this.bodyEl.append(h('div', { class: 'git-section' },
      h('div', { class: 'section-title' }, `Changes (${changes.length})`), list, message,
      h('div', { class: 'git-actions' },
        h('button', { class: 'btn btn-sm', disabled: this.busy || !changes.length, title: 'Save a version locally (works offline)', onclick: () => this.op('commit', () => api.post('/api/git/commit', { message: message.value })) }, icon('check', 14), 'Commit'),
        h('button', { class: 'btn btn-sm', disabled: this.busy || !st.remote, title: 'Get the latest from GitHub (e.g. edits made in Overleaf)', onclick: () => this.op('pull', () => api.post('/api/git/pull')) }, icon('arrowDown', 14), 'Pull'),
        h('button', { class: 'btn btn-sm', disabled: this.busy || !st.remote, title: 'Send your commits to GitHub', onclick: () => this.op('push', () => api.post('/api/git/push')) }, icon('arrowUp', 14), 'Push')),
      h('button', {
        class: 'btn btn-primary block', disabled: this.busy || !st.remote,
        title: 'Commit everything, pull from GitHub, then push',
        onclick: () => this.op('sync', () => api.post('/api/git/sync', { message: message.value })),
      }, icon('sync', 15, this.busy ? 'spin' : ''), this.busy ? 'Working…' : 'Sync with GitHub')));

    this.bodyEl.append(h('div', { class: 'git-section' }, h('div', { class: 'section-title' }, 'Recent commits'), h('div', { class: 'git-log' }, h('p', { class: 'muted small' }, 'Loading…'))));
    this.bodyEl.append(h('details', { class: 'git-section tips' },
      h('summary', null, 'How this works with Overleaf'),
      h('ol', null,
        h('li', null, 'Work here offline. Commit whenever you like; it\'s instant and local.'),
        h('li', null, 'When online, press ', h('strong', null, 'Sync with GitHub'), ' to pull Overleaf\'s changes and push yours.'),
        h('li', null, 'In Overleaf: Menu → GitHub → ', h('em', null, 'Pull GitHub changes into Overleaf'), ' to see your local edits there (and ', h('em', null, 'Push Overleaf changes to GitHub'), ' before syncing here).'),
        h('li', null, 'If you lose Overleaf access, nothing changes here: GitHub keeps the full history.'))));
  }

  editRemote() {
    const input = h('input', { class: 'input', value: (this.status && this.status.remote) || '', placeholder: 'https://github.com/you/your-thesis.git', spellcheck: false });
    modal({
      title: 'GitHub repository',
      body: h('div', { class: 'form' },
        h('p', { class: 'muted' }, 'Paste the URL of the repository (the green "Code" button on GitHub). An empty repository is fine: pushing will upload this project to it.'),
        input),
      actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: () => { this.op('remote', () => api.post('/api/git/remote', { url: input.value })); } }],
    });
  }
}
