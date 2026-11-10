// Point d'entrée : lit les données de démarrage (injectées par la couche
// native, ou demandées au noyau dans le harnais), construit l'interface et
// mesure les temps de démarrage.

import './styles/app.css';
import { rpc, isTauri } from './core/rpc';
import { notifyReady } from './core/native';
import { App, showFatal, type Boot } from './app';

export interface PerfInfo {
  /** Début du script → interface prête (session restaurée, fichiers ouverts). */
  scriptToReadyMs: number;
  /** Début de la navigation → interface prête. */
  navToReadyMs: number;
  /** Démarrage du processus natif (horloge murale, ms depuis 1970). */
  processStartMs: number | null;
  bootMs: number;
  /** Première image dessinée : la fenêtre (créée masquée) est affichée. */
  shownEpochMs: number | null;
  readyEpochMs: number;
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const root = document.getElementById('app')!;
  let boot = window.__SWIFTPAD_BOOT__ as Boot | undefined;
  if (!boot) boot = await rpc<Boot>('app.boot');
  const app = new App(boot, root);
  root.removeAttribute('aria-busy');
  performance.mark('swiftpad-ui-built');
  // Fenêtre affichée dès la première image dessinée (créée masquée par Tauri).
  let shownEpochMs: number | null = null;
  requestAnimationFrame(() => {
    shownEpochMs = Date.now();
    void notifyReady();
  });
  await app.start();
  performance.mark('swiftpad-ready');
  // Mesures locales uniquement (jamais transmises) : « À propos » et bancs d'essai.
  const perf: PerfInfo = { scriptToReadyMs: performance.now() - t0, navToReadyMs: performance.now(), processStartMs: boot.processStartMs, bootMs: boot.bootMs, shownEpochMs, readyEpochMs: Date.now() };
  (window as any).__swiftpadPerf = perf;
  void rpc('perf.mark', { name: 'ui-ready' }).catch(() => {});
  if (!isTauri()) window.__swiftpad = app.testHooks();
  if (boot.perfLog) void writePerfLog(perf);
}

/** Banc d'essai (variable SWIFTPAD_PERF_LOG, voir scripts/bench-windows.ps1) :
 *  une ligne de mesures écrite par le noyau après 1 s de repos. */
async function writePerfLog(perf: PerfInfo): Promise<void> {
  await new Promise((r) => setTimeout(r, 1000));
  const mem = (performance as any).memory;
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  await rpc('perf.write', {
    ui: {
      ...perf,
      shownEpochMs: perf.shownEpochMs,
      processToShownMs: perf.processStartMs && perf.shownEpochMs ? perf.shownEpochMs - perf.processStartMs : null,
      processToReadyMs: perf.processStartMs ? perf.readyEpochMs - perf.processStartMs : null,
      firstContentfulPaintMs: fcp ? fcp.startTime : null,
      jsHeapUsedBytes: mem?.usedJSHeapSize ?? null,
      jsHeapTotalBytes: mem?.totalJSHeapSize ?? null,
      domNodes: document.getElementsByTagName('*').length,
    },
  }).catch(() => {});
}

main().catch((e) => {
  console.error(e);
  void showFatal(document.getElementById('app')!, e);
});
