// Lecture rapide des très gros fichiers (lecture seule) : seules les lignes
// visibles sont demandées au noyau, par pages de 200, pendant que l'index
// des lignes se construit en arrière-plan.

import { h, clear, humanSize } from '../ui/dom';
import { icon } from '../ui/icons';
import { rpc, errorMessage } from '../core/rpc';
import { rafThrottle } from '../core/events';
import type { Doc } from '../workspace/doc';

const PAGE = 200;
const LH = 20;

export interface BigHost {
  notify(msg: string): void;
  editAnyway(doc: Doc): void;
  maxEditBytes(): number;
}

export class BigView {
  readonly root: HTMLElement;
  private header: HTMLElement;
  private status: HTMLElement;
  private scroller: HTMLElement;
  private spacer: HTMLElement;
  private rows: HTMLElement;
  private results: HTMLElement;
  private searchInput: HTMLInputElement;
  private editBtn: HTMLButtonElement;
  private doc: Doc | null = null;
  private pages = new Map<number, string[] | Promise<void>>();
  private truncated = new Set<number>();
  private lines = 1;
  private complete = false;
  private polling = 0;
  private searchJob: number | null = null;
  private highlightLine = -1;
  private host: BigHost;
  private render = rafThrottle(() => this.draw());

  constructor(host: BigHost) {
    this.host = host;
    this.status = h('span', { class: 'big-status', attrs: { 'aria-live': 'polite' } });
    this.searchInput = h('input', { class: 'input', type: 'search', placeholder: 'Rechercher dans le fichier', attrs: { 'aria-label': 'Rechercher dans le fichier', spellcheck: 'false' } });
    const gotoBtn = h('button', { class: 'btn btn-small', type: 'button', text: 'Aller à la ligne…' });
    this.editBtn = h('button', { class: 'btn btn-small', type: 'button', text: 'Modifier quand même' });
    this.header = h(
      'div',
      { class: 'big-header' },
      h('span', { class: 'big-badge' }, icon('lock'), ' Lecture rapide'),
      this.status,
      h('span', { class: 'spacer' }),
      this.searchInput,
      gotoBtn,
      this.editBtn,
    );
    this.spacer = h('div', { class: 'big-spacer' });
    this.rows = h('div', { class: 'big-rows' });
    this.scroller = h('div', { class: 'big-scroller', tabIndex: 0, attrs: { role: 'document', 'aria-label': 'Contenu du fichier (lecture seule)' } }, this.spacer, this.rows);
    this.results = h('div', { class: 'big-results', hidden: true, role: 'list', attrs: { 'aria-label': 'Résultats' } });
    this.root = h('div', { class: 'bigview' }, this.header, h('div', { class: 'big-main' }, this.scroller, this.results));
    this.scroller.addEventListener('scroll', () => this.render(), { passive: true });
    new ResizeObserver(() => this.render()).observe(this.scroller);
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.search(this.searchInput.value);
      if (e.key === 'Escape') {
        this.searchInput.value = '';
        this.results.hidden = true;
      }
    });
    gotoBtn.addEventListener('click', () => this.root.dispatchEvent(new CustomEvent('big-goto', { bubbles: true })));
    this.editBtn.addEventListener('click', () => this.doc && this.host.editAnyway(this.doc));
  }

  attach(doc: Doc): void {
    this.detach();
    this.doc = doc;
    this.pages.clear();
    this.truncated.clear();
    const info = doc.big!.info;
    this.lines = Math.max(1, info.lines ?? 1);
    this.complete = !!info.complete;
    this.editBtn.hidden = (info.size ?? 0) > this.host.maxEditBytes();
    this.editBtn.title = `Charger le fichier dans l'éditeur (${humanSize(info.size)}) : l'interface peut ralentir.`;
    this.updateStatus(info);
    this.scroller.scrollTop = 0;
    this.render();
    if (doc.big!.jobId && !this.complete) void this.pollIndex(doc);
  }

  detach(): void {
    this.polling++;
    this.doc = null;
    clear(this.rows);
    clear(this.results);
    this.results.hidden = true;
    if (this.searchJob) {
      void rpc('job.cancel', { id: this.searchJob }).catch(() => {});
      this.searchJob = null;
    }
  }

  private updateStatus(info: any): void {
    const parts = [humanSize(info.size ?? 0), info.encodingLabel ?? ''];
    if (this.complete) parts.push(`${this.lines.toLocaleString('fr-FR')} lignes`);
    else {
      const pct = info.size ? Math.floor(((info.bytesIndexed ?? info.bytes ?? 0) / info.size) * 100) : 0;
      parts.push(`indexation ${pct} % (${this.lines.toLocaleString('fr-FR')} lignes)`);
    }
    this.status.textContent = parts.filter(Boolean).join(' · ');
  }

  private async pollIndex(doc: Doc): Promise<void> {
    const token = ++this.polling;
    const jobId = doc.big!.jobId!;
    while (token === this.polling) {
      let r: any;
      try {
        r = await rpc('job.poll', { id: jobId, waitMs: 400 });
      } catch {
        break;
      }
      if (token !== this.polling) return;
      const p = r.progress;
      if (p) {
        this.lines = Math.max(this.lines, p.lines ?? 1);
        this.updateStatus({ ...doc.big!.info, bytes: p.bytes });
      }
      if (r.done) {
        doc.big!.jobId = null;
        if (r.result) {
          doc.big!.info = r.result;
          this.lines = r.result.lines;
        }
        this.complete = true;
        if (r.error && r.error.code !== 'cancelled') this.host.notify(`Indexation interrompue : ${r.error.message}`);
        this.updateStatus(doc.big!.info);
        this.render();
        return;
      }
      this.render();
    }
  }

  private pageOf(line: number): number {
    return Math.floor(line / PAGE);
  }

  private ensurePage(p: number): void {
    if (this.pages.has(p) || !this.doc?.big) return;
    const id = this.doc.big.id;
    const doc = this.doc;
    const promise = rpc('big.lines', { id, start: p * PAGE, count: PAGE })
      .then((r: any) => {
        if (this.doc !== doc) return;
        if (r.pending) {
          this.pages.delete(p);
          return;
        }
        this.pages.set(p, r.lines);
        for (const t of r.truncated ?? []) this.truncated.add(t);
        if (r.complete && p * PAGE + r.lines.length > this.lines) this.lines = p * PAGE + r.lines.length;
        this.render();
      })
      .catch((e) => {
        this.pages.delete(p);
        this.host.notify(`Lecture impossible : ${errorMessage(e)}`);
      });
    this.pages.set(p, promise);
    // Limite la mémoire : garde au plus 40 pages.
    if (this.pages.size > 40) {
      const center = this.pageOf(Math.floor(this.scroller.scrollTop / LH));
      const far = [...this.pages.keys()].sort((a, b) => Math.abs(b - center) - Math.abs(a - center));
      for (const k of far.slice(0, this.pages.size - 40)) this.pages.delete(k);
    }
  }

  private draw(): void {
    if (!this.doc) return;
    // Hauteur bornée pour rester sous la limite de taille des éléments du navigateur.
    const total = this.lines * LH;
    const scale = total > 15_000_000 ? 15_000_000 / total : 1;
    this.spacer.style.height = `${Math.ceil(total * scale)}px`;
    const top = this.scroller.scrollTop / scale;
    const first = Math.max(0, Math.floor(top / LH));
    const count = Math.ceil(this.scroller.clientHeight / LH) + 2;
    const last = Math.min(this.lines - 1, first + count);
    const digits = String(this.lines).length;
    clear(this.rows);
    this.rows.style.transform = `translateY(${this.scroller.scrollTop - (top - first * LH)}px)`;
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
      const p = this.pageOf(i);
      const page = this.pages.get(p);
      if (!page || page instanceof Promise) this.ensurePage(p);
      const text = Array.isArray(page) ? page[i - p * PAGE] : undefined;
      const row = h(
        'div',
        { class: `big-row${i === this.highlightLine ? ' hl' : ''}` },
        h('span', { class: 'big-ln', text: String(i + 1).padStart(digits, ' ') }),
        h('span', { class: 'big-tx', text: text ?? (Array.isArray(page) ? '' : '…') }),
      );
      if (this.truncated.has(i)) row.append(h('span', { class: 'big-trunc', text: ' [ligne tronquée à l’affichage]' }));
      frag.append(row);
    }
    this.rows.append(frag);
  }

  scrollToLine(line1: number): void {
    const total = this.lines * LH;
    const scale = total > 15_000_000 ? 15_000_000 / total : 1;
    const i = Math.max(0, Math.min(this.lines - 1, line1 - 1));
    this.highlightLine = i;
    this.scroller.scrollTop = Math.max(0, (i * LH - this.scroller.clientHeight / 3) * scale);
    this.render();
  }

  lineCount(): number {
    return this.lines;
  }

  focusSearch(): void {
    this.searchInput.focus();
    this.searchInput.select();
  }

  private async search(query: string): Promise<void> {
    if (!this.doc?.big || !query) return;
    if (this.searchJob) await rpc('job.cancel', { id: this.searchJob }).catch(() => {});
    clear(this.results);
    this.results.hidden = false;
    const head = h('div', { class: 'big-res-head', text: 'Recherche…' });
    this.results.append(head);
    const doc = this.doc;
    let jobId: number;
    try {
      jobId = (await rpc('big.search', { id: doc.big!.id, query, maxResults: 5000 })).jobId;
    } catch (e) {
      head.textContent = errorMessage(e);
      return;
    }
    this.searchJob = jobId;
    let n = 0;
    for (;;) {
      let r: any;
      try {
        r = await rpc('job.poll', { id: jobId, waitMs: 300, max: 500 });
      } catch {
        break;
      }
      if (this.doc !== doc || this.searchJob !== jobId) return;
      for (const it of r.items) {
        n++;
        if (n > 1000) continue;
        const b = h('button', { class: 'big-res', type: 'button', role: 'listitem' }, h('span', { class: 'big-res-ln', text: `${it.line}` }), h('span', { class: 'big-res-tx', text: it.preview }));
        b.addEventListener('click', () => this.scrollToLine(it.line));
        this.results.append(b);
      }
      const pct = r.progress?.size ? Math.floor((r.progress.bytes / r.progress.size) * 100) : 0;
      head.textContent = r.done ? `${n.toLocaleString('fr-FR')} résultat(s)${r.result?.truncated ? ' (limite atteinte)' : ''}${n > 1000 ? ' — 1 000 premiers affichés' : ''}` : `Recherche… ${pct} % — ${n} résultat(s)`;
      if (r.done) {
        this.searchJob = null;
        break;
      }
    }
  }
}
