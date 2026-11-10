// Aperçu Markdown d'un document : rendu différé, images locales chargées par
// le noyau, liens contrôlés, synchronisation du défilement.

import { h, clear } from '../ui/dom';
import { call } from '../core/rpc';
import type { Heading } from './render';
import { slugify } from './outline';

type RenderModule = typeof import('./render');
let loader: Promise<RenderModule> | null = null;

/** Charge le moteur de rendu (une seule fois). */
export function loadRenderer(): Promise<RenderModule> {
  if (!loader) loader = import('./render');
  return loader;
}

export interface PreviewHost {
  openPath(path: string): void;
  openExternal(url: string): void;
  notify(msg: string): void;
}

/** Résout un chemin relatif d'image ou de lien par rapport au dossier du document. */
export function resolveLocal(baseDir: string, ref: string, sep: string): string | null {
  let r: string;
  try {
    r = decodeURI(ref);
  } catch {
    r = ref;
  }
  r = r.split('#')[0].split('?')[0];
  if (!r) return null;
  const absWin = /^[a-z]:[\\/]/i.test(r) || r.startsWith('\\\\');
  const absUnix = r.startsWith('/');
  const parts = (absWin || absUnix ? r : `${baseDir}${sep}${r}`).split(/[\\/]+/);
  const out: string[] = [];
  for (const p of parts) {
    if (p === '.' || (p === '' && out.length > 0)) continue;
    if (p === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(p);
  }
  let joined = out.join(sep);
  if (sep === '/' && !joined.startsWith('/')) joined = '/' + joined;
  if (/^[a-z]:$/i.test(joined)) joined += sep;
  return joined;
}

export class MarkdownPreview {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private host: PreviewHost;
  private images = new Map<string, string>();
  private baseDir = '';
  private sep = '\\';
  private seq = 0;
  headings: Heading[] = [];

  constructor(host: PreviewHost) {
    this.host = host;
    this.body = h('article', { class: 'md-body' });
    this.root = h('div', { class: 'md-preview', tabIndex: 0, role: 'document', attrs: { 'aria-label': 'Aperçu Markdown' } }, this.body);
    this.root.addEventListener('click', (e) => this.onClick(e));
  }

  async update(text: string, baseDir: string | null, sep: string, toc: boolean): Promise<void> {
    const seq = ++this.seq;
    this.baseDir = baseDir ?? '';
    this.sep = sep;
    const mod = await loadRenderer();
    if (seq !== this.seq) return;
    const { html, headings } = mod.render(text);
    this.headings = headings;
    const scroll = this.root.scrollTop;
    // Sortie de markdown-it en mode `html: false` : texte échappé, sans script.
    this.body.innerHTML = html;
    if (toc && headings.length >= 3) this.body.prepend(this.buildToc(headings));
    this.root.scrollTop = scroll;
    void this.loadImages(seq);
  }

  private buildToc(headings: Heading[]): HTMLElement {
    const nav = h('nav', { class: 'md-toc', attrs: { 'aria-label': 'Table des matières' } }, h('div', { class: 'md-toc-title', text: 'Table des matières' }));
    const ul = h('ul');
    for (const hd of headings.slice(0, 300)) {
      const a = h('a', { text: hd.text, attrs: { href: '#', 'data-href': `#${hd.id.slice(5)}` } });
      ul.append(h('li', { class: `md-toc-l${hd.level}` }, a));
    }
    nav.append(ul);
    return nav;
  }

  private async loadImages(seq: number): Promise<void> {
    const imgs = [...this.body.querySelectorAll<HTMLImageElement>('img[data-local]')];
    for (const img of imgs) {
      if (seq !== this.seq) return;
      const ref = img.dataset.local ?? '';
      const path = this.baseDir ? resolveLocal(this.baseDir, ref, this.sep) : null;
      if (!path) {
        img.replaceWith(h('span', { class: 'md-remote', text: `[Image introuvable : ${ref}]` }));
        continue;
      }
      let url = this.images.get(path);
      if (!url) {
        try {
          const r = await call('file.readBinary', { path, maxBytes: 20 * 1024 * 1024 });
          url = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: r.json.mime }));
          this.images.set(path, url);
        } catch (e) {
          if (seq !== this.seq) return;
          img.replaceWith(h('span', { class: 'md-remote', text: `[Image non affichée : ${ref}]`, title: String((e as Error).message ?? e) }));
          continue;
        }
      }
      if (seq !== this.seq) return;
      img.src = url;
      img.classList.remove('md-img-pending');
    }
  }

  private onClick(e: MouseEvent): void {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('data-href') ?? '';
    if (!href) return;
    if (href.startsWith('#')) {
      let frag = href.slice(1);
      try {
        frag = decodeURIComponent(frag);
      } catch {
        /* fragment non encodé */
      }
      const el = this.body.querySelector(`[id="md-h-${CSS.escape(frag)}"]`) ?? this.body.querySelector(`[id="md-h-${CSS.escape(slugify(frag))}"]`);
      if (el) el.scrollIntoView({ block: 'start' });
      else this.host.notify(`Ancre introuvable : ${href}`);
      return;
    }
    if (/^(https?:|mailto:)/i.test(href)) {
      this.host.openExternal(href);
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) {
      this.host.notify(`Lien non pris en charge : ${href}`);
      return;
    }
    const path = this.baseDir ? resolveLocal(this.baseDir, href, this.sep) : null;
    if (path) this.host.openPath(path);
    else this.host.notify('Enregistrez le document pour suivre les liens relatifs.');
  }

  /** Aligne l'aperçu sur une ligne source (base 0). */
  syncToLine(line: number): void {
    const blocks = this.body.querySelectorAll<HTMLElement>('[data-line]');
    let best: HTMLElement | null = null;
    for (const b of blocks) {
      if (Number(b.dataset.line) <= line) best = b;
      else break;
    }
    if (best) this.root.scrollTop = best.offsetTop - 8;
    else this.root.scrollTop = 0;
  }

  scrollToHeading(line: number): void {
    const el = this.body.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (el) this.root.scrollTop = el.offsetTop - 8;
  }

  clearCache(): void {
    for (const u of this.images.values()) URL.revokeObjectURL(u);
    this.images.clear();
    clear(this.body);
    this.seq++;
  }
}
