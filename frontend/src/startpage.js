// Start page: recent projects, open folder, clone from GitHub, import Overleaf zip, new project.

import { api } from './api.js';
import { clear, h, icon, toast } from './dom.js';
import { browseFolder, showSetupGuide } from './dialogs.js';

export function renderStartPage(root, appState, { onOpened, onQuit }) {
  clear(root);
  const sep = appState.sep || '/';
  const busy = (btn, on, label) => {
    btn.disabled = on;
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.textContent = on ? label : btn.dataset.label;
  };
  const run = async (btn, label, fn) => {
    busy(btn, true, label);
    try {
      const st = await fn();
      onOpened(st);
    } catch (err) {
      toast(err.message, 'error', 9000);
      busy(btn, false);
    }
  };
  const parentField = (value) => {
    const input = h('input', { class: 'input', value, spellcheck: false });
    const row = h('div', { class: 'row' }, input,
      h('button', { class: 'btn', type: 'button', onclick: () => browseFolder(input.value, (p) => { input.value = p; }) }, 'Browse…'));
    return { input, row };
  };

  // --- TeX status chip
  const texChip = h('button', { class: 'tex-chip', onclick: () => showSetupGuide({ onChanged: refreshChip }) }, 'Checking LaTeX…');
  async function refreshChip() {
    try {
      const rep = await api.get('/api/doctor');
      clear(texChip).append(icon(rep.ready ? 'check' : 'alert', 14), rep.ready ? `${rep.distro || 'LaTeX'} ready` : 'LaTeX not found: click to set up');
      texChip.classList.toggle('bad', !rep.ready);
    } catch {
      texChip.textContent = 'Setup guide';
    }
  }
  refreshChip();

  // --- recent
  const recent = h('div', { class: 'recent-list' });
  if (!appState.recent.length) recent.append(h('p', { class: 'muted' }, 'Projects you open will appear here.'));
  for (const r of appState.recent) {
    recent.append(h('div', { class: `recent ${r.exists ? '' : 'missing'}` },
      h('button', {
        class: 'recent-open', disabled: !r.exists, title: r.path,
        onclick: () => run(recent.querySelector('.recent-open'), 'Opening…', () => api.post('/api/project/open', { path: r.path })),
      }, icon('folder', 18), h('span', { class: 'recent-text' }, h('strong', null, r.name), h('span', { class: 'muted small' }, r.exists ? r.path : `${r.path} (missing)`))),
      h('button', {
        class: 'icon-btn', title: 'Remove from list',
        onclick: async () => { const st = await api.post('/api/project/forget', { path: r.path }); renderStartPage(root, st, { onOpened, onQuit }); },
      }, icon('x', 14))));
  }

  // --- open folder
  const openPath = h('input', { class: 'input', placeholder: sep === '\\' ? 'C:\\Users\\you\\Documents\\LaTeX\\thesis' : '~/Documents/LaTeX/thesis', spellcheck: false });
  const openBtn = h('button', { class: 'btn btn-primary' }, 'Open');
  openBtn.onclick = () => run(openBtn, 'Opening…', () => api.post('/api/project/open', { path: openPath.value.trim() }));
  openPath.addEventListener('keydown', (e) => { if (e.key === 'Enter') openBtn.click(); });

  // --- clone
  const cloneUrl = h('input', { class: 'input', placeholder: 'https://github.com/you/your-thesis', spellcheck: false });
  const cloneParent = parentField(appState.defaultParent);
  const cloneName = h('input', { class: 'input', placeholder: 'folder name (optional)', spellcheck: false });
  const cloneBtn = h('button', { class: 'btn btn-primary' }, 'Clone & open');
  cloneUrl.addEventListener('input', () => {
    const m = cloneUrl.value.trim().replace(/\/+$/, '').match(/([^/:]+?)(\.git)?$/);
    cloneName.placeholder = m ? m[1] : 'folder name (optional)';
  });
  cloneBtn.onclick = () => run(cloneBtn, 'Cloning… (large projects take a while)', () => api.post('/api/project/clone', {
    url: cloneUrl.value.trim(), parent: cloneParent.input.value.trim(), name: cloneName.value.trim(),
  }));

  // --- zip
  const zipFile = h('input', { type: 'file', accept: '.zip,application/zip', class: 'input' });
  const zipName = h('input', { class: 'input', placeholder: 'folder name', spellcheck: false });
  const zipParent = parentField(appState.defaultParent);
  const zipRemote = h('input', { class: 'input', placeholder: 'GitHub repo URL to connect (optional)', spellcheck: false });
  const zipBtn = h('button', { class: 'btn btn-primary' }, 'Import & open');
  zipFile.addEventListener('change', () => {
    const f = zipFile.files[0];
    if (f && !zipName.value) zipName.value = f.name.replace(/\.zip$/i, '').replace(/\s*\(\d+\)$/, '').trim();
  });
  zipBtn.onclick = () => {
    const f = zipFile.files[0];
    if (!f) { toast('Choose the .zip you downloaded from Overleaf (Menu → Download → Source).', 'warning'); return; }
    run(zipBtn, 'Importing…', async () => api.upload('/api/project/import-zip', {
      parent: zipParent.input.value.trim(), name: zipName.value.trim() || f.name.replace(/\.zip$/i, ''), remote: zipRemote.value.trim(),
    }, await f.arrayBuffer()));
  };

  // --- new
  const newName = h('input', { class: 'input', placeholder: 'my-paper', spellcheck: false });
  const newParent = parentField(appState.defaultParent);
  const newBtn = h('button', { class: 'btn btn-primary' }, 'Create');
  newBtn.onclick = () => run(newBtn, 'Creating…', () => api.post('/api/project/new', { parent: newParent.input.value.trim(), name: newName.value.trim() }));

  const card = (iconName, title, desc, ...content) => h('section', { class: 'start-card' },
    h('div', { class: 'start-card-head' }, icon(iconName, 20), h('h2', null, title)),
    desc ? h('p', { class: 'muted small' }, desc) : null, ...content);

  root.append(h('div', { class: 'start' },
    h('header', { class: 'start-header' },
      h('div', { class: 'brand-lg' }, h('span', { class: 'logo' }, 'L'), h('span', null, 'LaTeX Lab'), h('span', { class: 'muted small' }, `v${appState.version}`)),
      h('span', { class: 'spacer' }), texChip,
      h('button', { class: 'btn btn-sm', title: 'Stop LaTeX Lab', onclick: () => onQuit && onQuit() }, icon('x', 14), 'Quit')),
    h('p', { class: 'start-tagline muted' }, 'A local, offline LaTeX editor that works like Overleaf. Your files stay on your computer; GitHub is your backup and your bridge to Overleaf.'),
    h('div', { class: 'start-grid' },
      h('section', { class: 'start-card recent-card' }, h('div', { class: 'start-card-head' }, icon('home', 20), h('h2', null, 'Recent projects')), recent),
      h('div', { class: 'start-actions' },
        card('folderOpen', 'Open a project folder', null,
          h('div', { class: 'row' }, openPath, h('button', { class: 'btn', onclick: () => browseFolder(openPath.value, (p) => { openPath.value = p; openBtn.click(); }, { okText: 'Open this folder' }) }, 'Browse…'), openBtn)),
        card('github', 'Clone from GitHub', 'Best way to bring your Overleaf project here, if it is linked to a GitHub repo. Uses your normal git sign-in.',
          cloneUrl, h('label', { class: 'small muted' }, 'Save in'), cloneParent.row, cloneName, cloneBtn),
        card('zip', 'Import an Overleaf .zip', 'In Overleaf: Menu → Download → Source. No GitHub needed. Optionally connect an (empty) GitHub repo to push it to.',
          zipFile, zipName, h('label', { class: 'small muted' }, 'Save in'), zipParent.row, zipRemote, zipBtn),
        card('filePlus', 'New blank project', null,
          newName, h('label', { class: 'small muted' }, 'Save in'), newParent.row, newBtn)))));
  const hint = h('p', { class: 'muted small start-foot' }, 'Tip: you can also start LaTeX Lab with a folder, e.g. ', h('code', null, 'latexlab C:\\path\\to\\thesis'), '.');
  root.querySelector('.start').append(hint);
}

