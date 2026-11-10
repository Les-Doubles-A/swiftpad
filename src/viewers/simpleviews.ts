// Aperçu d'image et fiche d'un fichier non textuel.

import { h, clear, humanSize, formatDate } from '../ui/dom';
import { icon } from '../ui/icons';
import type { Doc } from '../workspace/doc';
import { SAFE_DEFAULT_APP_EXTS, extOf } from '../workspace/doc';

export class ImageView {
  readonly root: HTMLElement;
  private img: HTMLImageElement;
  private meta: HTMLElement;
  private fit = true;

  constructor() {
    this.img = h('img', { class: 'img-view', attrs: { alt: '' } });
    this.meta = h('span', { class: 'img-meta' });
    const toggle = h('button', { class: 'btn btn-small', type: 'button', text: 'Taille réelle' });
    toggle.addEventListener('click', () => {
      this.fit = !this.fit;
      this.root.classList.toggle('fit', this.fit);
      toggle.textContent = this.fit ? 'Taille réelle' : 'Ajuster à la fenêtre';
    });
    this.root = h('div', { class: 'imageview fit' }, h('div', { class: 'img-bar' }, this.meta, h('span', { class: 'spacer' }), toggle), h('div', { class: 'img-stage', tabIndex: 0 }, this.img));
    this.img.addEventListener('load', () => this.updateMeta());
  }

  private current: Doc | null = null;

  attach(doc: Doc): void {
    this.current = doc;
    this.img.alt = doc.name;
    this.img.src = doc.imageUrl ?? '';
    this.updateMeta();
  }

  private updateMeta(): void {
    const d = this.current;
    if (!d) return;
    const dims = this.img.naturalWidth ? `${this.img.naturalWidth} × ${this.img.naturalHeight} px · ` : '';
    this.meta.textContent = `${dims}${humanSize(d.imageInfo?.size ?? 0)}${d.imageInfo?.mime === 'image/svg+xml' ? ' · SVG affiché comme image (scripts désactivés)' : ''}`;
  }

  detach(): void {
    this.current = null;
    this.img.removeAttribute('src');
  }
}

export interface InfoHost {
  openAsText(doc: Doc): void;
  openWithDefault(doc: Doc): void;
  reveal(doc: Doc): void;
}

export class InfoView {
  readonly root: HTMLElement;
  private host: InfoHost;

  constructor(host: InfoHost) {
    this.host = host;
    this.root = h('div', { class: 'infoview' });
  }

  attach(doc: Doc): void {
    clear(this.root);
    const info = doc.info ?? {};
    const rows: [string, string][] = [
      ['Type', info.reason ? `${info.reason}` : 'Fichier non textuel'],
      ['Taille', info.size != null ? `${humanSize(info.size)} (${Number(info.size).toLocaleString('fr-FR')} octets)` : '—'],
      ['Modifié le', formatDate(info.mtimeMs ?? 0) || '—'],
      ['Emplacement', doc.path ?? ''],
    ];
    const dl = h('dl', { class: 'info-list' });
    for (const [k, v] of rows) dl.append(h('dt', { text: k }), h('dd', { text: v }));
    const actions = h('div', { class: 'info-actions' });
    const asText = h('button', { class: 'btn', type: 'button', text: 'Ouvrir comme texte…' });
    asText.addEventListener('click', () => this.host.openAsText(doc));
    actions.append(asText);
    if (SAFE_DEFAULT_APP_EXTS.has(extOf(doc.name))) {
      const def = h('button', { class: 'btn', type: 'button', text: 'Ouvrir avec l’application par défaut' });
      def.addEventListener('click', () => this.host.openWithDefault(doc));
      actions.append(def);
    }
    const rev = h('button', { class: 'btn', type: 'button', text: 'Afficher dans l’Explorateur' });
    rev.addEventListener('click', () => this.host.reveal(doc));
    actions.append(rev);
    this.root.append(
      h('div', { class: 'info-card' }, h('div', { class: 'info-icon' }, icon('file')), h('h2', { class: 'info-title', text: doc.name }), h('p', { class: 'info-sub', text: 'Ce fichier ne semble pas contenir du texte. Il n’a pas été chargé : seuls ses métadonnées et au plus son premier mégaoctet ont été lus.' }), dl, actions),
    );
  }
}
