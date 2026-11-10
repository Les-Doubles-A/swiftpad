// Barre d'onglets : activation, fermeture, réorganisation au pointeur,
// navigation au clavier (rôles ARIA tablist/tab).

import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import type { Doc } from './doc';

export interface TabCallbacks {
  activate(doc: Doc): void;
  close(doc: Doc): void;
  reorder(doc: Doc, toIndex: number): void;
  contextMenu(doc: Doc, x: number, y: number): void;
  newTab(): void;
}

export class TabBar {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private cb: TabCallbacks;
  private els = new Map<string, HTMLElement>();
  private drag: { doc: Doc; startX: number; active: boolean; pointerId: number; target: number } | null = null;
  private indicator: HTMLElement;

  constructor(cb: TabCallbacks) {
    this.cb = cb;
    this.list = h('div', { class: 'tabs', role: 'tablist', attrs: { 'aria-label': 'Documents ouverts' } });
    const plus = h('button', { class: 'tab-new', type: 'button', title: 'Nouveau document (Ctrl+N)', attrs: { 'aria-label': 'Nouveau document' } }, icon('plus'));
    plus.addEventListener('click', () => cb.newTab());
    this.indicator = h('div', { class: 'tab-drop', hidden: true });
    this.root = h('div', { class: 'tabbar' }, this.list, plus, this.indicator);
    this.list.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        this.list.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
  }

  render(docs: Doc[], active: Doc | null): void {
    // Onglets discrets : la barre n'apparaît qu'à partir de deux documents.
    this.root.classList.toggle('lone', docs.length <= 1);
    const keep = new Set(docs.map((d) => d.id));
    for (const [id, el] of this.els) {
      if (!keep.has(id)) {
        el.remove();
        this.els.delete(id);
      }
    }
    docs.forEach((d, i) => {
      let el = this.els.get(d.id);
      if (!el) {
        el = this.create(d);
        this.els.set(d.id, el);
      }
      this.update(el, d, d === active);
      if (this.list.children[i] !== el) this.list.insertBefore(el, this.list.children[i] ?? null);
    });
    const act = active ? this.els.get(active.id) : null;
    if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private create(d: Doc): HTMLElement {
    const close = h('button', { class: 'tab-close', type: 'button', tabIndex: -1, attrs: { 'aria-label': 'Fermer' } }, icon('close'));
    const el = h(
      'div',
      { class: 'tab', role: 'tab', tabIndex: -1, dataset: { id: d.id } },
      h('span', { class: 'tab-name' }),
      h('span', { class: 'tab-state' }),
      close,
    );
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cb.close(d);
    });
    close.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('pointerdown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      this.cb.activate(d);
      this.drag = { doc: d, startX: e.clientX, active: false, pointerId: e.pointerId, target: -1 };
      el.setPointerCapture(e.pointerId);
    });
    // Un clic sur un onglet laisse le focus dans l'éditeur (comme les éditeurs
    // usuels) ; la navigation au clavier dans les onglets reste possible (F6).
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('pointermove', (e) => this.onDragMove(e));
    el.addEventListener('pointerup', (e) => this.onDragEnd(e));
    el.addEventListener('pointercancel', () => this.cancelDrag());
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.cb.close(d);
      }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.cb.contextMenu(d, e.clientX, e.clientY);
    });
    el.addEventListener('keydown', (e) => {
      const tabs = [...this.list.children] as HTMLElement[];
      const i = tabs.indexOf(el);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const j = (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[j]?.focus();
        tabs[j]?.dispatchEvent(new Event('tab-activate'));
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const t = e.key === 'Home' ? tabs[0] : tabs[tabs.length - 1];
        t?.focus();
        t?.dispatchEvent(new Event('tab-activate'));
      } else if (e.key === 'Delete') {
        e.preventDefault();
        this.cb.close(d);
      } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        this.cb.contextMenu(d, r.left + 8, r.bottom);
      }
    });
    el.addEventListener('tab-activate', () => this.cb.activate(d));
    return el;
  }

  private update(el: HTMLElement, d: Doc, active: boolean): void {
    el.setAttribute('aria-selected', String(active));
    el.tabIndex = active ? 0 : -1;
    el.classList.toggle('active', active);
    el.classList.toggle('dirty', d.dirty);
    el.classList.toggle('missing', d.external === 'deleted');
    el.querySelector('.tab-name')!.textContent = d.name;
    const state = el.querySelector('.tab-state')!;
    state.textContent = d.dirty ? '●' : '';
    const tip = [d.path ?? `${d.name} (non enregistré)`];
    if (d.dirty) tip.push('Modifications non enregistrées');
    if (d.external === 'deleted') tip.push('Fichier supprimé ou déplacé');
    if (d.readOnlyView) tip.push('Lecture seule');
    el.title = tip.join('\n');
    el.setAttribute('aria-label', `${d.name}${d.dirty ? ', modifié' : ''}${d.external === 'deleted' ? ', fichier introuvable' : ''}`);
  }

  focusActive(): void {
    (this.list.querySelector('.tab.active') as HTMLElement | null)?.focus();
  }

  private onDragMove(e: PointerEvent): void {
    const dr = this.drag;
    if (!dr || dr.pointerId !== e.pointerId) return;
    if (!dr.active && Math.abs(e.clientX - dr.startX) > 6) {
      dr.active = true;
      this.root.classList.add('dragging');
    }
    if (!dr.active) return;
    const tabs = [...this.list.children] as HTMLElement[];
    let target = tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) {
        target = i;
        break;
      }
    }
    dr.target = target;
    const ref = tabs[Math.min(target, tabs.length - 1)];
    if (ref) {
      const r = ref.getBoundingClientRect();
      const host = this.root.getBoundingClientRect();
      const x = target >= tabs.length ? r.right : r.left;
      this.indicator.hidden = false;
      this.indicator.style.transform = `translateX(${Math.round(x - host.left - 1)}px)`;
    }
  }

  private onDragEnd(e: PointerEvent): void {
    const dr = this.drag;
    if (!dr || dr.pointerId !== e.pointerId) return;
    if (dr.active && dr.target >= 0) {
      const tabs = [...this.list.children] as HTMLElement[];
      const from = tabs.findIndex((t) => t.dataset.id === dr.doc.id);
      let to = dr.target;
      if (to > from) to -= 1;
      if (to !== from) this.cb.reorder(dr.doc, to);
    }
    this.cancelDrag();
  }

  private cancelDrag(): void {
    this.drag = null;
    this.indicator.hidden = true;
    this.root.classList.remove('dragging');
  }
}
