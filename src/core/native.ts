// Fonctions natives (boîtes de dialogue Windows, Explorateur, impression…)
// fournies par la couche Tauri. Hors de Tauri (harnais de test, navigateur),
// des remplacements simples sont utilisés.

import { isTauri } from './rpc';
import { promptText } from '../ui/dialog';

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return window.__TAURI__!.core.invoke<T>(cmd, args);
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export const TEXT_FILTERS: FileFilter[] = [
  { name: 'Documents texte', extensions: ['txt', 'md', 'markdown', 'log', 'text', 'csv', 'tsv'] },
  {
    name: 'Code et configuration',
    extensions: ['json', 'jsonc', 'xml', 'html', 'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'rs', 'c', 'cpp', 'h', 'java', 'sql', 'yaml', 'yml', 'toml', 'ini', 'conf', 'bat', 'cmd', 'ps1', 'sh'],
  },
  { name: 'Tous les fichiers', extensions: ['*'] },
];

export async function pickOpenFiles(directory?: string | null): Promise<string[] | null> {
  if (isTauri()) {
    return invoke<string[] | null>('dialog_open_files', { directory: directory ?? null, filters: TEXT_FILTERS });
  }
  const v = await promptText({ title: 'Ouvrir', label: 'Chemin complet du fichier (plusieurs : séparés par « ; »)', value: directory ? directory + '/' : '', validate: (s) => (s.trim() ? null : 'Indiquez un chemin.') });
  if (!v) return null;
  return v
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function pickSaveFile(directory: string | null, name: string): Promise<string | null> {
  if (isTauri()) {
    return invoke<string | null>('dialog_save_file', { directory, name, filters: TEXT_FILTERS });
  }
  const sep = directory?.includes('\\') ? '\\' : '/';
  const def = directory ? `${directory.replace(/[\\/]$/, '')}${sep}${name}` : name;
  const v = await promptText({ title: 'Enregistrer sous', label: 'Chemin complet du fichier', value: def, okLabel: 'Enregistrer', validate: (s) => (s.trim() ? null : 'Indiquez un chemin.') });
  return v ? v.trim() : null;
}

/** Affiche l'élément sélectionné dans l'Explorateur Windows. */
export async function revealInExplorer(path: string): Promise<void> {
  if (isTauri()) await invoke('reveal_path', { path });
  else throw new Error('Disponible uniquement dans l’application installée.');
}

/** Ouvre un fichier inerte (PDF, image…) avec l'application par défaut. */
export async function openWithDefaultApp(path: string): Promise<void> {
  if (isTauri()) await invoke('open_with_default', { path });
  else throw new Error('Disponible uniquement dans l’application installée.');
}

/** Ouvre un lien http(s) ou mailto dans le navigateur par défaut. */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) await invoke('open_url', { url });
  else window.open(url, '_blank', 'noopener,noreferrer');
}

export async function printPage(): Promise<void> {
  if (isTauri()) {
    try {
      await invoke('print_page');
      return;
    } catch {
      /* repli sur l'impression du navigateur */
    }
  }
  window.print();
}

/** Interface dessinée : la fenêtre (créée masquée) peut s'afficher. */
export async function notifyReady(): Promise<void> {
  if (isTauri()) await invoke('app_ready').catch(() => {});
}

/** Accusé de réception d'une demande de fermeture (l'interface répond). */
export async function closeAck(): Promise<void> {
  if (isTauri()) await invoke('close_ack').catch(() => {});
}

export async function setWindowTitle(title: string): Promise<void> {
  if (isTauri()) {
    try {
      await invoke('set_title', { title });
    } catch {
      /* titre facultatif */
    }
  }
}

/** Thème de la fenêtre native (barre de titre ; « system » suit Windows).
 *  Renvoie le thème effectif (« light » ou « dark »), ou null hors de Tauri
 *  ou en cas d'échec (l'interface garde alors le suivi par CSS). */
export async function setWindowTheme(theme: string): Promise<'light' | 'dark' | null> {
  if (!isTauri()) return null;
  try {
    const r = await invoke<string>('set_theme', { theme });
    return r === 'dark' || r === 'light' ? r : null;
  } catch {
    return null;
  }
}

/** Fermeture confirmée par l'interface (modifications traitées). */
export async function closeWindowConfirmed(): Promise<void> {
  if (isTauri()) await invoke('close_confirmed');
}

/** Événements émis par la couche native. */
export async function onNativeEvent<T>(name: 'open-files' | 'close-requested' | 'theme-changed', fn: (payload: T) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  return window.__TAURI__!.event.listen<T>(`swiftpad://${name}`, (e) => fn(e.payload));
}
