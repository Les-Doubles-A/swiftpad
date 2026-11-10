// API globale injectée par Tauri (`app.withGlobalTauri = true`). Seules les
// fonctions utilisées par SwiftPad sont déclarées : aucune dépendance npm à
// @tauri-apps/api n'est nécessaire.
interface TauriGlobal {
  core: {
    invoke<T = unknown>(cmd: string, args?: unknown, options?: unknown): Promise<T>;
  };
  event: {
    listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>;
  };
}

interface Window {
  __TAURI__?: TauriGlobal;
  /** Données de démarrage injectées par la couche native avant tout script. */
  __SWIFTPAD_BOOT__?: unknown;
  /** Accès de test (harnais uniquement). */
  __swiftpad?: unknown;
}

interface ImportMeta {
  readonly env: { readonly DEV: boolean };
}

declare module '*.css';
