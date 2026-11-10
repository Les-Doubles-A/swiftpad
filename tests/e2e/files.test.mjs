import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup, editorValue, tabNames, activeTab, statusText, infobarText, typeAtEnd, dialogButton, dialogText, waitSaved, waitFor, openFile, promptFill, assert } from './lib.mjs';

export const tests = [];
const t = (name, fn) => tests.push({ name, fn });

t('paramètres conservés après redémarrage', async () => {
  const c = await setup({ files: { 'a.txt': 'x' }, open: ['a.txt'] });
  try {
    let { page } = c;
    await page.keyboard.press('Alt+z');
    await page.click('.menubar-item:has-text("Affichage")');
    await page.locator('.menu-item', { hasText: 'Thème' }).hover();
    await page.locator('.menu-item', { hasText: 'Thème sombre' }).click();
    await waitFor(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark'), { message: 'thème sombre appliqué' });
    await page.waitForTimeout(700); // enregistrement différé des paramètres
    page = await c.restart();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    // Retour à la ligne actif par défaut, désactivé par Alt+Z.
    assert.equal(await page.$eval('.editor-text', (e) => e.getAttribute('wrap')), 'off');
    const saved = JSON.parse(readFileSync(join(c.data, 'config', 'settings.json'), 'utf8'));
    assert.equal(saved.theme, 'dark');
    assert.equal(saved.editor.wordWrap, false);
    assert.equal(saved.version, 1);
  } finally {
    await c.dispose();
  }
});

t('paramètres corrompus : démarrage avec les valeurs par défaut, fichier conservé', async () => {
  const c = await setup({ settings: '{ "theme": "dark", cassé' });
  try {
    const { page } = c;
    assert.match(await page.textContent('.app-bars'), /endommagé/);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme ?? 'system'), 'system');
    const kept = readdirSync(join(c.data, 'config')).filter((f) => f.startsWith('settings.corrupt-'));
    assert.equal(kept.length, 1, 'copie du fichier endommagé conservée');
  } finally {
    await c.dispose();
  }
});

t('paramètre invalide : seul ce champ reprend sa valeur par défaut', async () => {
  const c = await setup({ settings: { version: 1, theme: 'dark', editor: { fontSize: 'énorme', wordWrap: true } } });
  try {
    const { page } = c;
    assert.match(await page.textContent('.app-bars'), /editor\.fontSize/);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await page.$eval('.editor-text', (e) => e.getAttribute('wrap')), 'soft');
  } finally {
    await c.dispose();
  }
});

t('session restaurée (sans charger les onglets inactifs), désactivable', async () => {
  const c = await setup({ files: { 'un.txt': 'premier', 'deux.md': '# Deux' }, open: ['un.txt', 'deux.md'] });
  try {
    let { page } = c;
    await page.waitForTimeout(1300); // session enregistrée de façon différée
    page = await c.restart();
    assert.deepEqual(await tabNames(page), ['un.txt', 'deux.md']);
    assert.equal(await activeTab(page), 'deux.md');
    const loaded = await page.evaluate(() => window.__swiftpad.ws.docs.map((d) => d.loaded));
    assert.deepEqual(loaded, [false, true], 'onglet inactif non chargé au démarrage');
    await page.locator('.tab', { hasText: 'un.txt' }).click();
    await waitFor(async () => (await editorValue(page)) === 'premier', { message: 'chargement à l’activation' });
    // Désactivation : plus aucun chemin mémorisé.
    await page.evaluate(() => window.__swiftpad.settings.set('session.restore', false));
    await page.waitForTimeout(700);
    page = await c.restart();
    assert.deepEqual(await tabNames(page), ['Sans titre 1']);
    assert.equal(existsSync(join(c.data, 'config', 'session.json')), false, 'fichier de session supprimé');
  } finally {
    await c.dispose();
  }
});

t('récupération après un arrêt inattendu (copie locale), puis suppression des copies', async () => {
  const c = await setup({ files: { 'r.txt': 'enregistré' }, open: ['r.txt'] });
  try {
    let { page } = c;
    await typeAtEnd(page, ' + brouillon non enregistré');
    await page.keyboard.press('Control+n');
    await page.keyboard.type('note jamais enregistrée');
    const recDir = join(c.data, 'data', 'recovery');
    await waitFor(() => existsSync(recDir) && readdirSync(recDir).filter((f) => f.endsWith('.txt')).length === 2, { timeout: 8000, message: 'copies de récupération écrites' });
    assert.match(await page.textContent('.app-bars'), /copiées localement/, 'avertissement affiché une fois');
    // Arrêt brutal (processus tué, aucune fermeture propre).
    await c.stop(true);
    page = await c.launch([]);
    await waitFor(async () => /2 document\(s\) non enregistré\(s\)/.test(await page.textContent('.app-bars')), { message: 'proposition de récupération' });
    await page.locator('.app-bars button', { hasText: 'Restaurer' }).click();
    await waitFor(async () => (await tabNames(page)).length >= 2 && (await tabNames(page)).includes('r.txt'), { message: 'documents restaurés' });
    await page.locator('.tab', { hasText: 'r.txt' }).click();
    assert.equal(await editorValue(page), 'enregistré + brouillon non enregistré');
    assert.equal(await page.$eval('.tab.active', (e) => e.classList.contains('dirty')), true);
    assert.equal(readFileSync(c.p('r.txt'), 'utf8'), 'enregistré', 'le fichier n’a pas été modifié sans action');
    await page.keyboard.press('Control+s');
    await waitSaved(page);
    assert.equal(readFileSync(c.p('r.txt'), 'utf8'), 'enregistré + brouillon non enregistré');
    // Désactiver la récupération supprime immédiatement toutes les copies.
    await page.evaluate(() => window.__swiftpad.settings.set('session.recovery', false));
    await waitFor(() => readdirSync(recDir).length === 0, { message: 'copies purgées' });
  } finally {
    await c.dispose();
  }
});

t('images, SVG (sans script) et fichiers binaires : aperçu ou fiche, jamais chargés comme texte', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>window.top.__pwned = 1</script><rect width="10" height="10"/></svg>';
  const bin = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0)]);
  const c = await setup({ files: { 'img.png': png, 'logo.svg': svg, 'prog.exe': bin, 'data.bin': Buffer.from([1, 2, 0, 3, 4]) } });
  try {
    const { page } = c;
    await openFile(page, c.p('img.png'));
    await waitFor(() => page.locator('.imageview img').evaluate((i) => i.complete && i.naturalWidth === 1), { message: 'image affichée' });
    await openFile(page, c.p('logo.svg'));
    await waitFor(() => page.locator('.imageview img').evaluate((i) => i.complete && i.naturalWidth === 10), { message: 'SVG affiché' });
    assert.equal(await page.evaluate(() => window.__pwned), undefined, 'aucun script du SVG exécuté');
    await openFile(page, c.p('prog.exe'));
    await waitFor(async () => /exécutable Windows/.test(await page.textContent('.infoview')), { message: 'fiche du binaire' });
    await openFile(page, c.p('data.bin'));
    await waitFor(async () => /octets nuls/.test(await page.textContent('.infoview')), { message: 'fiche data.bin' });
    await page.locator('.infoview button', { hasText: 'Ouvrir comme texte' }).click();
    assert.match(await dialogText(page), /ne semble pas être un fichier texte/);
    await dialogButton(page, 'Afficher comme texte');
    await waitFor(async () => /lecture seule pour éviter/.test(await infobarText(page)), { message: 'binaire en lecture seule' });
    assert.equal(await page.$eval('.editor-text', (e) => e.readOnly), true);
  } finally {
    await c.dispose();
  }
});

t('gros fichier : lecture rapide sans blocage, aller à la ligne, recherche, édition sur demande', async () => {
  const lines = [];
  for (let i = 1; i <= 400_000; i++) lines.push(`${String(i).padStart(7, '0')} journal ${i % 997 === 0 ? 'ERREUR critique' : 'ok'} ${'x'.repeat(40)}`);
  const text = lines.join('\n') + '\n';
  const c = await setup({ files: { 'gros.log': text } });
  try {
    const { page } = c;
    const size = Buffer.byteLength(text);
    assert.ok(size > 20 * 1024 * 1024, `fichier de test : ${size} octets`);
    const t0 = Date.now();
    await openFile(page, c.p('gros.log'));
    await page.locator('.bigview .big-row', { hasText: '0000001 journal' }).waitFor({ timeout: 10000 });
    const firstMs = Date.now() - t0;
    // L'interface reste réactive pendant l'indexation.
    const lag = await page.evaluate(async () => {
      const t = performance.now();
      await new Promise((r) => setTimeout(r, 0));
      return performance.now() - t;
    });
    assert.ok(lag < 200, `boucle d'événements bloquée ${lag} ms`);
    await waitFor(async () => /400 001 lignes/.test((await page.textContent('.big-status')).replace(/ /g, ' ')), { timeout: 30000, message: 'indexation terminée' });
    await page.keyboard.press('Control+g');
    const input = page.locator('.dlg-backdrop input');
    await input.fill('350000');
    await input.press('Enter');
    await page.locator('.big-row.hl', { hasText: '0350000 journal' }).waitFor({ timeout: 5000 });
    await page.fill('.big-header input', 'ERREUR');
    await page.press('.big-header input', 'Enter');
    await waitFor(async () => /401 résultat\(s\)/.test((await page.textContent('.big-res-head')).replace(/ /g, ' ')), { timeout: 30000, message: 'recherche terminée' });
    // Taille au-delà du seuil d'édition à la demande (16 Mo par défaut) : bouton masqué.
    assert.equal(await page.locator('.bigview button', { hasText: 'Modifier quand même' }).isHidden(), true);
    console.log(`      (premières lignes affichées en ${firstMs} ms pour ${(size / 1048576).toFixed(1)} Mo)`);
  } finally {
    await c.dispose();
  }
});

t('fichier moyen (3 Mo) : lecture rapide puis « Modifier quand même »', async () => {
  const text = 'ligne de texte assez longue pour remplir 3 Mo rapidement\n'.repeat(55_000);
  const c = await setup({ files: { 'moyen.txt': text } });
  try {
    const { page } = c;
    await openFile(page, c.p('moyen.txt'));
    await page.locator('.bigview button', { hasText: 'Modifier quand même' }).click();
    await dialogButton(page, 'Charger dans l’éditeur');
    await waitFor(async () => (await page.evaluate(() => document.querySelector('.editor-text').value.length)) === text.length, { timeout: 15000, message: 'texte chargé' });
    assert.match(await infobarText(page), /Gros document/);
    await typeAtEnd(page, 'fin');
    await page.keyboard.press('Control+s');
    await waitSaved(page);
    assert.equal(readFileSync(c.p('moyen.txt'), 'utf8'), text + 'fin');
  } finally {
    await c.dispose();
  }
});

t('accès refusés réels (utilisateur sans privilèges)', async () => {
  if (process.getuid?.() !== 0) {
    console.log('      (ignoré : nécessite root pour lancer le harnais sous « nobody »)');
    return;
  }
  const c = await setup({ files: { 'secret.txt': 'x', 'verrou/a.txt': 'a', 'ok.txt': 'ok' }, asUser: 65534 });
  try {
    const { page } = c;
    execFileSync('chmod', ['000', c.p('secret.txt')]);
    execFileSync('chmod', ['555', c.p('verrou')]);
    await openFile(page, c.p('secret.txt'));
    assert.match(await dialogText(page), /Accès refusé/);
    await dialogButton(page, 'OK');
    // « Enregistrer sous » un nouveau fichier dans un dossier verrouillé : refusé.
    await page.keyboard.press('Control+n');
    await page.keyboard.type('brouillon');
    await page.keyboard.press('Control+s');
    await promptFill(page, c.p('verrou/nouveau.txt'));
    assert.match(await dialogText(page), /Enregistrement impossible.*Accès refusé/);
    await dialogButton(page, 'Annuler');
    assert.equal(existsSync(c.p('verrou/nouveau.txt')), false);
    // Enregistrement dans un dossier verrouillé : écriture sur place, signalée.
    await openFile(page, c.p('verrou/a.txt'));
    await typeAtEnd(page, '!');
    await page.keyboard.press('Control+s');
    await waitSaved(page);
    assert.equal(readFileSync(c.p('verrou/a.txt'), 'utf8'), 'a!');
    assert.match(await statusText(page), /écriture atomique impossible/);
  } finally {
    await c.dispose();
  }
});

t('disque plein : erreur explicite, fichier d’origine intact', async () => {
  if (process.getuid?.() !== 0) {
    console.log('      (ignoré : montage tmpfs impossible sans root)');
    return;
  }
  const c = await setup();
  const mnt = join(c.root, 'plein');
  mkdirSync(mnt);
  try {
    execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=64k', 'tmpfs', mnt]);
  } catch {
    console.log('      (ignoré : montage tmpfs refusé)');
    await c.dispose();
    return;
  }
  try {
    writeFileSync(join(mnt, 'petit.txt'), 'original');
    const { page } = c;
    await page.evaluate((p) => window.__swiftpad.ws.openPath(p), join(mnt, 'petit.txt'));
    await waitFor(async () => (await editorValue(page)) === 'original', { message: 'ouvert' });
    await page.evaluate(() => {
      const v = window.__swiftpad.ws.view;
      v.insertText('x'.repeat(200_000));
    });
    await page.keyboard.press('Control+s');
    assert.match(await dialogText(page), /Espace disque insuffisant/);
    assert.match(await dialogText(page), /n’a pas été modifié/);
    await dialogButton(page, 'Annuler');
    assert.equal(readFileSync(join(mnt, 'petit.txt'), 'utf8'), 'original');
    assert.deepEqual(readdirSync(mnt), ['petit.txt'], 'aucun fichier temporaire laissé');
  } finally {
    await c.dispose().catch(() => {});
    try {
      execFileSync('umount', [mnt]);
    } catch {
      /* déjà démonté */
    }
    rmSync(c.root, { recursive: true, force: true });
  }
});

t('aucune requête réseau : tout reste sur 127.0.0.1 (scénario complet)', async () => {
  const md = '# Titre\n\n![distante](https://exemple.org/pixel.png)\n\n[lien](https://exemple.org)\n\n<img src="http://exemple.org/x.png">\n';
  const c = await setup({ files: { 'doc.md': md, 'a.txt': 'abc' }, open: ['doc.md', 'a.txt'] });
  try {
    const { page } = c;
    await page.locator('.tab', { hasText: 'doc.md' }).click();
    await page.keyboard.press('Control+Shift+v');
    await page.locator('.md-body h1').waitFor();
    await page.keyboard.press('Control+e');
    await page.keyboard.type('a');
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await page.locator('.tab', { hasText: 'a.txt' }).click();
    await page.keyboard.press('Control+f');
    await page.keyboard.type('abc');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    // Préférences (polices, couleurs) : rien n'est téléchargé.
    await page.keyboard.press('Control+,');
    await page.locator('.prefs').waitFor();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const external = c.requests.filter((u) => !/^https?:\/\/127\.0\.0\.1[:/]/.test(u) && !u.startsWith('blob:') && !u.startsWith('data:'));
    assert.deepEqual(external, [], 'requêtes hors machine locale');
    assert.match(await page.textContent('.md-body'), /Image distante non chargée/);
  } finally {
    await c.dispose();
  }
});

t('mesures de démarrage : écrites seulement si SWIFTPAD_PERF_LOG est définie ; « À propos » les affiche', async () => {
  // Sans la variable : aucun fichier de mesures.
  const c1 = await setup({ files: { 'a.txt': 'a' } });
  try {
    const log = join(c1.root, 'jamais.jsonl');
    await c1.page.waitForTimeout(1300);
    assert.equal(existsSync(log), false);
    // « À propos » : mesures locales de la session.
    await c1.page.evaluate(() => window.__swiftpad.app.commands.get('help.about').run());
    const txt = await dialogText(c1.page);
    assert.match(txt, /Lancement → interface prête/);
    assert.match(txt, /Tas JavaScript utilisé|Éléments de l’interface/);
    await dialogButton(c1.page, 'Fermer');
  } finally {
    await c1.dispose();
  }
  // Avec la variable : une ligne JSON après 1 s de repos.
  const dir = join(c1.root + '-perf');
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'perf.jsonl');
  process.env.SWIFTPAD_PERF_LOG = log;
  let c2;
  try {
    c2 = await setup({ files: { 'a.txt': 'a' } });
  } finally {
    delete process.env.SWIFTPAD_PERF_LOG;
  }
  try {
    await waitFor(() => existsSync(log) && readFileSync(log, 'utf8').includes('\n'), { timeout: 5000, message: 'ligne de mesures' });
    const m = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]);
    assert.ok(m.ui.scriptToReadyMs > 0 && m.ui.scriptToReadyMs < 10000, `scriptToReadyMs=${m.ui.scriptToReadyMs}`);
    assert.ok(m.ui.processToReadyMs > 0, `processToReadyMs=${m.ui.processToReadyMs}`);
    assert.ok(m.ui.domNodes > 0 && m.nativeResidentBytes > 0);
    assert.ok(m.marks.some((x) => x.name === 'ui-ready'));
  } finally {
    await c2.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

t('gros fichier binaire (3 Mo) : fiche d’information, jamais affiché comme texte sans confirmation', async () => {
  const bin = Buffer.alloc(3 * 1024 * 1024);
  bin.write('PK\x03\x04', 0, 'latin1');
  for (let i = 4; i < bin.length; i++) bin[i] = (i * 7919) % 251;
  const c = await setup({ files: { 'archive.zip': bin, 'journal.log': 'ok\n' } });
  try {
    const { page } = c;
    await openFile(page, c.p('archive.zip'));
    await waitFor(async () => /archive ZIP|ZIP/.test(await page.textContent('.infoview')), { message: 'fiche du gros binaire' });
    assert.equal(await page.locator('.bigview .big-row').count(), 0, 'lecteur de gros fichiers non utilisé');
    // Confirmation explicite : affichage dans le lecteur rapide (lecture seule).
    await page.locator('.infoview button', { hasText: 'Ouvrir comme texte' }).click();
    await dialogButton(page, 'Afficher comme texte');
    await page.locator('.bigview .big-row').first().waitFor({ timeout: 10000 });
    assert.equal(readFileSync(c.p('archive.zip')).equals(bin), true, 'fichier intact');
  } finally {
    await c.dispose();
  }
});
