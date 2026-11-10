// Outils des tests de bout en bout : harnais (noyau Rust réel + interface
// compilée) piloté dans Chromium par Playwright.
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HARNESS = join(ROOT, 'crates', 'swiftpad-core', 'target', process.env.SWIFTPAD_HARNESS_PROFILE ?? 'release', 'swiftpad-harness');
export const DIST = join(ROOT, 'dist');

let browser = null;
export async function getBrowser() {
  if (!browser) browser = await chromium.launch();
  return browser;
}
export async function closeBrowser() {
  if (browser) await browser.close();
  browser = null;
}

/** Crée une arborescence de fichiers : { 'a/b.txt': 'contenu' | Buffer }. */
export function makeTree(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(base, rel);
    mkdirSync(dirname(p), { recursive: true });
    if (content === null) mkdirSync(p, { recursive: true });
    else writeFileSync(p, content);
  }
}

export function tempRoot(prefix = 'e2e') {
  const base = process.env.SWIFTPAD_E2E_TMP ?? tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `swiftpad-${prefix}-`));
}

/** Lance le harnais (éventuellement en tant qu'un autre utilisateur). */
export async function startHarness({ dir, data, home, open = [], asUser = null }) {
  const args = ['--dist', DIST, '--data', data, '--home', home, ...open];
  const cmd = asUser ? 'setpriv' : HARNESS;
  const argv = asUser ? [`--reuid=${asUser}`, `--regid=${asUser}`, '--clear-groups', HARNESS, ...args] : args;
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share') };
  const proc = spawn(cmd, argv, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('harnais : délai dépassé')), 10000);
    proc.stdout.on('data', (d) => {
      const m = /SWIFTPAD_HARNESS_URL=(\S+)/.exec(String(d));
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
    proc.on('exit', (c) => reject(new Error(`harnais arrêté (${c})`)));
  });
  return { proc, url };
}

/**
 * Prépare un scénario : dossier de travail avec des fichiers, harnais,
 * page Chromium prête. `ctx.restart()` relance harnais + page sur les mêmes
 * données (redémarrage de l'application).
 */
export async function setup({ files = {}, open = [], viewport = { width: 1280, height: 800 }, asUser = null, settings = null, keepRoot = null, initScript = null } = {}) {
  const root = keepRoot ?? tempRoot();
  const home = join(root, 'home');
  const work = join(home, 'Documents', 'travail');
  const data = join(root, 'data');
  mkdirSync(work, { recursive: true });
  mkdirSync(data, { recursive: true });
  makeTree(work, files);
  if (settings) {
    mkdirSync(join(data, 'config'), { recursive: true });
    writeFileSync(join(data, 'config', 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
  }
  if (asUser) execFileSync('chown', ['-R', `${asUser}:${asUser}`, root]);
  const b = await getBrowser();
  const ctx = {
    root,
    home,
    work,
    data,
    p: (rel) => join(work, rel),
    logs: [],
    requests: [],
    page: null,
    context: null,
    harness: null,
    async launch(openFiles = open) {
      this.harness = await startHarness({ dir: work, data, home, open: openFiles.map((f) => (f.startsWith('/') ? f : join(work, f))), asUser });
      this.context = await b.newContext({ viewport, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
      await this.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(this.harness.url).origin });
      // Script exécuté avant ceux de la page (ex. couche Tauri simulée).
      if (initScript) await this.context.addInitScript(initScript);
      this.page = await this.context.newPage();
      this.page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') this.logs.push(`[${m.type()}] ${m.text()}`);
      });
      this.page.on('pageerror', (e) => this.logs.push(`[pageerror] ${e.message}`));
      this.page.on('request', (r) => this.requests.push(r.url()));
      await this.page.goto(this.harness.url);
      await this.page.waitForFunction(() => window.__swiftpadPerf, null, { timeout: 15000 });
      return this.page;
    },
    async stop(kill = false) {
      if (this.context) await this.context.close().catch(() => {});
      this.context = null;
      if (this.harness) {
        this.harness.proc.kill(kill ? 'SIGKILL' : 'SIGTERM');
        await new Promise((r) => (this.harness.proc.exitCode !== null ? r() : this.harness.proc.on('exit', r)));
      }
      this.harness = null;
    },
    async restart() {
      await this.stop();
      return this.launch([]);
    },
    async dispose() {
      await this.stop(true);
      try {
        execFileSync('chmod', ['-R', 'u+rwX', root]);
      } catch {
        /* rien */
      }
      if (!process.env.SWIFTPAD_KEEP) rmSync(root, { recursive: true, force: true });
    },
  };
  await ctx.launch(open);
  return ctx;
}

// --- interactions ------------------------------------------------------------

export const editorValue = (page) => page.evaluate(() => document.querySelector('.editor-text').value);
export const tabNames = (page) => page.$$eval('.tab .tab-name', (els) => els.map((e) => e.textContent));
export const activeTab = (page) => page.$eval('.tab.active .tab-name', (e) => e.textContent);
/** Contenu de la barre d'état, qu'elle soit affichée ou non (masquée par
 *  défaut : ses informations restent tenues à jour). */
export const statusText = (page) =>
  page.$eval('.statusbar', (e) => [...e.children].filter((c) => !c.hidden).map((c) => c.textContent).join(' ').replace(/\s+/g, ' ').trim());
export const infobarText = (page) => page.$$eval('.infobar', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')).join(' | '));

/** Document actif chargé et zone d'édition affichée (un utilisateur ne tape
 *  qu'une fois le texte visible ; voir aussi le test « frappe pendant le
 *  chargement » pour le cas contraire). */
export async function waitEditor(page) {
  await page.waitForFunction(() => {
    const d = window.__swiftpad?.ws.active;
    const ta = document.querySelector('.editor-text');
    return d?.loaded && ta && ta.offsetParent !== null;
  }, null, { timeout: 10000 });
}

export async function focusEditor(page) {
  await waitEditor(page);
  await page.click('.editor-text');
}

export async function typeAtEnd(page, text) {
  await waitEditor(page);
  await page.focus('.editor-text');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}

/** Clique sur un bouton d'une boîte de dialogue par son libellé. */
export async function dialogButton(page, label) {
  const btn = page.locator('.dlg-backdrop .dlg-footer button', { hasText: label }).first();
  await btn.waitFor({ timeout: 5000 });
  await btn.click();
}

export async function dialogText(page) {
  const d = page.locator('.dlg-backdrop .dlg').first();
  await d.waitFor({ timeout: 5000 });
  return (await d.innerText()).replace(/\s+/g, ' ');
}

/** Remplit la boîte de saisie ouverte et valide. */
export async function promptFill(page, value) {
  const input = page.locator('.dlg-backdrop input.input').first();
  await input.waitFor({ timeout: 5000 });
  await input.fill(value);
  await input.press('Enter');
}

export async function waitNoDialog(page) {
  await page.waitForFunction(() => !document.querySelector('.dlg-backdrop'), null, { timeout: 5000 });
}

/** Ouvre un fichier comme l'utilisateur : Ctrl+O, puis le chemin complet
 *  (dans le harnais, la boîte de dialogue native est remplacée par une
 *  saisie du chemin). */
export async function openFile(page, path) {
  await page.keyboard.press('Control+o');
  await promptFill(page, path);
  // La saisie se ferme ; une autre question peut suivre (fichier binaire…).
  await page.waitForFunction(() => ![...document.querySelectorAll('.dlg-title')].some((t) => t.textContent === 'Ouvrir'), null, { timeout: 5000 });
}

export async function waitFor(fn, { timeout = 5000, interval = 50, message = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Délai dépassé : ${message} (dernier : ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

/** Simule le retour du focus sur la fenêtre (contrôle des modifications externes). */
export async function refocus(page) {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(400);
}

/** Attend la fin de l'enregistrement : état interne non modifié (la barre
 *  d'état n'est rafraîchie qu'à l'image suivante, elle peut être en retard). */
export async function waitSaved(page) {
  await page.waitForFunction(
    () => {
      const d = window.__swiftpad?.ws?.active;
      return !!d && !d.dirty && !!d.path && !document.querySelector('.dlg-backdrop');
    },
    null,
    { timeout: 5000 },
  );
}

export { assert, existsSync, chmodSync };
