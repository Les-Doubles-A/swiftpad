// Petits utilitaires DOM (aucun framework).

type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  title?: string;
  id?: string;
  role?: string;
  tabIndex?: number;
  type?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  hidden?: boolean;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  dataset?: Record<string, string>;
  on?: { [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void };
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.text != null) el.textContent = props.text;
    if (props.title) el.title = props.title;
    if (props.id) el.id = props.id;
    if (props.role) el.setAttribute('role', props.role);
    if (props.tabIndex != null) el.tabIndex = props.tabIndex;
    if (props.type) el.setAttribute('type', props.type);
    if (props.value != null) (el as any).value = props.value;
    if (props.placeholder) el.setAttribute('placeholder', props.placeholder);
    if (props.disabled) (el as any).disabled = true;
    if (props.hidden) el.hidden = true;
    if (props.attrs) {
      for (const [k, v] of Object.entries(props.attrs)) {
        if (v === null || v === undefined || v === false) continue;
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (props.dataset) Object.assign(el.dataset, props.dataset);
    if (props.on) {
      for (const [k, fn] of Object.entries(props.on)) el.addEventListener(k, fn as EventListener);
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function toggleClass(el: Element, cls: string, on: boolean): void {
  el.classList.toggle(cls, on);
}

/** Taille lisible (« 1,5 Ko »), comme l'Explorateur Windows. */
export function humanSize(n: number): string {
  if (n < 1024) return `${n} octet${n > 1 ? 's' : ''}`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });
export function formatDate(ms: number): string {
  if (!ms) return '';
  try {
    return dateFmt.format(new Date(ms));
  } catch {
    return '';
  }
}

export function isMac(): boolean {
  return /Mac/.test(navigator.platform);
}

/** Identifiant aléatoire court (onglets, copies de récupération). */
export function randomId(prefix = 'd'): string {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return `${prefix}-${a[0].toString(36)}${a[1].toString(36)}`;
}

/** Copie de texte dans le presse-papiers, avec repli si l'API est refusée. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Mesure la largeur d'un texte dans une police donnée. */
let canvas: HTMLCanvasElement | null = null;
export function measureText(text: string, font: string): number {
  if (!canvas) canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return text.length * 8;
  ctx.font = font;
  return ctx.measureText(text).width;
}

export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/** Cède la main à la boucle d'événements (traitements découpés). */
export function yieldToUi(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
