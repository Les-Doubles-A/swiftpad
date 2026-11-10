// Paramètres : copie locale des valeurs validées par le noyau, notification
// des changements et enregistrement différé (le noyau revalide tout).

import { rpc, errorMessage } from './rpc';
import { debounce } from './events';

type Listener = (key: string, value: unknown) => void;

export class Settings {
  private data: any;
  private listeners = new Set<Listener>();
  private saveLater = debounce(() => void this.saveNow(), 400);
  onError: (msg: string) => void = () => {};

  constructor(initial: any) {
    this.data = initial ?? {};
  }

  get<T = any>(dotted: string): T {
    let cur: any = this.data;
    for (const part of dotted.split('.')) {
      if (cur == null || typeof cur !== 'object') return undefined as T;
      cur = cur[part];
    }
    return cur as T;
  }

  set(dotted: string, value: unknown, persist = true): void {
    const parts = dotted.split('.');
    let cur: any = this.data;
    for (const p of parts.slice(0, -1)) {
      if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
      cur = cur[p];
    }
    const last = parts[parts.length - 1];
    if (JSON.stringify(cur[last]) === JSON.stringify(value)) return;
    cur[last] = value;
    for (const l of [...this.listeners]) l(dotted, value);
    if (persist) this.saveLater();
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): any {
    return JSON.parse(JSON.stringify(this.data));
  }

  async saveNow(): Promise<void> {
    this.saveLater.cancel();
    try {
      const saved = await rpc('settings.save', { settings: this.data });
      // Valeurs éventuellement corrigées par le noyau (bornes).
      if (saved && typeof saved === 'object') this.data = saved;
    } catch (e) {
      this.onError(`Impossible d'enregistrer les paramètres : ${errorMessage(e)}`);
    }
  }

  /** Remplace tout (réinitialisation), en conservant les fichiers récents. */
  async reset(defaults: any): Promise<void> {
    const recent = this.get('files.recent');
    this.data = defaults;
    this.data.files.recent = recent;
    for (const l of [...this.listeners]) l('*', null);
    await this.saveNow();
  }
}
