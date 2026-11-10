// Contrat avec la couche native Tauri, côté interface.
//
// La couche Tauri ne peut pas être compilée dans l'environnement de
// développement (pas d'accès à crates.io). Ici, `window.__TAURI__` est
// simulé : l'interface emprunte donc exactement ses chemins « Tauri »
// (transport `invoke('rpc', octets)`, boîtes de dialogue natives, titre et
// thème de la fenêtre, événements open-files et close-requested, fermeture
// confirmée). La simulation transmet les requêtes `rpc` au vrai noyau via le
// harnais et enregistre toutes les autres commandes avec leurs arguments ;
// scripts/check-ipc.mjs vérifie de son côté que ces noms et arguments
// correspondent aux commandes Rust.
import { readFileSync, existsSync } from 'node:fs';
import { setup, dialogButton, waitFor, assert } from './lib.mjs';

export const tests = [];
const t = (name, fn) => tests.push({ name, fn });

const FAKE_TAURI = () => {
  const calls = [];
  const listeners = {};
  window.__fakeTauri = {
    calls,
    nextOpen: null,
    nextSave: null,
    osTheme: 'light',
    emit(name, payload) {
      for (const cb of listeners[name] ?? []) cb({ event: name, id: 0, payload });
    },
  };
  window.__TAURI__ = {
    core: {
      async invoke(cmd, args) {
        if (cmd === 'rpc') {
          if (!(args instanceof Uint8Array)) throw new Error('rpc : corps binaire attendu');
          const token = new URLSearchParams(location.search).get('token') ?? '';
          const r = await fetch('/rpc', { method: 'POST', headers: { 'X-SwiftPad-Token': token }, body: args });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        }
        calls.push({ cmd, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) });
        if (cmd === 'dialog_open_files') return window.__fakeTauri.nextOpen;
        if (cmd === 'dialog_save_file') return window.__fakeTauri.nextSave;
        if (cmd === 'set_theme') return args.theme === 'system' ? window.__fakeTauri.osTheme : args.theme;
        return null;
      },
    },
    event: {
      async listen(name, cb) {
        (listeners[name] ??= []).push(cb);
        return () => {
          listeners[name] = listeners[name].filter((x) => x !== cb);
        };
      },
    },
  };
};

const calls = (page) => page.evaluate(() => window.__fakeTauri.calls);
const callsOf = async (page, cmd) => (await calls(page)).filter((c) => c.cmd === cmd);
const editorText = (page) => page.$eval('.editor-text', (e) => e.value);
async function waitEditable(page, text) {
  await page.waitForFunction((v) => {
    const ta = document.querySelector('.editor-text');
    return ta && ta.offsetParent !== null && !ta.readOnly && ta.value === v;
  }, text, { timeout: 10000 });
}

const KNOWN = new Set(['dialog_open_files', 'dialog_save_file', 'reveal_path', 'open_with_default', 'open_url', 'print_page', 'set_title', 'set_theme', 'app_ready', 'close_ack', 'close_confirmed']);

t('contrat avec la couche native (Tauri simulé) : dialogues, titre, thème, événements, fermeture', async () => {
  const c = await setup({ files: { 'a.txt': 'alpha', 'b.txt': 'beta' }, initScript: FAKE_TAURI });
  try {
    const { page } = c;
    assert.equal(await page.evaluate(() => typeof window.__swiftpad), 'undefined', 'crochets de test absents en mode Tauri');
    await waitFor(async () => (await callsOf(page, 'app_ready')).length === 1, { message: 'app_ready après la première image' });

    // Ouvrir : boîte de dialogue native, filtres transmis.
    await page.evaluate((p) => (window.__fakeTauri.nextOpen = [p]), c.p('a.txt'));
    await page.keyboard.press('Control+o');
    await waitEditable(page, 'alpha');
    const [open] = await callsOf(page, 'dialog_open_files');
    assert.deepEqual(Object.keys(open.args).sort(), ['directory', 'filters']);
    assert.ok(open.args.filters.length >= 2 && open.args.filters.every((f) => typeof f.name === 'string' && Array.isArray(f.extensions)));

    // Titre de la fenêtre : nom du fichier et indicateur de modification.
    await page.focus('.editor-text');
    await page.keyboard.press('Control+End');
    await page.keyboard.type('!');
    await waitFor(async () => (await callsOf(page, 'set_title')).some((x) => /^● a\.txt — SwiftPad$/.test(x.args.title)), { message: 'titre « ● a.txt — SwiftPad »' });

    // Enregistrer sous : boîte native, nom proposé, fichier écrit.
    await page.evaluate((p) => (window.__fakeTauri.nextSave = p), c.p('c.txt'));
    await page.keyboard.press('Control+Shift+s');
    await waitFor(() => existsSync(c.p('c.txt')) && readFileSync(c.p('c.txt'), 'utf8') === 'alpha!', { message: 'c.txt enregistré' });
    const [save] = await callsOf(page, 'dialog_save_file');
    assert.equal(save.args.name, 'a.txt');
    assert.deepEqual(Object.keys(save.args).sort(), ['directory', 'filters', 'name']);
    await waitFor(async () => (await callsOf(page, 'set_title')).some((x) => x.args.title === 'c.txt — SwiftPad'), { message: 'titre après enregistrement' });

    // Thème : la barre de titre native suit le changement.
    await page.keyboard.press('Control+Shift+p');
    await page.keyboard.type('Thème sombre');
    await page.keyboard.press('Enter');
    await waitFor(async () => (await callsOf(page, 'set_theme')).some((x) => x.args.theme === 'dark'), { message: 'set_theme(dark)' });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    // Sépia : la couche native reçoit « sepia » (barre de titre claire côté Rust).
    await page.keyboard.press('Control+Shift+p');
    await page.keyboard.type('Thème sépia');
    await page.keyboard.press('Enter');
    await waitFor(async () => (await callsOf(page, 'set_theme')).some((x) => x.args.theme === 'sepia'), { message: 'set_theme(sepia)' });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'sepia');
    // Retour au thème de Windows (sombre ici) : thème effectif appliqué, puis
    // suivi des changements de Windows signalés par la couche native.
    await page.evaluate(() => (window.__fakeTauri.osTheme = 'dark'));
    await page.keyboard.press('Control+Shift+p');
    await page.keyboard.type('Thème : suivre Windows');
    await page.keyboard.press('Enter');
    await waitFor(async () => (await callsOf(page, 'set_theme')).some((x) => x.args.theme === 'system'), { message: 'set_theme(system)' });
    await waitFor(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', { message: 'thème effectif de Windows appliqué' });
    await page.evaluate(() => window.__fakeTauri.emit('swiftpad://theme-changed', 'light'));
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');

    // Impression et « Afficher dans l'Explorateur ».
    await page.keyboard.press('Control+p');
    await waitFor(async () => (await callsOf(page, 'print_page')).length === 1, { message: 'print_page' });
    await page.keyboard.press('Control+Shift+p');
    await page.keyboard.type('Afficher dans l’Explorateur Windows');
    await page.keyboard.press('Enter');
    await waitFor(async () => (await callsOf(page, 'reveal_path')).some((x) => x.args.path === c.p('c.txt')), { message: 'reveal_path' });

    // Fichier transmis par Windows (glisser-déposer, « Ouvrir avec »).
    await page.evaluate((p) => window.__fakeTauri.emit('swiftpad://open-files', [p]), c.p('b.txt'));
    await waitEditable(page, 'beta');
    await page.focus('.editor-text');
    await page.keyboard.type('x');

    // Fermeture demandée par Windows avec un document modifié.
    await page.evaluate(() => window.__fakeTauri.emit('swiftpad://close-requested', null));
    await waitFor(async () => (await callsOf(page, 'close_ack')).length === 1, { message: 'accusé de réception' });
    await dialogButton(page, 'Annuler');
    await page.waitForTimeout(200);
    assert.equal((await callsOf(page, 'close_confirmed')).length, 0, 'fermeture annulée : fenêtre conservée');
    await page.evaluate(() => window.__fakeTauri.emit('swiftpad://close-requested', null));
    await dialogButton(page, 'Ne pas enregistrer');
    await waitFor(async () => (await callsOf(page, 'close_confirmed')).length === 1, { message: 'fermeture confirmée' });
    assert.equal(readFileSync(c.p('b.txt'), 'utf8'), 'beta', 'modification abandonnée à la demande');

    // Aucune commande inconnue de la couche native.
    const unknown = (await calls(page)).filter((x) => !KNOWN.has(x.cmd)).map((x) => x.cmd);
    assert.deepEqual(unknown, []);
    assert.deepEqual(c.logs.filter((l) => l.startsWith('[pageerror]')), []);
  } finally {
    await c.dispose();
  }
});
