import { readFileSync, writeFileSync } from 'node:fs';
import { setup, editorValue, tabNames, activeTab, typeAtEnd, dialogButton, dialogText, promptFill, waitFor, openFile, assert } from './lib.mjs';

export const tests = [];
const t = (name, fn) => tests.push({ name, fn });

t('quitter avec plusieurs documents modifiés : annuler, tout enregistrer', async () => {
  const c = await setup({ files: { 'a.txt': 'a', 'b.txt': 'b' }, open: ['a.txt', 'b.txt'] });
  try {
    const { page } = c;
    await typeAtEnd(page, '2');
    await page.locator('.tab', { hasText: 'a.txt' }).click();
    await typeAtEnd(page, '1');
    let quit = page.evaluate(() => window.__swiftpad.app.quit());
    assert.match(await dialogText(page), /2 documents contiennent des modifications non enregistrées/);
    await dialogButton(page, 'Annuler');
    await quit;
    assert.equal(readFileSync(c.p('a.txt'), 'utf8'), 'a');
    quit = page.evaluate(() => window.__swiftpad.app.quit());
    await dialogButton(page, 'Tout enregistrer');
    await quit;
    assert.equal(readFileSync(c.p('a.txt'), 'utf8'), 'a1');
    assert.equal(readFileSync(c.p('b.txt'), 'utf8'), 'b2');
  } finally {
    await c.dispose();
  }
});

t('fermeture rapide (option) : modifications restaurées au lancement suivant sans question', async () => {
  const c = await setup({ files: { 'h.txt': 'base' }, open: ['h.txt'] });
  try {
    let { page } = c;
    await page.evaluate(() => window.__swiftpad.settings.set('session.hotExit', true));
    await typeAtEnd(page, ' modifiée');
    await page.keyboard.press('Control+n');
    await page.keyboard.type('brouillon sans nom');
    await page.evaluate(() => window.__swiftpad.app.quit());
    assert.equal(await page.locator('.dlg-backdrop').count(), 0, 'aucune question');
    assert.equal(readFileSync(c.p('h.txt'), 'utf8'), 'base');
    page = await c.restart();
    await waitFor(async () => (await tabNames(page)).length === 2, { message: 'deux onglets restaurés' });
    assert.equal(await activeTab(page), 'Sans titre 1');
    await waitFor(async () => (await editorValue(page)) === 'brouillon sans nom', { message: 'brouillon restauré' });
    await page.locator('.tab', { hasText: 'h.txt' }).click();
    await waitFor(async () => (await editorValue(page)) === 'base modifiée', { message: 'modifications restaurées' });
    assert.equal(await page.$eval('.tab.active', (e) => e.classList.contains('dirty')), true);
  } finally {
    await c.dispose();
  }
});

t('120 onglets : ouverture, navigation, fermeture sans fuite de nœuds DOM', async () => {
  const files = {};
  for (let i = 0; i < 120; i++) files[`f${String(i).padStart(3, '0')}.txt`] = `contenu ${i}\n`.repeat(50);
  const c = await setup({ files });
  try {
    const { page } = c;
    const paths = Object.keys(files).map((f) => c.p(f));
    const counts = [];
    let openMs = 0;
    // Deux cycles ouverture/navigation/fermeture : aucune croissance d'un cycle à l'autre.
    for (let cycle = 0; cycle < 2; cycle++) {
      const t0 = Date.now();
      await page.evaluate(async (ps) => window.__swiftpad.ws.openPaths(ps), paths);
      openMs = Date.now() - t0;
      assert.equal((await tabNames(page)).length, 120);
      for (let i = 0; i < 10; i++) await page.keyboard.press('Control+Tab');
      const during = await page.evaluate(() => document.getElementsByTagName('*').length);
      await page.evaluate(() => window.__swiftpad.ws.closeMany(window.__swiftpad.ws.docs));
      await waitFor(async () => (await tabNames(page)).length === 0, { message: 'tous fermés' });
      const after = await page.evaluate(() => document.getElementsByTagName('*').length);
      counts.push([during, after]);
    }
    console.log(`      (120 fichiers ouverts en ${openMs} ms ; nœuds DOM ouverts/fermés : ${JSON.stringify(counts)})`);
    assert.equal(counts[1][1], counts[0][1], 'aucun nœud DOM conservé entre deux cycles');
    assert.ok(counts[1][0] <= counts[0][0] + 5, 'aucune croissance avec les onglets ouverts');
  } finally {
    await c.dispose();
  }
});

t('clavier seul : menus (Alt, F10, flèches, mnémoniques), F6, Échap, rôles ARIA', async () => {
  const c = await setup({ files: { 'k.txt': 'x', 'l.txt': 'y' }, open: ['k.txt', 'l.txt'] });
  try {
    const { page } = c;
    await page.focus('.editor-text');
    await page.keyboard.press('Alt+f');
    await page.locator('.menu').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'menuitem');
    await page.keyboard.press('ArrowRight');
    assert.match(await page.textContent('.menu'), /Annuler/, 'menu Édition atteint au clavier');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.menu').count(), 0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('F10');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('menubar-item')), true);
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    // F6 : éditeur → menus → onglets (affichés à partir de deux documents) → éditeur.
    await page.focus('.editor-text');
    await page.keyboard.press('F6');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'menuitem');
    await page.keyboard.press('F6');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'tab');
    await page.keyboard.press('F6');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('editor-text')), true);
    await page.keyboard.press('Shift+F6');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'tab', 'Maj+F6 : sens inverse');
    await page.keyboard.press('F6');
    // Ctrl+M : Tab déplace le focus (sortie de l'éditeur au clavier).
    await page.keyboard.press('Control+m');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('editor-text')), false);
    const roles = await page.evaluate(() => ['menubar', 'tablist', 'tab'].map((r) => document.querySelectorAll(`[role="${r}"]`).length > 0));
    assert.ok(roles.every(Boolean));
    assert.equal(await page.$eval('.editor-text', (e) => e.tagName), 'TEXTAREA', 'zone de texte native (lecteurs d’écran)');
    // Liste des raccourcis (F1).
    await page.keyboard.press('F1');
    assert.match(await dialogText(page), /Raccourcis clavier/);
    await page.keyboard.press('Escape');
  } finally {
    await c.dispose();
  }
});

t('aucun conflit de raccourcis ; raccourcis du navigateur neutralisés (F5, Ctrl+R, Alt+←)', async () => {
  const c = await setup({ files: { 'x.txt': 'x' }, open: ['x.txt'] });
  try {
    const { page } = c;
    assert.deepEqual(await page.evaluate(() => window.__swiftpad.app.commands.conflicts()), []);
    await page.evaluate(() => (window.__marker = 42));
    // Hors de la zone d'édition (focus sur la page elle-même).
    await page.evaluate(() => document.activeElement?.blur());
    for (const k of ['F5', 'Control+r', 'Alt+ArrowLeft', 'Control+Shift+r']) await page.keyboard.press(k);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__marker), 42, 'page non rechargée');
  } finally {
    await c.dispose();
  }
});

t('fenêtre étroite (520 px) et large (1920 px) : pas de débordement, éditeur utilisable', async () => {
  for (const viewport of [
    { width: 520, height: 600 },
    { width: 1920, height: 1080 },
  ]) {
    const c = await setup({ files: { 'w.txt': 'x'.repeat(500) }, open: ['w.txt'], viewport });
    try {
      const { page } = c;
      const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, ed: document.querySelector('.editor-text').getBoundingClientRect().width }));
      assert.ok(r.sw <= r.cw, `débordement horizontal (${r.sw} > ${r.cw})`);
      assert.ok(r.ed > 200, `éditeur trop étroit (${r.ed})`);
      await typeAtEnd(page, 'ok');
      assert.ok((await editorValue(page)).endsWith('ok'));
    } finally {
      await c.dispose();
    }
  }
});

t('impression : contenu préparé (texte du document, sans l’interface)', async () => {
  const c = await setup({ files: { 'p.txt': 'à imprimer\nligne 2' }, open: ['p.txt'] });
  try {
    const { page } = c;
    await page.evaluate(() => {
      window.__printed = null;
      window.print = () => (window.__printed = document.getElementById('print-root').innerText);
    });
    await page.keyboard.press('Control+p');
    await waitFor(() => page.evaluate(() => window.__printed), { message: 'impression demandée' });
    const printed = await page.evaluate(() => window.__printed);
    assert.match(printed, /à imprimer\nligne 2/);
    assert.match(printed, /p\.txt/);
  } finally {
    await c.dispose();
  }
});

t('recherche réactive dans un document de 2 Mo (seuil d’édition relevé à 2 Mo)', async () => {
  const text = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, cible.\n'.repeat(32_000);
  const c = await setup({ files: { 'deux.txt': text }, settings: { version: 1, files: { fluidEditMB: 2 } } });
  try {
    const { page } = c;
    await page.evaluate((p) => window.__swiftpad.ws.openPath(p), c.p('deux.txt'));
    await waitFor(async () => (await page.evaluate(() => document.querySelector('.editor-text').value.length)) === text.length, { timeout: 10000, message: 'chargé' });
    await page.keyboard.press('Control+f');
    const t0 = Date.now();
    await page.keyboard.type('cible');
    await waitFor(async () => /sur 32 000/.test((await page.textContent('.find-count')).replace(/ /g, ' ')), { timeout: 10000, message: 'comptage terminé' });
    const ms = Date.now() - t0;
    const lag = await page.evaluate(async () => {
      const t = performance.now();
      await new Promise((r) => setTimeout(r, 0));
      return performance.now() - t;
    });
    console.log(`      (32 000 occurrences comptées en ${ms} ms, frappe comprise)`);
    assert.ok(lag < 100, `interface réactive (${lag} ms)`);
    await page.keyboard.press('Control+h');
    await page.fill('.find-row input[placeholder="Remplacer par"]', 'cible!');
    await page.locator('.findbar button', { hasText: 'Tout remplacer' }).click();
    await waitFor(async () => /32 000 remplacements/.test((await page.textContent('.find-count')).replace(/ /g, ' ')), { timeout: 10000, message: 'remplacement global' });
    await page.focus('.editor-text');
    await page.keyboard.press('Control+z');
    await waitFor(async () => (await page.evaluate(() => document.querySelector('.editor-text').value.includes('cible!'))) === false, { message: 'annulé d’un bloc' });
  } finally {
    await c.dispose();
  }
});

t('document ouvert en tant que lien symbolique : cible signalée et préservée', async () => {
  const { symlinkSync } = await import('node:fs');
  const c = await setup({ files: { 'reel.txt': 'v1' } });
  try {
    symlinkSync(c.p('reel.txt'), c.p('lien.txt'));
    const { page } = c;
    await openFile(page, c.p('lien.txt'));
    await waitFor(async () => /lien vers/.test(await page.$eval('.infobars:not(.app-bars)', (e) => e.textContent)), { message: 'lien signalé' });
    await typeAtEnd(page, '+');
    await page.keyboard.press('Control+s');
    await waitFor(() => readFileSync(c.p('reel.txt'), 'utf8') === 'v1+', { message: 'cible modifiée' });
    const { lstatSync } = await import('node:fs');
    assert.ok(lstatSync(c.p('lien.txt')).isSymbolicLink(), 'le lien reste un lien');
  } finally {
    await c.dispose();
  }
});

t('nouveau document : Enregistrer sous dans un dossier inexistant, puis valide', async () => {
  const c = await setup();
  try {
    const { page } = c;
    await page.keyboard.press('Control+n');
    await page.keyboard.type('x');
    await page.keyboard.press('Control+s');
    await promptFill(page, c.p('absent/n.txt'));
    assert.match(await dialogText(page), /n'existe pas|n’existe pas/);
    await dialogButton(page, 'Enregistrer sous');
    await promptFill(page, c.p('n.txt'));
    await waitFor(() => {
      try {
        return readFileSync(c.p('n.txt'), 'utf8') === 'x';
      } catch {
        return false;
      }
    }, { message: 'enregistré au second essai' });
    writeFileSync(c.p('autre.txt'), '');
  } finally {
    await c.dispose();
  }
});
