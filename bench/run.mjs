#!/usr/bin/env node
// Banc d'essai reproductible de SwiftPad.
//
//   node bench/run.mjs [--runs 7] [--quick] [--no-core] [--no-ui] [--only nom,nom]
//
// 1. Noyau Rust (crates/swiftpad-core/examples/bench.rs) : ouverture,
//    enregistrement, gros fichiers (lecture, index, recherche) — chemin RPC
//    complet sans le transport IPC.
// 2. Interface : l'interface compilée (dist/) servie par le harnais (noyau
//    Rust réel) dans Chromium piloté par Playwright. Démarrage, ouverture de
//    fichiers, latence de frappe, recherche dans le document, onglets, mémoire.
//
// Ce que ces chiffres NE sont PAS : des mesures de l'application Tauri sous
// Windows. WebView2 est un Chromium (Edge) mais l'IPC, le processus natif,
// le système de fichiers et l'antivirus diffèrent. Sous Windows, utiliser
// en plus scripts/bench-windows.ps1 (exécutable réel, profil séparé).
//
// Résultats : bench/results/{core,ui}-<plateforme>.json et un résumé à l'écran.

import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { ROOT, HARNESS, DIST, startHarness, tempRoot, makeTree } from '../tests/e2e/lib.mjs';

// --- arguments -----------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const RUNS = Math.max(1, Number(opt('--runs', '7')));
const QUICK = flag('--quick');
const ONLY = opt('--only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);
const PLATFORM = `${process.platform}-${process.arch}`;
const OUT_DIR = join(ROOT, 'bench', 'results');
mkdirSync(OUT_DIR, { recursive: true });

// --- utilitaires ---------------------------------------------------------------

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN;
};
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const r1 = (x) => Math.round(x * 10) / 10;
const mb = (b) => (b == null ? null : Math.round((b / 1048576) * 10) / 10);

const results = [];
/** Seuil d'édition directe relevé (réglage utilisateur) pour mesurer la courbe complète. */
const RAISED = { files: { fluidEditMB: 4 } };
function record(group, name, samples, unit = 'ms', extra = {}) {
  if (!samples.length) {
    console.log(`  ${name.padEnd(58)} aucune mesure`);
    results.push({ group, name, unit, runs: 0, error: 'aucune mesure' });
    return;
  }
  const row = { group, name, unit, runs: samples.length, median: r1(median(samples)), min: r1(Math.min(...samples)), max: r1(Math.max(...samples)), ...extra };
  if (samples.length >= 10) row.p95 = r1(pct(samples, 95));
  results.push(row);
  const p95 = row.p95 != null ? `, p95 ${row.p95}` : '';
  console.log(`  ${name.padEnd(58)} ${String(row.median).padStart(9)} ${unit}  (min ${row.min}, max ${row.max}${p95}, n=${row.runs})`);
}
function recordValue(group, name, value, unit, extra = {}) {
  results.push({ group, name, unit, value, ...extra });
  console.log(`  ${name.padEnd(58)} ${String(value).padStart(9)} ${unit}`);
}

/** Texte réaliste (lignes de longueur variable, accents), déterministe. */
function sampleText(bytes, seed = 1) {
  const words = ['fonction', 'valeur', 'retour', 'élément', 'liste', 'index', 'paramètre', 'résultat', 'fichier', 'chemin', 'données', 'if', 'let', 'const', 'return', 'self', '=>', '{', '}', '(x)', '0x1F', '// note', 'TODO', 'café', 'naïve'];
  let r = (seed * 2654435761) >>> 0 || 1;
  const next = () => {
    r ^= r << 13;
    r >>>= 0;
    r ^= r >>> 17;
    r ^= r << 5;
    r >>>= 0;
    return r;
  };
  const parts = [];
  let len = 0;
  let line = 0;
  for (;;) {
    let s = ' '.repeat((next() % 4) * 4);
    const n = 2 + (next() % 12);
    for (let i = 0; i < n; i++) s += (i ? ' ' : '') + words[next() % words.length];
    if (line % 97 === 0) s += ' aiguille';
    s += '\n';
    const b = Buffer.byteLength(s);
    // Jamais au-delà de la taille demandée (2 Mo doit rester sous le seuil
    // d'édition fluide de 2 Mo).
    if (len + b > bytes) break;
    parts.push(s);
    len += b;
    line++;
  }
  return parts.join('');
}

function writeBig(path, megabytes) {
  const chunk = Buffer.from(sampleText(1 << 20, 99));
  const fd = openSync(path, 'w');
  for (let i = 0; i < megabytes; i++) writeSync(fd, chunk);
  closeSync(fd);
}

// Mémoire des processus (Linux : PSS, qui répartit les pages partagées ;
// ailleurs : non mesurée ici).
function procTree(rootPid) {
  if (process.platform !== 'linux') return [];
  const children = new Map();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(d));
    } catch {
      /* processus terminé */
    }
  }
  const out = [];
  const walk = (p) => {
    for (const c of children.get(p) ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(rootPid);
  return out;
}
function pssBytes(pid) {
  try {
    const m = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}
function rssBytes(pid) {
  try {
    const m = /^VmRSS:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}
function commOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return '';
  }
}

// --- application ---------------------------------------------------------------

let profiles = 0;
async function launchApp(browser, env, { open = [], viewport = { width: 1280, height: 800 }, settings = null } = {}) {
  // Profil neuf à chaque lancement : ni session ni copie de récupération
  // d'un scénario précédent.
  const data = join(env.root, `profil-${++profiles}`);
  mkdirSync(join(data, 'config'), { recursive: true });
  if (settings) writeFileSync(join(data, 'config', 'settings.json'), JSON.stringify({ version: 1, ...settings }));
  const harness = await startHarness({ dir: env.work, data, home: env.home, open });
  const context = await browser.newContext({ viewport, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(harness.url);
  await page.waitForFunction(() => window.__swiftpadPerf, null, { timeout: 30000 });
  return {
    harness,
    context,
    page,
    errors,
    async close() {
      await context.close().catch(() => {});
      harness.proc.kill('SIGKILL');
      await new Promise((r) => (harness.proc.exitCode !== null ? r() : harness.proc.on('exit', r)));
    },
  };
}

/** Exécute `fn` dans la page puis attend que l'image suivante soit dessinée. */
const IN_PAGE_HELPERS = `
  window.__benchFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  window.__benchUntil = async (pred, timeout = 30000) => {
    const t0 = performance.now();
    while (!pred()) {
      if (performance.now() - t0 > timeout) throw new Error('délai dépassé');
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
`;

// --- préparation des données ----------------------------------------------------

function prepare() {
  const root = tempRoot('bench');
  const home = join(root, 'home');
  const work = join(home, 'Documents', 'bench');
  const data = join(root, 'data');
  mkdirSync(work, { recursive: true });
  mkdirSync(data, { recursive: true });
  const sizes = QUICK ? [['1 Ko', 1 << 10], ['1 Mo', 1 << 20], ['2 Mo', 2 << 20]] : [['1 Ko', 1 << 10], ['100 Ko', 100 << 10], ['512 Ko', 512 << 10], ['1 Mo', 1 << 20], ['2 Mo', 2 << 20]];
  const files = {};
  for (const [label, n] of sizes) files[`texte-${n}.txt`] = sampleText(n, n);
  files['recherche-2Mo.txt'] = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, cible.\n'.repeat(32_000);
  makeTree(work, files);
  const bigSizes = QUICK ? [10] : [10, 100];
  for (const m of bigSizes) writeBig(join(work, `gros-${m}Mo.log`), m);
  // 100 fichiers de 10 Ko pour les onglets.
  const tabsDir = join(work, 'onglets');
  const tf = {};
  for (let i = 0; i < 100; i++) tf[`t${String(i).padStart(3, '0')}.txt`] = sampleText(10 << 10, i + 7);
  makeTree(tabsDir, tf);
  return { root, home, work, data, sizes, bigSizes, tabsDir, tabFiles: Object.keys(tf).map((f) => join(tabsDir, f)) };
}

// --- scénarios ------------------------------------------------------------------

async function benchStartup(env) {
  console.log('\nDémarrage (Chromium lancé à chaque essai, harnais neuf, profil vide)');
  const full = [];
  const nav = [];
  const fcp = [];
  const withFile = [];
  for (let i = 0; i < RUNS; i++) {
    for (const open of [[], [join(env.work, `texte-${1 << 20}.txt`)]]) {
      const t0 = Date.now();
      const browser = await chromium.launch();
      const app = await launchApp(browser, env, { open });
      const p = await app.page.evaluate(() => {
        const e = performance.getEntriesByName('first-contentful-paint')[0];
        return { ...window.__swiftpadPerf, fcp: e ? e.startTime : null };
      });
      if (open.length) {
        await app.page.waitForFunction((n) => document.querySelector('.editor-text')?.value.length >= n, (1 << 20) * 0.9, { timeout: 30000 });
        withFile.push(Date.now() - t0);
      } else {
        full.push(p.readyEpochMs - t0);
        nav.push(p.navToReadyMs);
        if (p.fcp != null) fcp.push(p.fcp);
      }
      await app.close();
      await browser.close();
    }
  }
  record('startup', 'lancement Chromium + harnais → interface prête', full);
  record('startup', 'idem, fichier de 1 Mo passé en argument → texte affiché', withFile);
  record('startup', 'navigation → interface prête (moteur web déjà lancé)', nav);
  if (fcp.length) record('startup', 'navigation → premier rendu (FCP)', fcp);
}

async function benchOpen(browser, env) {
  console.log('\nOuverture de fichiers (cache disque chaud, onglet refermé entre deux essais ;');
  console.log('seuil d’édition directe relevé à 4 Mo pour mesurer au-delà du réglage par défaut de 1 Mo)');
  const app = await launchApp(browser, env, { settings: RAISED });
  const { page } = app;
  await page.evaluate(IN_PAGE_HELPERS);
  for (const [label, n] of env.sizes) {
    const path = join(env.work, `texte-${n}.txt`);
    const samples = await page.evaluate(
      async ({ path, runs }) => {
        const ws = window.__swiftpad.ws;
        const out = [];
        for (let i = 0; i < runs + 1; i++) {
          await ws.closeMany([...ws.docs]);
          await window.__benchFrame();
          const t = performance.now();
          await ws.openPath(path);
          await window.__benchFrame();
          if (i > 0) out.push(performance.now() - t); // premier essai : préchauffage
        }
        return out;
      },
      { path, runs: RUNS },
    );
    record('open', `ouvrir ${label} → texte affiché`, samples);
  }
  for (const m of env.bigSizes) {
    const path = join(env.work, `gros-${m}Mo.log`);
    const samples = await page.evaluate(
      async ({ path, runs }) => {
        const ws = window.__swiftpad.ws;
        const out = [];
        for (let i = 0; i < runs + 1; i++) {
          await ws.closeMany([...ws.docs]);
          await window.__benchFrame();
          const t = performance.now();
          void ws.openPath(path);
          await window.__benchUntil(() => document.querySelector('.bigview .big-row'));
          await window.__benchFrame();
          if (i > 0) out.push(performance.now() - t);
        }
        await ws.closeMany([...ws.docs]);
        return out;
      },
      { path, runs: RUNS },
    );
    record('open', `ouvrir ${m} Mo (lecteur gros fichier) → premières lignes`, samples);
  }
  await app.close();
  // Même mesure sans retour automatique à la ligne (actif par défaut) : la
  // mise en page des lignes repliées dans la colonne coûte une part du temps.
  const app2 = await launchApp(browser, env, { settings: { ...RAISED, editor: { wordWrap: false } } });
  await app2.page.evaluate(IN_PAGE_HELPERS);
  for (const [label, n] of env.sizes) {
    if (n < 512 << 10) continue;
    const path = join(env.work, `texte-${n}.txt`);
    const samples = await app2.page.evaluate(
      async ({ path, runs }) => {
        const ws = window.__swiftpad.ws;
        const out = [];
        for (let i = 0; i < runs + 1; i++) {
          await ws.closeMany([...ws.docs]);
          await window.__benchFrame();
          const t = performance.now();
          await ws.openPath(path);
          await window.__benchFrame();
          if (i > 0) out.push(performance.now() - t);
        }
        return out;
      },
      { path, runs: RUNS },
    );
    record('open', `ouvrir ${label} → texte affiché, sans retour à la ligne`, samples);
  }
  await app2.close();
}

async function benchTyping(browser, env) {
  console.log('\nLatence de frappe (touche → image suivante dessinée), 60 caractères, seuil relevé à 4 Mo');
  const app = await launchApp(browser, env, { settings: RAISED });
  const { page } = app;
  await page.evaluate(IN_PAGE_HELPERS);
  await page.evaluate(() => {
    const ta = document.querySelector('.editor-text');
    window.__lat = [];
    let kd = 0;
    ta.addEventListener('keydown', (e) => (kd = e.timeStamp));
    ta.addEventListener('input', () => {
      const start = kd;
      requestAnimationFrame(() => setTimeout(() => window.__lat.push(performance.now() - start), 0));
    });
  });
  for (const [label, n] of env.sizes) {
    if (n === 100 << 10) continue;
    const path = join(env.work, `texte-${n}.txt`);
    await page.evaluate(async (p) => {
      const ws = window.__swiftpad.ws;
      await ws.openPath(p);
      await window.__benchFrame();
    }, path);
    await page.focus('.editor-text');
    await page.keyboard.press('Control+Home');
    await page.waitForTimeout(300);
    await page.evaluate(() => (window.__lat = []));
    await page.keyboard.type('Une phrase saisie au clavier pour mesurer la latence. Fin!!', { delay: 40 });
    await page.waitForTimeout(200);
    const lat = await page.evaluate(() => window.__lat);
    record('typing', `frappe dans un document de ${label}`, lat);
    // Abandon des modifications : nouveau document pour l'essai suivant.
    await page.evaluate(() => {
      const ws = window.__swiftpad.ws;
      for (const d of ws.docs) d.text?.history?.markSaved?.();
    });
  }
  await app.close();
}

async function benchFind(browser, env) {
  console.log('\nRecherche dans le document (Ctrl+F), 2 Mo, 32 000 occurrences, seuil relevé à 4 Mo');
  const app = await launchApp(browser, env, { settings: RAISED });
  const { page } = app;
  await page.evaluate(IN_PAGE_HELPERS);
  await page.evaluate(async (p) => {
    await window.__swiftpad.ws.openPath(p);
    await window.__benchFrame();
  }, join(env.work, 'recherche-2Mo.txt'));
  await page.focus('.editor-text');
  await page.keyboard.press('Control+f');
  const samples = await page.evaluate(async (runs) => {
    const fb = window.__swiftpad.ws.findbar;
    const input = fb.input;
    const count = () => document.querySelector('.find-count').textContent.replace(/\s/g, ' ');
    const out = [];
    for (let i = 0; i < runs + 1; i++) {
      input.value = 'zzz-absent';
      input.dispatchEvent(new Event('input'));
      await window.__benchUntil(() => /Aucun/.test(count()));
      await new Promise((r) => setTimeout(r, 400));
      const t = performance.now();
      input.value = 'cible';
      input.dispatchEvent(new Event('input'));
      await window.__benchUntil(() => /32 000/.test(count()));
      await window.__benchFrame();
      if (i > 0) out.push(performance.now() - t);
    }
    return out;
  }, RUNS);
  record('find', 'saisie → 32 000 occurrences comptées (dont anti-rebond 150 ms)', samples);
  await app.close();
}

async function benchBigSearch(browser, env) {
  const m = env.bigSizes[env.bigSizes.length - 1];
  console.log(`\nRecherche dans le lecteur de gros fichier (${m} Mo, mot absent : parcours complet)`);
  const app = await launchApp(browser, env);
  const { page } = app;
  await page.evaluate(IN_PAGE_HELPERS);
  const samples = await page.evaluate(
    async ({ path, runs }) => {
      const ws = window.__swiftpad.ws;
      void ws.openPath(path);
      // Index des lignes terminé avant de mesurer (« N lignes » affiché).
      await window.__benchUntil(() => /lignes/.test(document.querySelector('.big-status')?.textContent ?? ''), 120000);
      const input = document.querySelector('.big-header input');
      const head = () => document.querySelector('.big-res-head')?.textContent ?? '';
      const out = [];
      for (let i = 0; i < runs + 1; i++) {
        input.value = i % 2 ? 'zzz-absent' : 'zzz-introuvable';
        const t = performance.now();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await window.__benchUntil(() => /^0 résultat/.test(head()), 120000);
        await window.__benchFrame();
        if (i > 0) out.push(performance.now() - t);
      }
      return out;
    },
    { path: join(env.work, `gros-${m}Mo.log`), runs: RUNS },
  );
  record('bigsearch', `rechercher un mot absent dans ${m} Mo → « 0 résultat » affiché`, samples);
  await app.close();
}

async function benchTabs(browser, env) {
  console.log('\nOnglets (100 fichiers de 10 Ko)');
  const app = await launchApp(browser, env);
  const { page } = app;
  await page.evaluate(IN_PAGE_HELPERS);
  const openMs = [];
  for (let i = 0; i < Math.min(RUNS, 5); i++) {
    openMs.push(
      await page.evaluate(async (paths) => {
        const ws = window.__swiftpad.ws;
        await ws.closeMany([...ws.docs]);
        await window.__benchFrame();
        const t = performance.now();
        await ws.openPaths(paths);
        await window.__benchFrame();
        return performance.now() - t;
      }, env.tabFiles),
    );
  }
  record('tabs', 'ouvrir 100 fichiers → 100 onglets affichés', openMs);
  await page.focus('.editor-text');
  await page.evaluate(() => {
    window.__sw = [];
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Tab' || !e.ctrlKey) return;
        const start = e.timeStamp;
        requestAnimationFrame(() => setTimeout(() => window.__sw.push(performance.now() - start), 0));
      },
      true,
    );
  });
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Control+Tab');
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(200);
  record('tabs', 'changer d’onglet (Ctrl+Tab) → image suivante', await page.evaluate(() => window.__sw));
  await app.close();
}

async function benchMemory(env) {
  console.log('\nMémoire (navigateur neuf par scénario, après ramasse-miettes et 1 s de repos)');
  const scenarios = [
    ['au repos, document vide', async () => {}],
    ['10 documents de 100 Ko ouverts', async (page) => page.evaluate((ps) => window.__swiftpad.ws.openPaths(ps), env.tabFiles.slice(0, 10).map((p) => p))],
    ['1 document de 1 Mo en édition', async (page) => page.evaluate((p) => window.__swiftpad.ws.openPath(p), join(env.work, `texte-${1 << 20}.txt`))],
    ['100 onglets de 10 Ko', async (page) => page.evaluate((ps) => window.__swiftpad.ws.openPaths(ps), env.tabFiles)],
    [`lecteur gros fichier ${env.bigSizes[env.bigSizes.length - 1]} Mo`, async (page) => {
      await page.evaluate((p) => void window.__swiftpad.ws.openPath(p), join(env.work, `gros-${env.bigSizes[env.bigSizes.length - 1]}Mo.log`));
      await page.waitForSelector('.bigview .big-row');
      await page.waitForTimeout(1500); // index construit en arrière-plan
    }],
  ];
  // Les fichiers de 10 Ko servent aussi au scénario « 10 documents de 100 Ko » :
  // on crée dix fichiers de 100 Ko dédiés.
  const hundred = [];
  for (let i = 0; i < 10; i++) {
    const p = join(env.work, `cent-${i}.txt`);
    if (!existsSync(p)) writeFileSync(p, sampleText(100 << 10, 500 + i));
    hundred.push(p);
  }
  scenarios[1][1] = async (page) => page.evaluate((ps) => window.__swiftpad.ws.openPaths(ps), hundred);
  for (const [name, act] of scenarios) {
    const browser = await chromium.launch();
    const app = await launchApp(browser, env);
    const { page } = app;
    await act(page);
    await page.waitForTimeout(1000);
    const cdp = await app.context.newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForTimeout(300);
    await cdp.send('Performance.enable');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    const pids = procTree(process.pid).filter((pid) => pid !== app.harness.proc.pid && /chrom|headless/i.test(commOf(pid)));
    const browserPss = pids.reduce((s, pid) => s + pssBytes(pid), 0);
    const coreRss = rssBytes(app.harness.proc.pid);
    const row = { jsHeapUsedMB: mb(m.JSHeapUsedSize), domNodes: m.Nodes, chromiumPssMB: process.platform === 'linux' ? mb(browserPss) : null, chromiumProcesses: pids.length, coreRssMB: mb(coreRss) };
    results.push({ group: 'memory', name, ...row });
    console.log(`  ${name.padEnd(40)} tas JS ${String(row.jsHeapUsedMB).padStart(6)} Mo · DOM ${String(row.domNodes).padStart(5)} nœuds · Chromium (PSS, ${pids.length} proc.) ${row.chromiumPssMB ?? 'n/d'} Mo · noyau ${row.coreRssMB ?? 'n/d'} Mo`);
    await app.close();
    await browser.close();
  }
}

// --- principal ------------------------------------------------------------------

function machine() {
  const cpus = os.cpus();
  return {
    platform: PLATFORM,
    os: `${os.type()} ${os.release()}`,
    cpu: cpus[0]?.model ?? 'inconnu',
    logicalCpus: cpus.length,
    memoryGB: Math.round((os.totalmem() / 1073741824) * 10) / 10,
    node: process.version,
    chromium: null,
  };
}

async function main() {
  const info = machine();
  const started = new Date().toISOString();
  console.log(`SwiftPad — banc d'essai (${RUNS} essais${QUICK ? ', rapide' : ''})`);
  console.log(`Machine : ${info.cpu} · ${info.logicalCpus} processeurs logiques · ${info.memoryGB} Go · ${info.os}`);

  if (!flag('--no-core') && want('core')) {
    console.log('\n=== Noyau Rust (cargo run --release --example bench) ===');
    const out = join(OUT_DIR, `core-${PLATFORM}.json`);
    const r = spawnSync('cargo', ['run', '--quiet', '--release', '--example', 'bench', '--', '--runs', String(RUNS), '--out', out, ...(QUICK ? ['--quick'] : [])], {
      cwd: join(ROOT, 'crates', 'swiftpad-core'),
      stdio: 'inherit',
    });
    if (r.status !== 0) console.log('  (banc du noyau non exécuté : cargo indisponible ou erreur)');
  }
  if (flag('--no-ui')) return;
  if (!existsSync(HARNESS)) throw new Error(`Harnais introuvable : ${HARNESS}\nCompiler d'abord : (cd crates/swiftpad-core && cargo build --release --bin swiftpad-harness)`);
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('Interface non compilée : npm run build:web');

  console.log('\n=== Interface (harnais + Chromium headless via Playwright) ===');
  const env = prepare();
  try {
    if (want('startup')) await benchStartup(env);
    const browser = await chromium.launch();
    info.chromium = browser.version();
    try {
      if (want('open')) await benchOpen(browser, env);
      if (want('typing')) await benchTyping(browser, env);
      if (want('find')) await benchFind(browser, env);
      if (want('bigsearch')) await benchBigSearch(browser, env);
      if (want('tabs')) await benchTabs(browser, env);
    } finally {
      await browser.close();
    }
    if (want('memory')) await benchMemory(env);
  } finally {
    if (!process.env.SWIFTPAD_KEEP) rmSync(env.root, { recursive: true, force: true });
  }
  const out = join(OUT_DIR, `ui-${PLATFORM}.json`);
  // Avec --only : les groupes non relancés sont conservés du fichier précédent.
  let merged = results;
  if (ONLY.length && existsSync(out)) {
    try {
      const prev = JSON.parse(readFileSync(out, 'utf8')).results ?? [];
      const rerun = new Set(results.map((r) => r.group));
      merged = [...prev.filter((r) => !rerun.has(r.group)), ...results];
    } catch {
      /* fichier illisible : remplacé */
    }
  }
  writeFileSync(out, JSON.stringify({ tool: 'bench/run.mjs', started, finished: new Date().toISOString(), runs: RUNS, quick: QUICK, machine: info, notes: 'Harnais HTTP local + Chromium headless (Playwright), cache disque chaud. Pas Tauri/WebView2.', results: merged }, null, 2));
  console.log(`\nRésultats écrits dans ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
