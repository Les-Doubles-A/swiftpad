// Palette : ouverture rapide (onglets ouverts, fichiers récents), commandes
// (« > »), ligne (« : »), titres (« # »).

import { h, clear } from './dom';
import { icon, fileIconName } from './icons';

export interface PaletteItem {
  label: string;
  detail?: string;
  hint?: string;
  icon?: string;
  run: () => unknown;
  score?: number;
}

export interface PaletteHost {
  openTabs(): { label: string; detail: string; run: () => void }[];
  recent(): string[];
  openPath(path: string): void;
  commands(): { label: string; key?: string; run: () => void; enabled: boolean }[];
  goToLine(line: number, col?: number): void;
  lineCount(): number;
  headings(): { level: number; text: string; line: number }[];
  goToHeading(line: number): void;
}

/** Score de correspondance approximative (sous-séquence), ou -1. */
export function fuzzy(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += 1 + (last === i - 1 ? 5 : 0) + (i === 0 || /[\\/._\- ]/.test(t[i - 1]) ? 8 : 0);
      last = i;
      qi++;
    }
  }
  return qi === q.length ? score - t.length / 50 : -1;
}

export class Palette {
  private root: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private items: PaletteItem[] = [];
  private sel = 0;
  private host: PaletteHost;
  private prevFocus: HTMLElement | null = null;

  constructor(host: PaletteHost) {
    this.host = host;
    this.input = h('input', { class: 'input palette-input', type: 'text', attrs: { 'aria-label': 'Rechercher un fichier ou une commande', spellcheck: 'false', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list' } });
    this.list = h('div', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
    this.root = h('div', { class: 'palette-backdrop', hidden: true }, h('div', { class: 'palette', role: 'dialog', attrs: { 'aria-label': 'Palette' } }, this.input, this.list));
    document.body.append(this.root);
    this.input.addEventListener('input', () => this.update());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') this.move(1);
      else if (e.key === 'ArrowUp') this.move(-1);
      else if (e.key === 'PageDown') this.move(10);
      else if (e.key === 'PageUp') this.move(-10);
      else if (e.key === 'Enter') this.accept(this.sel);
      else if (e.key === 'Escape') this.close();
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  open(prefix = ''): void {
    this.prevFocus = document.activeElement as HTMLElement | null;
    this.root.hidden = false;
    this.input.value = prefix;
    this.input.placeholder = 'Document ouvert ou récent · « > » commandes · « : » ligne · « # » titres';
    this.input.focus();
    this.update();
  }

  close(restore = true): void {
    this.root.hidden = true;
    if (restore && this.prevFocus && document.contains(this.prevFocus)) this.prevFocus.focus();
  }

  private move(d: number): void {
    if (!this.items.length) return;
    this.sel = Math.max(0, Math.min(this.items.length - 1, this.sel + d));
    this.draw();
  }

  private accept(i: number): void {
    const it = this.items[i];
    if (!it) return;
    this.close(false);
    setTimeout(() => it.run(), 0);
  }

  private update(): void {
    const v = this.input.value;
    if (v.startsWith('>')) {
      const q = v.slice(1).trim();
      this.items = this.host
        .commands()
        .filter((c) => c.enabled)
        .map((c) => ({ label: c.label, hint: c.key, icon: 'more', run: c.run, score: fuzzy(q, c.label) }))
        .filter((c) => c.score! >= 0)
        .sort((a, b) => b.score! - a.score!);
    } else if (v.startsWith(':')) {
      const m = /^:\s*(\d+)?(?::(\d+))?/.exec(v);
      const n = this.host.lineCount();
      const line = m?.[1] ? Number(m[1]) : 0;
      this.items = line
        ? [{ label: `Aller à la ligne ${line}${m?.[2] ? `, colonne ${m[2]}` : ''}`, detail: `sur ${n.toLocaleString('fr-FR')}`, icon: 'goto', run: () => this.host.goToLine(Math.min(line, n), m?.[2] ? Number(m[2]) : undefined) }]
        : [{ label: `Saisissez un numéro de ligne (1 à ${n.toLocaleString('fr-FR')})`, icon: 'goto', run: () => {} }];
    } else if (v.startsWith('#')) {
      const q = v.slice(1).trim();
      this.items = this.host
        .headings()
        .map((hd) => ({ label: `${'  '.repeat(hd.level - 1)}${hd.text}`, detail: `ligne ${hd.line + 1}`, icon: 'list', run: () => this.host.goToHeading(hd.line), score: fuzzy(q, hd.text) }))
        .filter((x) => x.score! >= 0);
      if (!this.items.length) this.items = [{ label: 'Aucun titre (document Markdown requis)', run: () => {} }];
    } else {
      const q = v.trim();
      const seen = new Set<string>();
      const out: PaletteItem[] = [];
      for (const t of this.host.openTabs()) {
        const s = fuzzy(q, t.label);
        if (s < 0) continue;
        seen.add(t.detail.toLowerCase());
        out.push({ label: t.label, detail: t.detail, hint: 'onglet', icon: fileIconName(t.label, false), run: t.run, score: s + 1000 });
      }
      for (const p of this.host.recent()) {
        if (seen.has(p.toLowerCase())) continue;
        const name = p.split(/[\\/]/).pop() ?? p;
        const s = fuzzy(q, name);
        if (s < 0) continue;
        seen.add(p.toLowerCase());
        out.push({ label: name, detail: p, hint: 'récent', icon: fileIconName(name, false), run: () => this.host.openPath(p), score: s + 500 });
      }
      this.items = out.sort((a, b) => b.score! - a.score!).slice(0, 50);
      if (!this.items.length) this.items = [{ label: q ? 'Aucun document ouvert ni récent de ce nom' : 'Aucun document récent', detail: 'Ctrl+O pour ouvrir un fichier', run: () => {} }];
    }
    this.sel = 0;
    this.draw();
  }

  private draw(): void {
    clear(this.list);
    if (!this.items.length) {
      this.list.append(h('div', { class: 'palette-empty', text: 'Aucun résultat' }));
      return;
    }
    this.items.slice(0, 150).forEach((it, i) => {
      const el = h(
        'div',
        { class: `palette-item${i === this.sel ? ' sel' : ''}`, role: 'option', id: `pal-${i}`, attrs: { 'aria-selected': String(i === this.sel) } },
        it.icon ? icon(it.icon) : null,
        h('span', { class: 'palette-label', text: it.label }),
        it.detail ? h('span', { class: 'palette-detail', text: it.detail }) : null,
        it.hint ? h('span', { class: 'palette-hint', text: it.hint }) : null,
      );
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.accept(i);
      });
      this.list.append(el);
    });
    this.input.setAttribute('aria-activedescendant', `pal-${this.sel}`);
    this.list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }
}
