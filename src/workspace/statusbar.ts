// Barre d'état : informations du document actif, éléments masqués lorsqu'ils
// ne s'appliquent pas, message temporaire non intrusif.

import { h } from '../ui/dom';

export interface StatusItems {
  position?: string | null;
  stats?: string | null;
  lang?: string | null;
  encoding?: { label: string; uncertain: boolean; title: string } | null;
  eol?: { label: string; title: string } | null;
  state?: { label: string; kind: 'saved' | 'dirty' | 'readonly' | 'new' | 'missing' | 'info' } | null;
  zoom?: string | null;
}

export interface StatusHandlers {
  encoding(anchor: HTMLElement): void;
  eol(anchor: HTMLElement): void;
  zoom(): void;
  position(): void;
}

export class StatusBar {
  readonly root: HTMLElement;
  private msg: HTMLElement;
  private els: Record<string, HTMLElement>;
  private msgTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(handlers: StatusHandlers) {
    const btn = (cls: string, label: string, fn: (el: HTMLElement) => void) => {
      const b = h('button', { class: `sb-item sb-btn ${cls}`, type: 'button', attrs: { 'aria-label': label } });
      b.addEventListener('click', () => fn(b));
      return b;
    };
    this.msg = h('span', { class: 'sb-msg', role: 'status', attrs: { 'aria-live': 'polite' } });
    this.els = {
      position: btn('sb-pos', 'Aller à la ligne', () => handlers.position()),
      stats: h('span', { class: 'sb-item sb-stats' }),
      lang: h('span', { class: 'sb-item sb-lang' }),
      encoding: btn('sb-enc', 'Encodage', (el) => handlers.encoding(el)),
      eol: btn('sb-eol', 'Fins de ligne', (el) => handlers.eol(el)),
      state: h('span', { class: 'sb-item sb-state' }),
      zoom: btn('sb-zoom', 'Zoom (cliquer pour réinitialiser)', () => handlers.zoom()),
    };
    this.root = h(
      'footer',
      { class: 'statusbar', attrs: { 'aria-label': 'Barre d’état' } },
      this.msg,
      h('span', { class: 'spacer' }),
      this.els.position,
      this.els.stats,
      this.els.lang,
      this.els.encoding,
      this.els.eol,
      this.els.state,
      this.els.zoom,
    );
  }

  set(items: StatusItems): void {
    const setText = (key: string, v: string | null | undefined) => {
      const el = this.els[key];
      el.hidden = !v;
      if (v && el.textContent !== v) el.textContent = v;
    };
    setText('position', items.position);
    setText('stats', items.stats);
    setText('lang', items.lang);
    setText('zoom', items.zoom);
    const enc = this.els.encoding;
    enc.hidden = !items.encoding;
    if (items.encoding) {
      const t = items.encoding.uncertain ? `${items.encoding.label} (?)` : items.encoding.label;
      if (enc.textContent !== t) enc.textContent = t;
      enc.title = items.encoding.title;
      enc.classList.toggle('warn', items.encoding.uncertain);
    }
    const eol = this.els.eol;
    eol.hidden = !items.eol;
    if (items.eol) {
      if (eol.textContent !== items.eol.label) eol.textContent = items.eol.label;
      eol.title = items.eol.title;
    }
    const st = this.els.state;
    st.hidden = !items.state;
    if (items.state) {
      st.textContent = items.state.label;
      st.dataset.kind = items.state.kind;
    }
  }

  message(text: string, kind: 'info' | 'error' = 'info', ms = 5000): void {
    this.msg.textContent = text;
    this.msg.dataset.kind = kind;
    if (this.msgTimer) clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => {
      this.msg.textContent = '';
    }, ms);
  }
}
