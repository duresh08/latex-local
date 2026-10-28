// PDF preview built on pdf.js: lazy page rendering, zoom, links, SyncTeX highlights.
// Recompiles swap the document in place and keep your scroll position, like Overleaf.

import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { clear, h, icon } from './dom.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const CSS_PER_PT = 96 / 72;
const PAGE_GAP = 12;
const MAX_CANVAS_PIXELS = 16_000_000;

export class PdfViewer {
  constructor({ onInverseSync, onPageChange, onZoomChange }) {
    this.cb = { onInverseSync, onPageChange, onZoomChange };
    this.doc = null;
    this.bytes = null;
    this.pages = [];
    this.zoom = 'fit-width';
    this.scale = 1;
    this.currentPage = 0;
    this.pagesEl = h('div', { class: 'pdf-pages' });
    this.emptyEl = h('div', { class: 'pdf-empty' }, icon('logs', 40), h('p', null, 'No PDF yet.'),
      h('p', { class: 'muted' }, 'Press Recompile (or Ctrl+S) to build your document.'));
    this.scrollEl = h('div', { class: 'pdf-scroll', tabindex: '0' }, this.emptyEl, this.pagesEl);
    this.loadSeq = 0;

    let ticking = false;
    this.scrollEl.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; this.onScroll(); });
    });
    this.scrollEl.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.scrollEl.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.setZoom(Math.max(0.25, Math.min(5, this.numericZoom() * factor)));
    }, { passive: false });
    let resizeTimer;
    new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (typeof this.zoom === 'string' && this.doc) this.relayout(true); }, 80);
    }).observe(this.scrollEl);
  }

  get el() {
    return this.scrollEl;
  }

  numericZoom() {
    return this.scale / CSS_PER_PT;
  }

  // ------------------------------------------------------------ loading
  async load(arrayBuffer) {
    const seq = ++this.loadSeq;
    this.bytes = arrayBuffer.slice(0);
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer), isEvalSupported: false }).promise;
    if (seq !== this.loadSeq) { doc.destroy(); return; }
    const proxies = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
    const anchor = this.doc ? this.captureAnchor() : null;
    const oldDoc = this.doc;
    const newPages = proxies.map((proxy, i) => {
      const vp = proxy.getViewport({ scale: 1 });
      const el = h('div', { class: 'pdf-page', dataset: { page: String(i + 1) } });
      return { num: i + 1, proxy, w: vp.width, h: vp.height, el, canvas: null, renderedScale: 0, task: null, links: null };
    });
    this.doc = doc;
    const newPagesEl = h('div', { class: 'pdf-pages' }, newPages.map((p) => p.el));
    this.scale = this.computeScale(newPages);
    for (const p of newPages) this.sizePage(p);
    const target = anchor ? Math.min(anchor.index, newPages.length - 1) : 0;
    await Promise.all([target - 1, target, target + 1].filter((i) => i >= 0 && i < newPages.length).map((i) => this.renderPage(newPages[i])));
    if (seq !== this.loadSeq) return;
    for (const p of this.pages) if (p.task) p.task.cancel();
    this.scrollEl.replaceChild(newPagesEl, this.pagesEl);
    this.pagesEl = newPagesEl;
    this.pages = newPages;
    this.emptyEl.classList.add('hidden');
    if (anchor) this.restoreAnchor({ ...anchor, index: target });
    this.onScroll();
    this.cb.onZoomChange && this.cb.onZoomChange(this.zoom, this.numericZoom());
    if (oldDoc) setTimeout(() => oldDoc.destroy(), 0);
  }

  reset() {
    this.loadSeq++;
    if (this.doc) this.doc.destroy();
    this.doc = null;
    this.pages = [];
    clear(this.pagesEl);
    this.emptyEl.classList.remove('hidden');
    this.cb.onPageChange && this.cb.onPageChange(0, 0);
  }

  // ------------------------------------------------------------ layout
  computeScale(pages = this.pages) {
    if (!pages.length) return CSS_PER_PT;
    if (typeof this.zoom === 'number') return this.zoom * CSS_PER_PT;
    const availW = Math.max(100, this.scrollEl.clientWidth - 32);
    const maxW = Math.max(...pages.map((p) => p.w));
    if (this.zoom === 'fit-page') {
      const availH = Math.max(100, this.scrollEl.clientHeight - 24);
      return Math.min(availW / maxW, availH / pages[0].h);
    }
    return availW / maxW;
  }

  sizePage(p) {
    p.el.style.width = `${Math.floor(p.w * this.scale)}px`;
    p.el.style.height = `${Math.floor(p.h * this.scale)}px`;
  }

  relayout(keepAnchor = true) {
    const anchor = keepAnchor ? this.captureAnchor() : null;
    this.scale = this.computeScale();
    for (const p of this.pages) this.sizePage(p);
    if (anchor) this.restoreAnchor(anchor);
    this.onScroll();
    this.cb.onZoomChange && this.cb.onZoomChange(this.zoom, this.numericZoom());
  }

  setZoom(zoom) {
    this.zoom = zoom;
    if (this.doc) this.relayout(true);
    else this.cb.onZoomChange && this.cb.onZoomChange(this.zoom, this.numericZoom());
  }

  zoomBy(factor) {
    this.setZoom(Math.max(0.25, Math.min(5, Math.round(this.numericZoom() * factor * 20) / 20)));
  }

  captureAnchor() {
    const top = this.scrollEl.scrollTop;
    for (let i = 0; i < this.pages.length; i++) {
      const el = this.pages[i].el;
      if (el.offsetTop + el.offsetHeight + PAGE_GAP > top) {
        return { index: i, frac: Math.max(0, (top - el.offsetTop) / el.offsetHeight), left: this.scrollEl.scrollLeft };
      }
    }
    return { index: 0, frac: 0, left: 0 };
  }

  restoreAnchor(anchor) {
    const p = this.pages[anchor.index];
    if (!p) return;
    this.scrollEl.scrollTop = p.el.offsetTop + anchor.frac * p.el.offsetHeight;
    this.scrollEl.scrollLeft = anchor.left || 0;
  }

  visiblePages(margin = 900) {
    const top = this.scrollEl.scrollTop - margin;
    const bottom = this.scrollEl.scrollTop + this.scrollEl.clientHeight + margin;
    return this.pages.filter((p) => p.el.offsetTop + p.el.offsetHeight >= top && p.el.offsetTop <= bottom);
  }

  onScroll() {
    if (!this.pages.length) return;
    const visible = this.visiblePages();
    for (const p of visible) this.renderPage(p);
    // Free canvases that are far away, so 300-page theses don't eat all memory.
    const keep = new Set(this.visiblePages(3000));
    for (const p of this.pages) {
      if (p.canvas && !keep.has(p)) {
        if (p.task) p.task.cancel();
        p.canvas.width = 0;
        p.canvas.remove();
        p.canvas = null;
        p.renderedScale = 0;
      }
    }
    const mid = this.scrollEl.scrollTop + this.scrollEl.clientHeight / 2;
    let current = this.pages[0].num;
    for (const p of this.pages) {
      if (p.el.offsetTop <= mid) current = p.num;
      else break;
    }
    if (current !== this.currentPage) {
      this.currentPage = current;
      this.cb.onPageChange && this.cb.onPageChange(current, this.pages.length);
    }
  }

  async renderPage(p) {
    const scale = this.scale;
    if (p.renderedScale === scale || p.renderingScale === scale) return;
    if (p.task) p.task.cancel();
    p.renderingScale = scale;
    const viewport = p.proxy.getViewport({ scale });
    let dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (viewport.width * viewport.height * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height));
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    const task = p.proxy.render({
      canvasContext: canvas.getContext('2d', { alpha: false }),
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    p.task = task;
    try {
      await task.promise;
    } catch (err) {
      if (p.renderingScale === scale) p.renderingScale = 0;
      return;
    }
    if (p.task === task) p.task = null;
    if (p.renderingScale !== scale) return;
    p.renderingScale = 0;
    if (p.canvas) { p.canvas.width = 0; p.canvas.replaceWith(canvas); } else p.el.prepend(canvas);
    p.canvas = canvas;
    p.renderedScale = scale;
    if (!p.links) this.addLinks(p);
  }

  async addLinks(p) {
    p.links = [];
    let annots = [];
    try {
      annots = await p.proxy.getAnnotations({ intent: 'display' });
    } catch {
      return;
    }
    const vp = p.proxy.getViewport({ scale: 1 });
    const layer = h('div', { class: 'pdf-links' });
    for (const a of annots) {
      if (a.subtype !== 'Link' || (!a.url && !a.dest)) continue;
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
      const left = Math.min(x1, x2), top = Math.min(y1, y2);
      const link = h('a', {
        class: 'pdf-link',
        href: a.url || '#',
        title: a.url || 'Go to location',
        style: { left: `${(left / p.w) * 100}%`, top: `${(top / p.h) * 100}%`, width: `${(Math.abs(x2 - x1) / p.w) * 100}%`, height: `${(Math.abs(y2 - y1) / p.h) * 100}%` },
        onclick: (e) => {
          e.preventDefault();
          if (a.url) window.open(a.url, '_blank', 'noopener');
          else this.goToDest(a.dest);
        },
        ondblclick: (e) => e.stopPropagation(),
      });
      layer.append(link);
    }
    if (layer.childElementCount) p.el.append(layer);
  }

  async goToDest(dest) {
    try {
      const explicit = typeof dest === 'string' ? await this.doc.getDestination(dest) : dest;
      if (!explicit) return;
      const ref = explicit[0];
      const index = typeof ref === 'number' ? ref : await this.doc.getPageIndex(ref);
      const p = this.pages[index];
      if (!p) return;
      const kind = explicit[1] && explicit[1].name;
      let top = null;
      if (kind === 'XYZ') top = explicit[3];
      else if (kind === 'FitH' || kind === 'FitBH') top = explicit[2];
      let y = 0;
      if (top !== null && top !== undefined) y = p.proxy.getViewport({ scale: 1 }).convertToViewportPoint(0, top)[1];
      this.scrollEl.scrollTop = p.el.offsetTop + Math.max(0, y * this.scale - 12);
    } catch {
      /* ignore broken destinations */
    }
  }

  goToPage(num) {
    const p = this.pages[num - 1];
    if (p) this.scrollEl.scrollTop = p.el.offsetTop - 6;
  }

  // ------------------------------------------------------------ SyncTeX
  onDblClick(e) {
    const pageEl = e.target.closest('.pdf-page');
    if (!pageEl) return;
    const rect = pageEl.getBoundingClientRect();
    const x = (e.clientX - rect.left) / this.scale;
    const y = (e.clientY - rect.top) / this.scale;
    this.cb.onInverseSync && this.cb.onInverseSync(Number(pageEl.dataset.page), x, y);
  }

  showLocation(pageNum, y, rects = []) {
    const p = this.pages[pageNum - 1];
    if (!p) return;
    this.scrollEl.scrollTop = p.el.offsetTop + y * this.scale - this.scrollEl.clientHeight / 3;
    this.onScroll();
    for (const old of this.pagesEl.querySelectorAll('.sync-hl')) old.remove();
    for (const r of rects) {
      const hl = h('div', {
        class: 'sync-hl',
        style: { left: `${(r.x / p.w) * 100}%`, top: `${(r.y / p.h) * 100}%`, width: `${(r.w / p.w) * 100}%`, height: `${(r.h / p.h) * 100}%` },
      });
      p.el.append(hl);
      setTimeout(() => hl.remove(), 2600);
    }
  }

  downloadName(name) {
    if (!this.bytes) return;
    const url = URL.createObjectURL(new Blob([this.bytes], { type: 'application/pdf' }));
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}
