// Écran d'écriture et personnalisation : interface réduite au texte,
// colonne centrée, interligne, thèmes, couleurs libres, palette.
import { readFileSync } from 'node:fs';
import { setup, editorValue, tabNames, activeTab, statusText, typeAtEnd, dialogButton, waitSaved, waitFor, openFile, assert } from './lib.mjs';

export const tests = [];
const t = (name, fn) => tests.push({ name, fn });

const PROSE = 'Il pleuvait depuis l’aube sur les toits de la ville, une pluie fine et obstinée qui effaçait les contours des choses. '.repeat(12);

const settingsOnDisk = (c) => JSON.parse(readFileSync(`${c.data}/config/settings.json`, 'utf8'));
const visible = (page, sel) => page.$$eval(sel, (els) => els.some((e) => e.offsetParent !== null && e.getBoundingClientRect().height > 0));
const style = (page, sel, prop) => page.$eval(sel, (e, p) => getComputedStyle(e)[p], prop);

/** Géométrie de la colonne : marges gauche/droite et largeur en caractères. */
const column = (page) =>
  page.evaluate(() => {
    const ta = document.querySelector('.editor-text');
    const cs = getComputedStyle(ta);
    const l = parseFloat(cs.paddingLeft);
    const r = parseFloat(cs.paddingRight);
    const avg = window.__swiftpad.ws.view.avgCharWidth;
    return { l, r, chars: (ta.clientWidth - l - r) / avg, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
  });

async function openPrefs(page) {
  await page.keyboard.press('Control+,');
  await page.locator('.prefs').waitFor();
}

async function closePrefs(page) {
  await dialogButton(page, 'Fermer');
  await page.waitForFunction(() => !document.querySelector('.dlg-backdrop'));
}

/** Les paramètres sont enregistrés après un court délai : attente du fichier. */
async function waitSetting(c, path, expected) {
  await waitFor(
    () => {
      try {
        const v = path.split('.').reduce((o, k) => o?.[k], settingsOnDisk(c));
        return JSON.stringify(v) === JSON.stringify(expected);
      } catch {
        return false;
      }
    },
    { message: `${path} = ${JSON.stringify(expected)} enregistré` },
  );
}

t('écran d’écriture : seulement le texte et la barre de menus (ni panneau, ni barre d’outils, ni barre d’état)', async () => {
  const c = await setup({ files: { 'texte.txt': PROSE }, open: ['texte.txt'] });
  try {
    const { page } = c;
    assert.equal(await page.locator('.explorer, .sidebar, .toolbar, .searchpanel').count(), 0, 'aucun panneau latéral ni barre d’outils');
    assert.equal(await visible(page, '.menubar'), true, 'barre de menus');
    assert.equal(await visible(page, '.tabbar'), false, 'un seul document : pas d’onglets');
    assert.equal(await visible(page, '.statusbar .sb-pos'), false, 'barre d’état masquée par défaut');
    // L'éditeur occupe toute la fenêtre sous la barre de menus.
    const r = await page.evaluate(() => {
      const ed = document.querySelector('.editor').getBoundingClientRect();
      const top = document.querySelector('.topbar').getBoundingClientRect();
      return { left: ed.left, right: ed.right, top: ed.top, bottom: ed.bottom, menuBottom: top.bottom, w: innerWidth, h: innerHeight };
    });
    assert.equal(r.left, 0);
    assert.equal(r.right, r.w);
    assert.ok(Math.abs(r.top - r.menuBottom) <= 1, `éditeur sous les menus (${r.top} / ${r.menuBottom})`);
    assert.ok(r.h - r.bottom <= 1, `éditeur jusqu’en bas (${r.bottom} / ${r.h})`);
    // Les messages restent visibles, en bulle discrète.
    await typeAtEnd(page, '!');
    await page.keyboard.press('Control+s');
    await waitSaved(page);
    // Barre d'état réactivable (menu Affichage), conservée.
    await page.keyboard.press('Control+Shift+p');
    await page.keyboard.type('Barre d’état');
    await page.keyboard.press('Enter');
    await waitFor(() => visible(page, '.statusbar .sb-pos'), { message: 'barre d’état affichée' });
    assert.match(await statusText(page), /Ln 1, Col/);
    await waitSetting(c, 'ui.statusBar', true);
  } finally {
    await c.dispose();
  }
});

t('colonne centrée (étroite, moyenne, pleine largeur) et interligne, depuis les préférences, conservés', async () => {
  const c = await setup({ files: { 'texte.txt': PROSE }, open: ['texte.txt'], viewport: { width: 1280, height: 800 } });
  try {
    const { page } = c;
    let col = await column(page);
    assert.equal(col.l, col.r, 'colonne centrée');
    assert.ok(col.chars > 72 && col.chars < 76, `colonne moyenne ≈ 74 caractères (${col.chars.toFixed(1)})`);
    assert.equal(await style(page, '.editor-text', 'lineHeight'), '28px', 'interligne par défaut 1,65 × 17 px');

    await openPrefs(page);
    await page.getByLabel('Largeur du texte').selectOption('narrow');
    await waitFor(async () => (await column(page)).chars < 60, { message: 'colonne étroite' });
    col = await column(page);
    assert.ok(col.chars > 56 && col.chars < 60 && col.l === col.r, `colonne étroite ≈ 58 caractères (${col.chars.toFixed(1)})`);
    await page.getByLabel('Largeur du texte').selectOption('full');
    await waitFor(async () => (await column(page)).l === 24, { message: 'pleine largeur : marge minimale' });

    const lh = page.getByLabel('Interligne');
    assert.equal(await lh.inputValue(), '165', 'curseur à la valeur enregistrée');
    assert.equal(await page.textContent('.prefs output'), '1,65');
    await lh.fill('200');
    await waitFor(async () => (await style(page, '.editor-text', 'lineHeight')) === '34px', { message: 'interligne 2 × 17 px' });
    assert.equal(await page.textContent('.prefs output'), '2,00');
    await closePrefs(page);
    await waitSetting(c, 'editor.lineHeight', 200);
    await waitSetting(c, 'editor.columnWidth', 'full');

    // Fenêtre étroite : la colonne moyenne se réduit à la marge minimale, sans débordement.
    await openPrefs(page);
    await page.getByLabel('Largeur du texte').selectOption('medium');
    await closePrefs(page);
    await page.setViewportSize({ width: 560, height: 700 });
    await waitFor(async () => (await column(page)).l === 24, { message: 'marge minimale en fenêtre étroite' });
    col = await column(page);
    assert.ok(col.sw <= col.cw, 'pas de défilement horizontal');

    // Conservés au redémarrage.
    await waitSetting(c, 'editor.columnWidth', 'medium');
    await c.restart();
    const p2 = c.page;
    await p2.setViewportSize({ width: 1280, height: 800 });
    await waitFor(async () => {
      const k = await column(p2);
      return k.chars > 72 && k.chars < 76;
    }, { message: 'colonne moyenne après redémarrage' });
    assert.equal(await style(p2, '.editor-text', 'lineHeight'), '34px');
  } finally {
    await c.dispose();
  }
});

t('thèmes (clair, sombre, sépia) et couleurs libres : appliqués, conservés, réinitialisables', async () => {
  const c = await setup({ files: { 'texte.txt': PROSE }, open: ['texte.txt'] });
  try {
    const { page } = c;
    const bg = () => style(page, '.editor', 'backgroundColor');
    await openPrefs(page);
    const theme = page.getByLabel('Thème', { exact: true });
    await theme.selectOption('dark');
    await waitFor(async () => (await bg()) === 'rgb(28, 31, 36)', { message: 'fond sombre' });
    await theme.selectOption('sepia');
    await waitFor(async () => (await bg()) === 'rgb(242, 232, 213)', { message: 'fond sépia' });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'sepia');
    assert.equal(await style(page, '.editor-text', 'color'), 'rgb(63, 50, 36)', 'encre sépia');
    // Le sélecteur de couleur montre la couleur du thème tant qu'elle n'est pas personnalisée.
    await waitFor(async () => (await page.getByLabel('Fond', { exact: true }).inputValue()) === '#f2e8d5', { message: 'couleur du thème proposée' });

    await page.getByLabel('Fond', { exact: true }).fill('#1e2a24');
    await page.getByLabel('Texte', { exact: true }).fill('#d8e4d0');
    await page.getByLabel('Curseur', { exact: true }).fill('#f2c14e');
    await waitFor(async () => (await bg()) === 'rgb(30, 42, 36)', { message: 'fond personnalisé' });
    assert.equal(await style(page, '.editor-text', 'color'), 'rgb(216, 228, 208)');
    assert.equal(await style(page, '.editor-text', 'caretColor'), 'rgb(242, 193, 78)');
    await closePrefs(page);
    await waitSetting(c, 'colors', { background: '#1e2a24', text: '#d8e4d0', caret: '#f2c14e' });
    await waitSetting(c, 'theme', 'sepia');

    // Conservés au redémarrage.
    await c.restart();
    const p2 = c.page;
    await waitFor(async () => (await style(p2, '.editor', 'backgroundColor')) === 'rgb(30, 42, 36)', { message: 'fond personnalisé après redémarrage' });
    assert.equal(await p2.evaluate(() => document.documentElement.dataset.theme), 'sepia');

    // Retour aux couleurs du thème.
    await openPrefs(p2);
    await p2.locator('.prefs button', { hasText: 'Revenir aux couleurs du thème' }).click();
    await waitFor(async () => (await style(p2, '.editor', 'backgroundColor')) === 'rgb(242, 232, 213)', { message: 'fond du thème' });
    assert.equal(await p2.getByLabel('Fond', { exact: true }).inputValue(), '#f2e8d5');
    await closePrefs(p2);
    await waitSetting(c, 'colors', { background: null, text: null, caret: null });
  } finally {
    await c.dispose();
  }
});

t('apparence : valeurs invalides du fichier de paramètres ignorées (couleur, largeur, interligne)', async () => {
  const c = await setup({
    files: { 'texte.txt': PROSE },
    open: ['texte.txt'],
    settings: { version: 1, theme: 'sepia', colors: { background: 'url(https://exemple.org/x.png)', text: '#12345', caret: 'red' }, editor: { columnWidth: 'géante', lineHeight: 900 } },
  });
  try {
    const { page } = c;
    assert.equal(await style(page, '.editor', 'backgroundColor'), 'rgb(242, 232, 213)', 'couleur du thème');
    assert.equal(await page.evaluate(() => document.getElementById('app').getAttribute('style') ?? ''), '', 'aucune propriété CSS injectée');
    assert.equal(await style(page, '.editor-text', 'lineHeight'), `${Math.round(17 * 2.5)}px`, 'interligne ramené à 2,5');
    const col = await column(page);
    assert.ok(col.chars > 72 && col.chars < 76, 'largeur inconnue : colonne moyenne');
    assert.match(await page.textContent('.app-bars'), /colors\.background/);
    const external = c.requests.filter((u) => !/^https?:\/\/127\.0\.0\.1[:/]/.test(u) && !u.startsWith('data:') && !u.startsWith('blob:'));
    assert.deepEqual(external, []);
  } finally {
    await c.dispose();
  }
});

t('palette : documents ouverts et récents (Ctrl+E), commandes (Ctrl+Maj+P), ligne', async () => {
  const c = await setup({ files: { 'projet/rapport_final.md': '# R\n', 'notes.txt': 'n' } });
  try {
    const { page } = c;
    await openFile(page, c.p('projet/rapport_final.md'));
    await openFile(page, c.p('notes.txt'));
    await waitFor(async () => (await tabNames(page)).join() === 'rapport_final.md,notes.txt', { message: 'deux onglets' });
    // Fermer le rapport : il reste dans les documents récents.
    await page.keyboard.press('Control+1');
    await page.keyboard.press('Control+w');
    await waitFor(async () => (await tabNames(page)).join() === 'notes.txt', { message: 'rapport fermé' });
    await page.keyboard.press('Control+e');
    await page.keyboard.type('rapfin');
    await page.locator('.palette-item', { hasText: 'rapport_final.md' }).waitFor({ timeout: 5000 });
    assert.match(await page.textContent('.palette-list'), /récent/);
    await page.keyboard.press('Enter');
    await waitFor(async () => (await activeTab(page)) === 'rapport_final.md', { message: 'réouvert depuis les récents' });
    await page.keyboard.press('Control+e');
    await page.keyboard.type('zzz');
    assert.match(await page.textContent('.palette-list'), /Aucun document ouvert ni récent/);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+p');
    await page.keyboard.type('retour automatique');
    await page.keyboard.press('Enter');
    await waitFor(() => page.$eval('.editor-text', (e) => e.getAttribute('wrap') === 'off'), { message: 'commande exécutée (retour à la ligne désactivé)' });
    await page.keyboard.press('Control+e');
    await page.keyboard.type(':1');
    assert.match(await page.textContent('.palette-list'), /Aller à la ligne 1/);
    await page.keyboard.press('Escape');
  } finally {
    await c.dispose();
  }
});

t('noms Unicode et espaces : ouverture et enregistrement', async () => {
  const c = await setup({ files: { 'Dossier été 2026/sous dossier/fichier final.txt': 'ok', '日本語.txt': 'こんにちは' } });
  try {
    const { page } = c;
    await openFile(page, c.p('Dossier été 2026/sous dossier/fichier final.txt'));
    await waitFor(async () => (await editorValue(page)) === 'ok', { message: 'chemin avec espaces et accents' });
    await openFile(page, c.p('日本語.txt'));
    await waitFor(async () => (await editorValue(page)) === 'こんにちは', { message: 'nom japonais' });
    assert.ok((await tabNames(page)).includes('日本語.txt'));
    await typeAtEnd(page, '!');
    await page.keyboard.press('Control+s');
    await waitSaved(page);
    assert.equal(readFileSync(c.p('日本語.txt'), 'utf8'), 'こんにちは!');
    // Chemin inexistant : message clair, aucun onglet vide créé.
    const before = (await tabNames(page)).length;
    await openFile(page, c.p('absent.txt'));
    await page.waitForTimeout(300);
    assert.equal((await tabNames(page)).length, before);
  } finally {
    await c.dispose();
  }
});
