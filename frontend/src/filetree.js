// Project file tree: open, create, rename, move (drag), upload (drop), delete, set main file.

import { api } from './api.js';
import { clear, confirmDialog, fileIcon, h, icon, promptDialog, showMenu, toast } from './dom.js';

export class FileTree {
  constructor({ projectKey, onOpen, onChanged, onRenamed, onDeleted, onSetMain, getMain, getActive, isDirty }) {
    this.cb = { onOpen, onChanged, onRenamed, onDeleted, onSetMain, getMain, getActive, isDirty };
    this.storageKey = `latexlab.expanded.${projectKey}`;
    try {
      this.expanded = new Set(JSON.parse(localStorage.getItem(this.storageKey) || '[]'));
    } catch {
      this.expanded = new Set();
    }
    this.tree = null;
    this.listEl = h('div', { class: 'tree', role: 'tree' });
    this.fileInput = h('input', { type: 'file', multiple: true, class: 'hidden', onchange: () => this.uploadFiles(this.uploadTarget || '', [...this.fileInput.files]) });
    const tool = (name, title, fn) => h('button', { class: 'icon-btn', title, onclick: fn }, icon(name, 16));
    this.el = h('div', { class: 'panel files-panel' },
      h('div', { class: 'panel-header' },
        h('span', { class: 'panel-title' }, 'Files'),
        h('span', { class: 'spacer' }),
        tool('filePlus', 'New file', () => this.newFile(this.contextDir())),
        tool('folderPlus', 'New folder', () => this.newFolder(this.contextDir())),
        tool('upload', 'Upload files', () => this.pickUpload(this.contextDir())),
        tool('refresh', 'Refresh', () => this.cb.onChanged())),
      this.listEl, this.fileInput);

    this.listEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      const row = e.target.closest('.tree-row');
      this.setDropTarget(row ? (row.dataset.type === 'dir' ? row.dataset.path : parentOf(row.dataset.path)) : '');
    });
    this.listEl.addEventListener('dragleave', (e) => { if (!this.listEl.contains(e.relatedTarget)) this.setDropTarget(null); });
    this.listEl.addEventListener('drop', (e) => this.onDrop(e));
    this.listEl.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.tree-row')) return;
      e.preventDefault();
      this.rootMenu(e.clientX, e.clientY);
    });
  }

  setTree(tree) {
    this.tree = tree;
    this.render();
  }

  contextDir() {
    const active = this.cb.getActive();
    return active ? parentOf(active) : '';
  }

  saveExpanded() {
    try { localStorage.setItem(this.storageKey, JSON.stringify([...this.expanded])); } catch { /* private mode */ }
  }

  reveal(path) {
    let dir = parentOf(path);
    while (dir) { this.expanded.add(dir); dir = parentOf(dir); }
    this.saveExpanded();
    this.render();
  }

  render() {
    clear(this.listEl);
    if (!this.tree) return;
    const main = this.cb.getMain();
    const active = this.cb.getActive();
    const walk = (node, depth) => {
      for (const child of node.children || []) {
        const isDir = child.type === 'dir';
        const open = isDir && this.expanded.has(child.path);
        const row = h('div', {
          class: `tree-row ${child.path === active ? 'active' : ''}`,
          role: 'treeitem',
          draggable: 'true',
          title: child.path,
          dataset: { path: child.path, type: child.type },
          style: { paddingLeft: `${8 + depth * 14}px` },
          onclick: () => {
            if (isDir) {
              if (open) this.expanded.delete(child.path); else this.expanded.add(child.path);
              this.saveExpanded();
              this.render();
            } else this.cb.onOpen(child.path);
          },
          oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); this.itemMenu(child, e.clientX, e.clientY); },
          ondragstart: (e) => { e.dataTransfer.setData('application/x-latexlab-path', child.path); e.dataTransfer.effectAllowed = 'move'; },
        },
        isDir ? icon(open ? 'chevronDown' : 'chevronRight', 14, 'chev') : h('span', { class: 'chev-space' }),
        isDir ? icon(open ? 'folderOpen' : 'folder', 15, 'ft-dir') : fileIcon(child.path),
        h('span', { class: 'tree-name' }, child.name),
        child.path === main ? h('span', { class: 'main-badge', title: 'Main document (compiled)' }, 'main') : null,
        !isDir && this.cb.isDirty(child.path) ? h('span', { class: 'dirty-dot' }) : null,
        h('button', {
          class: 'row-menu icon-btn', title: 'More',
          onclick: (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); this.itemMenu(child, r.left, r.bottom); },
        }, icon('more', 14)));
        this.listEl.append(row);
        if (open) walk(child, depth + 1);
      }
    };
    walk(this.tree, 0);
    if (!(this.tree.children || []).length) {
      this.listEl.append(h('p', { class: 'muted pad' }, 'This folder is empty. Create a file or drop files here.'));
    }
  }

  setDropTarget(dir) {
    for (const el of this.listEl.querySelectorAll('.drop-target')) el.classList.remove('drop-target');
    this.listEl.classList.toggle('drop-root', dir === '');
    if (dir) {
      const row = this.listEl.querySelector(`.tree-row[data-path="${CSS.escape(dir)}"]`);
      if (row) row.classList.add('drop-target');
    }
  }

  async onDrop(e) {
    e.preventDefault();
    const row = e.target.closest('.tree-row');
    const dir = row ? (row.dataset.type === 'dir' ? row.dataset.path : parentOf(row.dataset.path)) : '';
    this.setDropTarget(null);
    const moving = e.dataTransfer.getData('application/x-latexlab-path');
    if (moving) {
      const dest = dir ? `${dir}/${baseName(moving)}` : baseName(moving);
      if (dest === moving || dir === moving || dir.startsWith(`${moving}/`)) return;
      await this.move(moving, dest);
      return;
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length) await this.uploadFiles(dir, [...e.dataTransfer.files]);
  }

  rootMenu(x, y) {
    showMenu(x, y, [
      { label: 'New file', icon: 'filePlus', onClick: () => this.newFile('') },
      { label: 'New folder', icon: 'folderPlus', onClick: () => this.newFolder('') },
      { label: 'Upload files', icon: 'upload', onClick: () => this.pickUpload('') },
    ]);
  }

  itemMenu(node, x, y) {
    const isDir = node.type === 'dir';
    const dir = isDir ? node.path : parentOf(node.path);
    showMenu(x, y, [
      !isDir && /\.(tex|ltx)$/i.test(node.path) ? { label: 'Set as main document', icon: 'star', onClick: () => this.cb.onSetMain(node.path) } : null,
      !isDir && /\.(tex|ltx)$/i.test(node.path) ? '-' : null,
      { label: 'New file here', icon: 'filePlus', onClick: () => this.newFile(dir) },
      { label: 'New folder here', icon: 'folderPlus', onClick: () => this.newFolder(dir) },
      { label: 'Upload here', icon: 'upload', onClick: () => this.pickUpload(dir) },
      '-',
      { label: 'Rename / move', icon: 'edit', onClick: () => this.rename(node) },
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => this.remove(node) },
    ]);
  }

  async newFile(dir) {
    const name = await promptDialog('New file', { value: 'chapter.tex', label: dir ? `In ${dir}/` : 'In the project root', select: [0, 7], okText: 'Create' });
    if (!name) return;
    const path = dir ? `${dir}/${name}` : name;
    try {
      await api.post('/api/fs/create', { path, type: 'file' });
      this.reveal(path);
      await this.cb.onChanged();
      this.cb.onOpen(path);
    } catch (err) { toast(err.message, 'error'); }
  }

  async newFolder(dir) {
    const name = await promptDialog('New folder', { value: '', placeholder: 'figures', label: dir ? `In ${dir}/` : 'In the project root', okText: 'Create' });
    if (!name) return;
    const path = dir ? `${dir}/${name}` : name;
    try {
      await api.post('/api/fs/create', { path, type: 'dir' });
      this.expanded.add(path);
      this.reveal(path);
      await this.cb.onChanged();
    } catch (err) { toast(err.message, 'error'); }
  }

  pickUpload(dir) {
    this.uploadTarget = dir;
    this.fileInput.value = '';
    this.fileInput.click();
  }

  async uploadFiles(dir, files) {
    let done = 0;
    for (const file of files) {
      const query = { dir, name: file.name };
      try {
        await api.upload('/api/fs/upload', query, await file.arrayBuffer());
        done++;
      } catch (err) {
        if (err.status === 409 && await confirmDialog(`${file.name} already exists in ${dir || 'the project root'}. Replace it?`, { okText: 'Replace', title: 'Replace file?' })) {
          await api.upload('/api/fs/upload', { ...query, overwrite: '1' }, await file.arrayBuffer());
          done++;
        } else if (err.status !== 409) toast(`${file.name}: ${err.message}`, 'error');
      }
    }
    if (dir) { this.expanded.add(dir); this.saveExpanded(); }
    if (done) toast(`Uploaded ${done} file${done > 1 ? 's' : ''}`, 'success', 2500);
    await this.cb.onChanged();
  }

  async rename(node) {
    const name = baseName(node.path);
    const dot = name.lastIndexOf('.');
    const start = node.path.length - name.length;
    const to = await promptDialog(`Rename ${node.type === 'dir' ? 'folder' : 'file'}`, {
      value: node.path, label: 'New path (use / to move into a folder)', okText: 'Rename',
      select: [start, node.type === 'dir' || dot <= 0 ? node.path.length : start + dot],
    });
    if (!to || to === node.path) return;
    await this.move(node.path, to);
  }

  async move(from, to) {
    try {
      const res = await api.post('/api/fs/rename', { from, to });
      this.cb.onRenamed(from, res.path);
      this.reveal(res.path);
      await this.cb.onChanged();
    } catch (err) { toast(err.message, 'error'); }
  }

  async remove(node) {
    const what = node.type === 'dir' ? `the folder “${node.path}” and everything in it` : `“${node.path}”`;
    if (!await confirmDialog(`Delete ${what}? If the project is in git you can get it back from the last commit.`, { okText: 'Delete', danger: true, title: 'Delete?' })) return;
    try {
      await api.post('/api/fs/delete', { path: node.path });
      this.cb.onDeleted(node.path);
      await this.cb.onChanged();
    } catch (err) { toast(err.message, 'error'); }
  }
}

export function parentOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function baseName(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function flattenFiles(tree) {
  const out = [];
  const walk = (n) => { for (const c of n.children || []) { if (c.type === 'dir') walk(c); else out.push(c.path); } };
  if (tree) walk(tree);
  return out;
}

export class Outline {
  constructor({ onJump }) {
    this.onJump = onJump;
    this.collapsed = false;
    this.listEl = h('div', { class: 'outline-list' });
    this.el = h('div', { class: 'panel outline-panel' },
      h('button', { class: 'panel-header outline-toggle', onclick: () => { this.collapsed = !this.collapsed; this.el.classList.toggle('collapsed', this.collapsed); } },
        icon('list', 15), h('span', { class: 'panel-title' }, 'File outline')),
      this.listEl);
  }

  render(items, currentLine) {
    clear(this.listEl);
    if (!items || !items.length) {
      this.listEl.append(h('p', { class: 'muted pad' }, 'No sections in this file.'));
      return;
    }
    const minLevel = Math.min(...items.map((i) => i.level));
    let current = null;
    for (const it of items) if (currentLine && it.line <= currentLine) current = it;
    for (const it of items) {
      this.listEl.append(h('button', {
        class: `outline-item ${it === current ? 'current' : ''}`,
        style: { paddingLeft: `${10 + (it.level - minLevel) * 12}px` },
        title: `Line ${it.line}`,
        onclick: () => this.onJump(it.line),
      }, it.title));
    }
  }
}
