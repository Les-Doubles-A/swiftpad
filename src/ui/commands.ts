// Registre des commandes et raccourcis clavier, avec contexte de focus.
//
// Règles de résolution d'un raccourci :
// 1. une commande liée au contexte actif (« editor ») passe avant une
//    commande globale portant le même raccourci ;
// 2. dans un champ de saisie (recherche, préférences…), seuls les
//    raccourcis marqués `inInput` s'appliquent : Ctrl+A/C/V/X/Z gardent leur
//    comportement natif ;
// 3. AltGr (Ctrl+Alt sous Windows en AZERTY : @ # { [ …) n'est jamais
//    interprété comme un raccourci.

export type Scope = 'global' | 'editor';

export interface Command {
  id: string;
  label: string;
  keys?: string[];
  /** Raccourci affiché seulement (géré nativement : Ctrl+C, Suppr…). */
  menuKey?: string;
  scope?: Scope;
  run: () => unknown;
  enabled?: () => boolean;
  checked?: () => boolean;
  inInput?: boolean;
  palette?: boolean;
  /** Texte d'aide (liste des raccourcis). */
  help?: string;
}

export type FocusContext = 'editor' | 'input' | 'other';

const DIGIT = /^Digit(\d)$|^Numpad(\d)$/;

/** Représentation normalisée d'un événement clavier : « Ctrl+Shift+S ». */
export function keyOf(e: KeyboardEvent): string | null {
  if (e.getModifierState && e.getModifierState('AltGraph')) return null;
  const k0 = e.key;
  if (k0 === 'Control' || k0 === 'Shift' || k0 === 'Alt' || k0 === 'Meta' || k0 === 'AltGraph' || k0 === 'Dead') return null;
  const parts: string[] = [];
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = k0;
  const d = DIGIT.exec(e.code);
  if (e.code === 'NumpadAdd' || k === '+' || (ctrl && k === '=')) k = 'Plus';
  else if (e.code === 'NumpadSubtract' || k === '-' || (ctrl && e.code === 'Minus')) k = 'Minus';
  else if (d && (ctrl || e.altKey)) k = d[1] ?? d[2];
  else if (k === ' ') k = 'Space';
  else if (k.startsWith('Arrow')) k = k.slice(5);
  else if (k === 'Esc') k = 'Escape';
  else if (k.length === 1) k = k.toUpperCase();
  return [...parts, k].join('+');
}

export function focusContext(): FocusContext {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body) return 'other';
  if (a.classList.contains('editor-text')) return 'editor';
  const tag = a.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable) return 'input';
  return 'other';
}

/** Affichage d'un raccourci dans les menus. */
export function displayKey(k: string): string {
  return k.replace('Plus', '+').replace('Minus', '-').replace(/\bUp\b/, '↑').replace(/\bDown\b/, '↓').replace(/\bLeft\b/, '←').replace(/\bRight\b/, '→').replace('Ctrl', 'Ctrl').replace('Delete', 'Suppr').replace('Escape', 'Échap').replace('Shift', 'Maj').replace('Space', 'Espace').replace('Enter', 'Entrée').replace('Tab', 'Tab');
}

export class Commands {
  private byId = new Map<string, Command>();
  private byKey = new Map<string, Command[]>();

  register(cmd: Command): void {
    if (this.byId.has(cmd.id)) throw new Error(`Commande en double : ${cmd.id}`);
    this.byId.set(cmd.id, cmd);
    for (const k of cmd.keys ?? []) {
      const list = this.byKey.get(k) ?? [];
      list.push(cmd);
      this.byKey.set(k, list);
    }
  }

  get(id: string): Command {
    const c = this.byId.get(id);
    if (!c) throw new Error(`Commande inconnue : ${id}`);
    return c;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  isEnabled(id: string): boolean {
    const c = this.byId.get(id);
    return !!c && (c.enabled ? c.enabled() : true);
  }

  run(id: string): void {
    const c = this.get(id);
    if (c.enabled && !c.enabled()) return;
    try {
      const r = c.run();
      if (r instanceof Promise) r.catch((e) => console.error(`Commande ${id}`, e));
    } catch (e) {
      console.error(`Commande ${id}`, e);
    }
  }

  list(): Command[] {
    return [...this.byId.values()];
  }

  /** Commande correspondant à l'événement dans le contexte courant. */
  resolve(e: KeyboardEvent, ctx: FocusContext): Command | null {
    const k = keyOf(e);
    if (!k) return null;
    const list = this.byKey.get(k);
    if (!list) return null;
    const scoped = list.find((c) => c.scope && c.scope !== 'global' && c.scope === ctx);
    if (scoped) return scoped;
    const global = list.find((c) => !c.scope || c.scope === 'global');
    if (!global) return null;
    if (ctx === 'input' && !global.inInput) return null;
    return global;
  }

  /** Conflits : même raccourci et même portée sur deux commandes. */
  conflicts(): string[] {
    const out: string[] = [];
    for (const [k, list] of this.byKey) {
      const seen = new Map<string, string>();
      for (const c of list) {
        const s = c.scope ?? 'global';
        if (seen.has(s)) out.push(`${k} : ${seen.get(s)} / ${c.id} (${s})`);
        else seen.set(s, c.id);
      }
    }
    return out;
  }
}
