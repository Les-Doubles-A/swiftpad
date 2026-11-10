// Barre de menus et menus contextuels (rôles ARIA menubar/menu/menuitem),
// entièrement utilisables au clavier.

import { h } from './dom';
import { icon } from './icons';
import { Commands, displayKey } from './commands';

export type MenuItem =
  | { type: 'command'; id: string; label?: string }
  | { type: 'action'; label: string; run: () => unknown; enabled?: boolean; checked?: boolean; key?: string; danger?: boolean }
  | { type: 'submenu'; label: string; items: () => MenuItem[]; enabled?: boolean }
  | { type: 'separator' }
  | { type: 'note'; label: string };

export const sep = (): MenuItem => ({ type: 'separator' });
export const cmd = (id: string, label?: string): MenuItem => ({ type: 'command', id, label });
export const act = (label: string, run: () => unknown, o: { enabled?: boolean; checked?: boolean; key?: string; danger?: boolean } = {}): MenuItem => ({
  type: 'action',
  label,
  run,
  ...o,
});
export const sub = (label: string, items: () => MenuItem[], enabled = true): MenuItem => ({ type: 'submenu', label, items, enabled });
export const note = (label: string): MenuItem => ({ type: 'note', label });

interface OpenMenu {
  el: HTMLElement;
  items: HTMLElement[];
  parent: OpenMenu | null;
  child: OpenMenu | null;
  owner?: HTMLElement;
}

let commandsRef: Commands | null = null;
export function setMenuCommands(c: Commands): void {
  commandsRef = c;
}

let current: OpenMenu | null = null;
let restoreFocus: HTMLElement | null = null;
let onCloseAll: (() => void) | null = null;

/** Libellé avec mnémonique « &Fichier » → F souligné (affiché avec Alt). */
function labelNode(label: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const i = label.indexOf('&');
  if (i < 0 || i === label.length - 1) {
    frag.append(label);
    return frag;
  }
  frag.append(label.slice(0, i), h('span', { class: 'mnemonic', text: label[i + 1] }), label.slice(i + 2));
  return frag;
}

export function plainLabel(label: string): string {
  return label.replace('&', '');
}

function buildMenu(items: MenuItem[], parent: OpenMenu | null): OpenMenu {
  const el = h('div', { class: 'menu', role: 'menu', attrs: { 'aria-orientation': 'vertical' } });
  const om: OpenMenu = { el, items: [], parent, child: null };
  for (const it of items) {
    if (it.type === 'separator') {
      el.append(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    if (it.type === 'note') {
      el.append(h('div', { class: 'menu-note', text: it.label }));
      continue;
    }
    let label = '';
    let key = '';
    let enabled = true;
    let checked: boolean | undefined;
    let danger = false;
    let run: (() => unknown) | null = null;
    let submenu: (() => MenuItem[]) | null = null;
    if (it.type === 'command') {
      const c = commandsRef!.get(it.id);
      label = it.label ?? c.label;
      key = c.keys?.[0] ? displayKey(c.keys[0]) : c.menuKey ? displayKey(c.menuKey) : '';
      enabled = c.enabled ? c.enabled() : true;
      checked = c.checked ? c.checked() : undefined;
      run = () => commandsRef!.run(it.id);
    } else if (it.type === 'action') {
      label = it.label;
      key = it.key ?? '';
      enabled = it.enabled ?? true;
      checked = it.checked;
      danger = !!it.danger;
      run = it.run;
    } else {
      label = it.label;
      enabled = it.enabled ?? true;
      submenu = it.items;
    }
    const row = h(
      'div',
      {
        class: `menu-item${danger ? ' danger' : ''}`,
        role: checked !== undefined ? 'menuitemcheckbox' : 'menuitem',
        tabIndex: -1,
        attrs: {
          'aria-disabled': enabled ? null : 'true',
          'aria-checked': checked !== undefined ? String(checked) : null,
          'aria-haspopup': submenu ? 'menu' : null,
          'aria-keyshortcuts': key || null,
        },
      },
      h('span', { class: 'menu-check' }, checked ? icon('check') : null),
      h('span', { class: 'menu-label' }, labelNode(label)),
      h('span', { class: 'menu-key', text: key }),
      h('span', { class: 'menu-arrow' }, submenu ? icon('chevronRight') : null),
    );
    const activate = () => {
      if (!enabled) return;
      if (submenu) {
        openSubmenu(om, row, submenu());
        return;
      }
      closeAll();
      // Laisse le menu se fermer et le focus revenir avant d'agir.
      setTimeout(() => run && run(), 0);
    };
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      activate();
    });
    row.addEventListener('mouseenter', () => {
      if (enabled) row.focus();
      if (om.child && om.child.owner !== row) closeMenu(om.child);
      if (submenu && enabled) openSubmenu(om, row, submenu());
    });
    (row as any)._activate = activate;
    (row as any)._submenu = !!submenu;
    (row as any)._enabled = enabled;
    om.items.push(row);
    el.append(row);
  }
  el.addEventListener('keydown', (e) => onMenuKey(om, e));
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  return om;
}

function position(el: HTMLElement, x: number, y: number, altX?: number): void {
  el.style.left = '0px';
  el.style.top = '0px';
  document.body.append(el);
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = x;
  if (left + r.width > vw - 4) left = altX !== undefined ? Math.max(4, altX - r.width) : Math.max(4, vw - r.width - 4);
  let top = y;
  if (top + r.height > vh - 4) top = Math.max(4, vh - r.height - 4);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function focusItem(om: OpenMenu, idx: number, dir = 1): void {
  const n = om.items.length;
  if (n === 0) return;
  for (let k = 0; k < n; k++) {
    const i = (((idx + k * dir) % n) + n) % n;
    if ((om.items[i] as any)._enabled) {
      om.items[i].focus();
      return;
    }
  }
  om.items[0].focus();
}

function openSubmenu(parent: OpenMenu, row: HTMLElement, items: MenuItem[]): void {
  if (parent.child && parent.child.owner === row) return;
  if (parent.child) closeMenu(parent.child);
  const om = buildMenu(items, parent);
  om.owner = row;
  parent.child = om;
  row.setAttribute('aria-expanded', 'true');
  const r = row.getBoundingClientRect();
  position(om.el, r.right - 2, r.top - 4, r.left + 2);
}

function closeMenu(om: OpenMenu): void {
  if (om.child) closeMenu(om.child);
  om.el.remove();
  if (om.owner) om.owner.removeAttribute('aria-expanded');
  if (om.parent) om.parent.child = null;
}

export function closeAll(focusBack = true): void {
  if (!current) return;
  const top = current;
  current = null;
  closeMenu(top);
  document.removeEventListener('mousedown', onOutside, true);
  window.removeEventListener('blur', onBlur);
  window.removeEventListener('resize', onBlur);
  const cb = onCloseAll;
  onCloseAll = null;
  cb?.();
  if (focusBack && restoreFocus && document.contains(restoreFocus)) restoreFocus.focus();
  restoreFocus = null;
}

function onOutside(e: MouseEvent): void {
  let om: OpenMenu | null = current;
  while (om) {
    if (om.el.contains(e.target as Node)) return;
    om = om.child;
  }
  if ((e.target as HTMLElement).closest?.('.menubar-item')) return;
  closeAll(false);
}

function onBlur(): void {
  closeAll(false);
}

function onMenuKey(om: OpenMenu, e: KeyboardEvent): void {
  const idx = om.items.indexOf(document.activeElement as HTMLElement);
  e.stopPropagation();
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      focusItem(om, idx + 1, 1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      focusItem(om, idx < 0 ? om.items.length - 1 : idx - 1, -1);
      break;
    case 'Home':
      e.preventDefault();
      focusItem(om, 0, 1);
      break;
    case 'End':
      e.preventDefault();
      focusItem(om, om.items.length - 1, -1);
      break;
    case 'ArrowRight': {
      e.preventDefault();
      const row = om.items[idx];
      if (row && (row as any)._submenu) {
        (row as any)._activate();
        if (om.child) focusItem(om.child, 0, 1);
      } else if (!om.parent && menubarNav) menubarNav(1);
      break;
    }
    case 'ArrowLeft':
      e.preventDefault();
      if (om.parent) {
        const owner = om.owner;
        closeMenu(om);
        owner?.focus();
      } else if (menubarNav) menubarNav(-1);
      break;
    case 'Enter':
    case ' ':
      e.preventDefault();
      if (idx >= 0) {
        (om.items[idx] as any)._activate();
        if (om.child) focusItem(om.child, 0, 1);
      }
      break;
    case 'Escape':
      e.preventDefault();
      if (om.parent) {
        const owner = om.owner;
        closeMenu(om);
        owner?.focus();
      } else {
        const back = menubarOwner;
        closeAll(!back);
        back?.focus();
      }
      break;
    case 'Tab':
      e.preventDefault();
      closeAll();
      break;
    default:
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
        const ch = e.key.toLowerCase();
        const start = idx + 1;
        for (let k = 0; k < om.items.length; k++) {
          const i = (start + k) % om.items.length;
          const text = om.items[i].querySelector('.menu-label')?.textContent?.toLowerCase() ?? '';
          const mn = om.items[i].querySelector('.mnemonic')?.textContent?.toLowerCase();
          if ((mn === ch || text.startsWith(ch)) && (om.items[i] as any)._enabled) {
            om.items[i].focus();
            if (mn === ch) (om.items[i] as any)._activate();
            break;
          }
        }
      }
  }
}

function openRoot(items: MenuItem[], x: number, y: number, focusFirst: boolean, owner?: HTMLElement): OpenMenu {
  closeAll(false);
  const om = buildMenu(items, null);
  om.owner = owner;
  current = om;
  position(om.el, x, y);
  document.addEventListener('mousedown', onOutside, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onBlur);
  if (focusFirst) focusItem(om, 0, 1);
  else om.el.focus();
  return om;
}

/** Menu contextuel à une position (clic droit, Maj+F10, touche Menu). */
export function showContextMenu(items: MenuItem[], x: number, y: number, focusAfter?: HTMLElement | null): void {
  const prev = (focusAfter ?? document.activeElement) as HTMLElement | null;
  menubarOwner = null;
  openRoot(items, x, y, true);
  restoreFocus = prev;
}

export function menuIsOpen(): boolean {
  return current !== null;
}

// --- barre de menus --------------------------------------------------------

let menubarNav: ((dir: number) => void) | null = null;
let menubarOwner: HTMLElement | null = null;

export interface TopMenu {
  label: string;
  items: () => MenuItem[];
}

export function createMenubar(menus: TopMenu[]): HTMLElement {
  const bar = h('div', { class: 'menubar', role: 'menubar', attrs: { 'aria-label': 'Menu principal' } });
  const buttons: HTMLElement[] = [];
  let openIndex = -1;
  const open = (i: number, focusFirst: boolean) => {
    const prevFocus = restoreFocus ?? (document.activeElement as HTMLElement | null);
    const btn = buttons[i];
    const r = btn.getBoundingClientRect();
    openRoot(menus[i].items(), r.left, r.bottom + 2, focusFirst, btn);
    restoreFocus = prevFocus && !prevFocus.classList.contains('menubar-item') ? prevFocus : restoreFocus;
    menubarOwner = btn;
    openIndex = i;
    buttons.forEach((b, j) => b.setAttribute('aria-expanded', String(j === i)));
    onCloseAll = () => {
      openIndex = -1;
      buttons.forEach((b) => b.setAttribute('aria-expanded', 'false'));
      menubarOwner = null;
    };
  };
  menubarNav = (dir) => {
    const i = openIndex < 0 ? 0 : (openIndex + dir + buttons.length) % buttons.length;
    open(i, true);
  };
  menus.forEach((m, i) => {
    const btn = h('button', {
      class: 'menubar-item',
      role: 'menuitem',
      type: 'button',
      tabIndex: i === 0 ? 0 : -1,
      attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-mnemonic': (m.label.split('&')[1]?.[0] ?? '').toLowerCase() },
    });
    btn.append(labelNode(m.label));
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (openIndex === i) closeAll();
      else open(i, false);
    });
    btn.addEventListener('mouseenter', () => {
      if (openIndex >= 0 && openIndex !== i) open(i, false);
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const j = (i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[j].focus();
      } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(i, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        const back = restoreFocus;
        restoreFocus = null;
        (back ?? document.querySelector<HTMLElement>('.editor-text'))?.focus();
      }
    });
    btn.addEventListener('focus', () => {
      if (!restoreFocus) {
        const a = document.activeElement as HTMLElement | null;
        if (a && !a.classList.contains('menubar-item')) restoreFocus = a;
      }
    });
    buttons.push(btn);
    bar.append(btn);
  });
  // Alt+lettre : ouvre le menu correspondant ; F10 : active la barre.
  const showMnemonics = (on: boolean) => document.body.classList.toggle('show-mnemonics', on);
  let altAlone = false;
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Alt' && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        altAlone = true;
        showMnemonics(true);
        return;
      }
      altAlone = false;
      if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key.length === 1 && !(e.getModifierState && e.getModifierState('AltGraph'))) {
        const i = buttons.findIndex((b) => b.dataset.mnemonic === e.key.toLowerCase());
        if (i >= 0 && !document.querySelector('.dlg-backdrop')) {
          e.preventDefault();
          restoreFocus = document.activeElement as HTMLElement;
          open(i, true);
        }
      } else if (e.key === 'F10' && !e.shiftKey && !e.ctrlKey && !document.querySelector('.dlg-backdrop')) {
        e.preventDefault();
        restoreFocus = document.activeElement as HTMLElement;
        buttons[0].focus();
      }
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (e) => {
      if (e.key === 'Alt') {
        showMnemonics(false);
        if (altAlone && !current && !document.querySelector('.dlg-backdrop')) {
          // Alt seul (comme sous Windows) : bascule le focus vers la barre de menus.
          e.preventDefault();
          if (document.activeElement?.classList.contains('menubar-item')) {
            (restoreFocus ?? document.querySelector<HTMLElement>('.editor-text'))?.focus();
            restoreFocus = null;
          } else {
            restoreFocus = document.activeElement as HTMLElement;
            buttons[0].focus();
          }
        }
        altAlone = false;
      }
    },
    true,
  );
  window.addEventListener('blur', () => showMnemonics(false));
  return bar;
}
