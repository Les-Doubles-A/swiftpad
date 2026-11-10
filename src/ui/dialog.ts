// Boîtes de dialogue modales accessibles : focus piégé, Échap = annuler,
// Entrée = action principale, focus rendu à l'élément d'origine.

import { h } from './dom';

export interface Button {
  id: string;
  label: string;
  kind?: 'primary' | 'danger' | 'default';
}

let openCount = 0;
export function dialogOpen(): boolean {
  return openCount > 0;
}

interface DialogHandle<T> {
  root: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  close(result: T): void;
  result: Promise<T>;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"]), a[href]')].filter(
    (el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null,
  );
}

export function openDialog<T>(opts: { title: string; cancelValue: T; alert?: boolean; wide?: boolean; className?: string }): DialogHandle<T> {
  const previous = document.activeElement as HTMLElement | null;
  const titleId = `dlg-title-${Math.random().toString(36).slice(2)}`;
  const body = h('div', { class: 'dlg-body' });
  const footer = h('div', { class: 'dlg-footer' });
  const box = h(
    'div',
    {
      class: `dlg ${opts.wide ? 'dlg-wide' : ''} ${opts.className ?? ''}`,
      role: opts.alert ? 'alertdialog' : 'dialog',
      attrs: { 'aria-modal': 'true', 'aria-labelledby': titleId },
    },
    h('h2', { class: 'dlg-title', id: titleId, text: opts.title }),
    body,
    footer,
  );
  const root = h('div', { class: 'dlg-backdrop' }, box);
  let resolve!: (v: T) => void;
  const result = new Promise<T>((r) => (resolve = r));
  let closed = false;
  const close = (v: T) => {
    if (closed) return;
    closed = true;
    openCount--;
    root.remove();
    if (previous && document.contains(previous)) previous.focus();
    resolve(v);
  };
  // Écouteur en phase de remontée sur la boîte elle-même : les champs
  // reçoivent d'abord leurs touches (Entrée valide une saisie), puis la
  // propagation s'arrête ici (aucun raccourci global sous une boîte modale).
  // Non-régression : un écouteur en capture sur le document empêchait Entrée
  // d'atteindre le champ de saisie.
  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(opts.cancelValue);
    } else if (e.key === 'Tab') {
      const f = focusables(box);
      if (f.length === 0) return;
      const i = f.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 ? 0 : i + 1;
      f[next].focus();
    }
    // Les raccourcis globaux ne s'appliquent pas sous une boîte modale.
    e.stopPropagation();
  };
  root.addEventListener('keydown', onKey);
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) e.preventDefault();
  });
  document.body.append(root);
  openCount++;
  return { root, body, footer, close, result };
}

function addButtons<T extends string>(d: DialogHandle<T>, buttons: Button[], defaultId?: string): HTMLButtonElement | null {
  let def: HTMLButtonElement | null = null;
  for (const b of buttons) {
    const btn = h('button', { class: `btn ${b.kind === 'primary' ? 'btn-primary' : b.kind === 'danger' ? 'btn-danger' : ''}`, text: b.label, type: 'button' });
    btn.addEventListener('click', () => d.close(b.id as T));
    d.footer.append(btn);
    if (b.id === defaultId || (!defaultId && b.kind === 'primary' && !def)) def = btn;
  }
  return def;
}

/** Question à choix (boutons). Échap renvoie `cancelId`. */
export function ask(opts: { title: string; message: string; detail?: string; buttons: Button[]; cancelId: string; defaultId?: string; list?: string[] }): Promise<string> {
  const d = openDialog<string>({ title: opts.title, cancelValue: opts.cancelId, alert: true });
  d.body.append(h('p', { class: 'dlg-msg', text: opts.message }));
  if (opts.list?.length) {
    const ul = h('ul', { class: 'dlg-list' });
    for (const item of opts.list.slice(0, 12)) ul.append(h('li', { text: item }));
    if (opts.list.length > 12) ul.append(h('li', { text: `… et ${opts.list.length - 12} autre(s)` }));
    d.body.append(ul);
  }
  if (opts.detail) d.body.append(h('p', { class: 'dlg-detail', text: opts.detail }));
  const def = addButtons(d, opts.buttons, opts.defaultId);
  (def ?? d.footer.querySelector('button'))?.focus();
  return d.result;
}

export function alertMsg(title: string, message: string, detail?: string): Promise<string> {
  return ask({ title, message, detail, buttons: [{ id: 'ok', label: 'OK', kind: 'primary' }], cancelId: 'ok' });
}

export function confirmDanger(title: string, message: string, okLabel: string, detail?: string): Promise<boolean> {
  return ask({
    title,
    message,
    detail,
    buttons: [
      { id: 'ok', label: okLabel, kind: 'danger' },
      { id: 'cancel', label: 'Annuler', kind: 'default' },
    ],
    cancelId: 'cancel',
    defaultId: 'cancel',
  }).then((r) => r === 'ok');
}

/** Saisie d'un texte, avec validation immédiate. `null` = annulé. */
export function promptText(opts: {
  title: string;
  label: string;
  value?: string;
  okLabel?: string;
  placeholder?: string;
  select?: [number, number];
  validate?: (v: string) => string | null;
  hint?: string;
}): Promise<string | null> {
  const d = openDialog<string | null>({ title: opts.title, cancelValue: null });
  const inputId = `dlg-in-${Math.random().toString(36).slice(2)}`;
  const input = h('input', { class: 'input', type: 'text', id: inputId, value: opts.value ?? '', placeholder: opts.placeholder, attrs: { spellcheck: 'false', autocomplete: 'off' } });
  const err = h('div', { class: 'dlg-error', role: 'alert' });
  d.body.append(h('label', { class: 'dlg-label', text: opts.label, attrs: { for: inputId } }), input, err);
  if (opts.hint) d.body.append(h('p', { class: 'dlg-detail', text: opts.hint }));
  const ok = h('button', { class: 'btn btn-primary', type: 'button', text: opts.okLabel ?? 'OK' });
  const cancel = h('button', { class: 'btn', type: 'button', text: 'Annuler' });
  d.footer.append(ok, cancel);
  const check = (silent = false) => {
    const msg = opts.validate ? opts.validate(input.value) : null;
    err.textContent = silent ? '' : (msg ?? '');
    ok.disabled = !!msg;
    input.setAttribute('aria-invalid', msg && !silent ? 'true' : 'false');
    return !msg;
  };
  input.addEventListener('input', () => check());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (check()) d.close(input.value);
    }
  });
  ok.addEventListener('click', () => {
    if (check()) d.close(input.value);
  });
  cancel.addEventListener('click', () => d.close(null));
  check(true);
  input.focus();
  if (opts.select) input.setSelectionRange(opts.select[0], opts.select[1]);
  else input.select();
  return d.result;
}
