import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { setup, editorValue, tabNames, activeTab, statusText, infobarText, typeAtEnd, dialogButton, dialogText, promptFill, waitNoDialog, waitSaved, waitFor, openFile, assert } from './lib.mjs';

export const tests = [];
const t = (name, fn) => tests.push({ name, fn });

t('ouvrir, modifier et enregistrer un TXT (CRLF conservé)', async () => {
  const c = await setup({ files: { 'notes.txt': 'ligne 1\r\nligne 2\r\n' }, open: ['notes.txt'] });
  try {
    const { page } = c;
    assert.equal(await editorValue(page), 'ligne 1\nligne 2\n');
    assert.match(await statusText(page), /CRLF/);
    await typeAtEnd(page, 'ajout é');
    await waitFor(async () => (await page.$eval('.tab.active', (e) => e.classList.contains('dirty'))), { message: 'indicateur de modification' });
    assert.match(await page.title(), /^● notes\.txt/);
    await page.keyboard.press('Control+s');
    await waitSaved(page);
    assert.equal(readFileSync(c.p('notes.txt'), 'utf8'), 'ligne 1\r\nligne 2\r\najout é');
    assert.equal(await page.$eval('.tab.active', (e) => e.classList.contains('dirty')), false);
    assert.doesNotMatch(await page.title(), /●/);
  } finally {
    await c.dispose();
  }
});

t('nouveau document puis Enregistrer sous (fin de ligne par défaut CRLF)', async () => {
  const c = await setup();
  try {
    const { page } = c;
    await page.keyboard.press('Control+n');
    await page.keyboard.type('premier\nsecond');
    await page.keyboard.press('Control+s');
    await promptFill(page, c.p('nouveau.txt'));
    await waitSaved(page);
    assert.equal(readFileSync(c.p('nouveau.txt'), 'utf8'), 'premier\r\nsecond');
    assert.ok((await tabNames(page)).includes('nouveau.txt'));
    // Enregistrer sous un autre nom : l'original reste intact.
    await page.keyboard.type('!');
    await page.keyboard.press('Control+Shift+s');
    await promptFill(page, c.p('copie.md'));
    await waitSaved(page);
    assert.equal(readFileSync(c.p('copie.md'), 'utf8'), 'premier\r\nsecond!');
    assert.equal(readFileSync(c.p('nouveau.txt'), 'utf8'), 'premier\r\nsecond');
    assert.equal(await activeTab(page), 'copie.md');
    assert.match(await statusText(page), /Markdown/);
  } finally {
    await c.dispose();
  }
});

t('fichier vide', async () => {
  const c = await setup({ files: { 'vide.txt': '' }, open: ['vide.txt'] });
  try {
    const { page } = c;
    assert.equal(await editorValue(page), '');
    assert.match(await statusText(page), /1 ligne, 0 caractère/);
    await typeAtEnd(page, 'x');
    await page.keyboard.press('Control+s');
    await waitSaved(page);
    assert.equal(readFileSync(c.p('vide.txt'), 'utf8'), 'x');
  } finally {
    await c.dispose();
  }
});

t('encodages : UTF-16 LE/BE avec BOM, UTF-8 BOM et Windows-1252 conservés', async () => {
  const u16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Émoji 😀\r\nfin', 'utf16le')]);
  const u16be = Buffer.from(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('BE ok', 'utf16le').swap16()]));
  const bom8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('avec BOM\n', 'utf8')]);
  const ansi = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x0d, 0x0a]); // « café € »
  const c = await setup({ files: { 'le.txt': u16le, 'be.txt': u16be, 'bom.txt': bom8, 'ansi.txt': ansi }, open: ['le.txt', 'be.txt', 'bom.txt', 'ansi.txt'] });
  try {
    const { page } = c;
    // Windows-1252 : détection incertaine signalée.
    assert.equal(await editorValue(page), 'café €\n');
    assert.match(await statusText(page), /Windows-1252 \(ANSI\) \(\?\)/);
    assert.match(await infobarText(page), /incertitude/);
    await typeAtEnd(page, 'à');
    await page.keyboard.press('Control+s');
    await waitSaved(page);
    assert.deepEqual([...readFileSync(c.p('ansi.txt'))], [0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x0d, 0x0a, 0xe0]);
    for (const [name, check] of [
      ['le.txt', (b) => b[0] === 0xff && b[1] === 0xfe && b.subarray(2).toString('utf16le') === 'Émoji 😀\r\nfin+'],
      ['be.txt', (b) => b[0] === 0xfe && b[1] === 0xff && Buffer.from(b.subarray(2)).swap16().toString('utf16le') === 'BE ok+'],
      ['bom.txt', (b) => b[0] === 0xef && b.subarray(3).toString('utf8') === 'avec BOM\n+'],
    ]) {
      await page.locator('.tab', { hasText: name }).click();
      await typeAtEnd(page, '+');
      await page.keyboard.press('Control+s');
      await waitSaved(page);
      assert.ok(check(readFileSync(c.p(name))), `${name} : octets inattendus ${[...readFileSync(c.p(name))].slice(0, 12)}`);
    }
    await page.locator('.tab', { hasText: 'le.txt' }).click();
    assert.match(await statusText(page), /UTF-16 LE/);
  } finally {
    await c.dispose();
  }
});

t('caractère impossible en Windows-1252 : enregistrement bloqué, rien n’est remplacé', async () => {
  const c = await setup({ files: { 'ansi.txt': Buffer.from([0x63, 0xe9]) }, open: ['ansi.txt'] });
  try {
    const { page } = c;
    await typeAtEnd(page, ' ✓');
    await page.keyboard.press('Control+s');
    assert.match(await dialogText(page), /ne peut pas être enregistré/);
    await dialogButton(page, 'Annuler');
    assert.deepEqual([...readFileSync(c.p('ansi.txt'))], [0x63, 0xe9]);
    await page.keyboard.press('Control+s');
    await dialogButton(page, 'Enregistrer en UTF-8');
    await waitSaved(page);
    assert.equal(readFileSync(c.p('ansi.txt'), 'utf8'), 'cé ✓');
  } finally {
    await c.dispose();
  }
});

t('UTF-8 invalide : remplacement signalé et confirmation avant enregistrement', async () => {
  const c = await setup({ files: { 'bad.txt': Buffer.from([0x61, 0xff, 0x62, 0x0a, 0xc3]) }, open: ['bad.txt'] });
  try {
    const { page } = c;
    // Octets non UTF-8 : lus sans perte en Windows-1252, détection signalée incertaine.
    assert.match(await infobarText(page), /incertitude/);
    assert.equal(await editorValue(page), 'aÿb\nÃ');
    // Rouvrir de force en UTF-8 : les séquences invalides sont comptées et signalées.
    await page.locator('.infobar button', { hasText: 'Rouvrir en UTF-8' }).click();
    await waitFor(async () => /invalide/.test(await infobarText(page)), { message: 'barre de séquences invalides' });
    assert.equal(await editorValue(page), 'a�b\n�');
    await typeAtEnd(page, 'z');
    await page.keyboard.press('Control+s');
    assert.match(await dialogText(page), /illisible/);
    await dialogButton(page, 'Annuler');
    assert.deepEqual([...readFileSync(c.p('bad.txt'))], [0x61, 0xff, 0x62, 0x0a, 0xc3]);
    // Rouvrir en Windows-1252 conserve les octets d'origine.
    await page.locator('.infobar button', { hasText: 'Windows-1252' }).click();
    await dialogButton(page, 'Rouvrir');
    await waitNoDialog(page);
    await waitFor(async () => (await editorValue(page)) === 'aÿb\nÃ', { message: 'texte relu en Windows-1252' });
    assert.deepEqual([...readFileSync(c.p('bad.txt'))], [0x61, 0xff, 0x62, 0x0a, 0xc3], 'octets d’origine intacts');
  } finally {
    await c.dispose();
  }
});

t('fins de ligne : LF conservé, conversion explicite, CR seul, mélange signalé', async () => {
  // Barre d'état affichée (masquée par défaut) : menu des fins de ligne.
  const c = await setup({ files: { 'unix.txt': 'a\nb\n', 'mac.txt': 'x\ry\r', 'mixte.txt': 'a\r\nb\nc\r\n' }, open: ['unix.txt', 'mac.txt', 'mixte.txt'], settings: { version: 1, ui: { statusBar: true } } });
  try {
    const { page } = c;
    assert.match(await infobarText(page), /mixtes \(2 CRLF, 1 LF\)/);
    await page.locator('.tab', { hasText: 'mac.txt' }).click();
    assert.match(await statusText(page), /CR(?!LF)/);
    await typeAtEnd(page, 'z');
    await page.keyboard.press('Control+s');
    await waitSaved(page);
    assert.equal(readFileSync(c.p('mac.txt'), 'utf8'), 'x\ry\rz');
    await page.locator('.tab', { hasText: 'unix.txt' }).click();
    await page.click('.sb-eol');
    await page.locator('.menu-item', { hasText: 'Windows (CRLF)' }).click();
    await waitFor(async () => page.$eval('.tab.active', (e) => e.classList.contains('dirty')), { message: 'changement de fin de ligne = modification' });
    assert.match(await statusText(page), /CRLF/);
    await page.keyboard.press('Control+s');
    await waitSaved(page);
    assert.equal(readFileSync(c.p('unix.txt'), 'utf8'), 'a\r\nb\r\n');
  } finally {
    await c.dispose();
  }
});

t('recherche, suivant/précédent, casse, mot entier, expression régulière, remplacement', async () => {
  const c = await setup({ files: { 'r.txt': 'Chat chat CHAT chats\nle chat dort\n' }, open: ['r.txt'] });
  try {
    const { page } = c;
    await page.keyboard.press('Control+f');
    await page.keyboard.type('chat');
    await waitFor(async () => /1 sur 5/.test(await page.textContent('.find-count')), { message: 'compteur 1 sur 5' });
    await page.keyboard.press('Enter');
    await waitFor(async () => /2 sur 5/.test(await page.textContent('.find-count')), { message: 'compteur 2 sur 5' });
    await page.keyboard.press('Shift+F3');
    await waitFor(async () => /1 sur 5/.test(await page.textContent('.find-count')), { message: 'retour 1 sur 5' });
    // Occurrence active mise en évidence même sans le focus de l'éditeur.
    await waitFor(async () => (await page.locator('.editor-overlay .oa').count()) === 1, { message: 'occurrence active surlignée' });
    await page.keyboard.press('Alt+w');
    await waitFor(async () => /4 résultats|sur 4/.test(await page.textContent('.find-count')), { message: 'mot entier : 4' });
    await page.keyboard.press('Alt+c');
    await waitFor(async () => /sur 2|2 résultats/.test(await page.textContent('.find-count')), { message: 'casse + mot : 2' });
    await page.keyboard.press('Alt+r');
    await page.fill('.find-input', 'ch(');
    await waitFor(async () => /invalide/.test((await page.textContent('.find-error')) ?? ''), { message: 'erreur d’expression' });
    await page.keyboard.press('Escape');
    // Remplacement (expression régulière avec groupe).
    await page.keyboard.press('Control+h');
    await page.fill('.find-input', '(c)hat');
    await page.fill('.find-row input[placeholder="Remplacer par"]', '$1hien');
    await page.locator('.findbar button', { hasText: 'Tout remplacer' }).click();
    await waitFor(async () => (await editorValue(page)) === 'Chat chien CHAT chats\nle chien dort\n', { message: 'remplacement global' });
    assert.match(await page.textContent('.find-count'), /2 remplacements/);
    // Un seul « Annuler » défait le remplacement global.
    await page.focus('.editor-text');
    await page.keyboard.press('Control+z');
    assert.equal(await editorValue(page), 'Chat chat CHAT chats\nle chat dort\n');
  } finally {
    await c.dispose();
  }
});

t('annuler et rétablir, isolés par onglet (pile native de Chromium contournée)', async () => {
  const c = await setup({ files: { 'a.txt': 'A', 'b.txt': 'B' }, open: ['a.txt', 'b.txt'] });
  try {
    const { page } = c;
    await page.locator('.tab', { hasText: 'a.txt' }).click();
    await typeAtEnd(page, '1');
    await page.locator('.tab', { hasText: 'b.txt' }).click();
    await typeAtEnd(page, '2');
    await page.keyboard.press('Control+z');
    assert.equal(await editorValue(page), 'B');
    await page.keyboard.press('Control+z');
    assert.equal(await editorValue(page), 'B', 'aucune annulation ne fuit vers un autre onglet');
    await page.locator('.tab', { hasText: 'a.txt' }).click();
    assert.equal(await editorValue(page), 'A1');
    await page.keyboard.press('Control+z');
    assert.equal(await editorValue(page), 'A');
    assert.equal(await page.$eval('.tab.active', (e) => e.classList.contains('dirty')), false, 'retour à l’état enregistré');
    await page.keyboard.press('Control+y');
    assert.equal(await editorValue(page), 'A1');
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await editorValue(page), 'A1');
    // Opérations sur les lignes, chacune annulable d'un bloc.
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('B');
    assert.equal(await editorValue(page), 'A1\nB');
    await page.keyboard.press('Alt+ArrowUp');
    assert.equal(await editorValue(page), 'B\nA1');
    await page.keyboard.press('Control+d');
    assert.equal(await editorValue(page), 'B\nB\nA1');
    await page.keyboard.press('Control+Shift+k');
    assert.equal(await editorValue(page), 'B\nA1');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    assert.equal(await editorValue(page), 'A1\nB');
    // Menu Édition > Annuler (frappe « B » puis saut de ligne).
    await page.click('.menubar-item:has-text("Édition")');
    await page.locator('.menu-item', { hasText: 'Annuler' }).click();
    await waitFor(async () => (await editorValue(page)) === 'A1\n', { message: 'annulation par le menu' });
  } finally {
    await c.dispose();
  }
});

t('fermeture d’un document modifié : annuler, ne pas enregistrer, enregistrer', async () => {
  const c = await setup({ files: { 'f.txt': 'base' }, open: ['f.txt'] });
  try {
    const { page } = c;
    await typeAtEnd(page, '+');
    await page.keyboard.press('Control+w');
    assert.match(await dialogText(page), /enregistrer les modifications apportées à « f\.txt »/);
    await dialogButton(page, 'Annuler');
    assert.ok((await tabNames(page)).includes('f.txt'));
    await page.keyboard.press('Control+w');
    await dialogButton(page, 'Ne pas enregistrer');
    await waitFor(async () => !(await tabNames(page)).includes('f.txt'), { message: 'onglet fermé' });
    assert.equal(readFileSync(c.p('f.txt'), 'utf8'), 'base');
    // Rouvrir l'onglet fermé, modifier, fermer en enregistrant.
    await page.keyboard.press('Control+Shift+t');
    await waitFor(async () => (await tabNames(page)).includes('f.txt') && (await editorValue(page)) === 'base', { message: 'onglet rouvert et chargé' });
    await typeAtEnd(page, '!');
    await page.keyboard.press('Control+w');
    await dialogButton(page, 'Enregistrer');
    await waitFor(() => readFileSync(c.p('f.txt'), 'utf8') === 'base!', { message: 'enregistré à la fermeture' });
  } finally {
    await c.dispose();
  }
});

t('conflit : fichier modifié par un autre programme', async () => {
  const c = await setup({ files: { 'c.txt': 'v1' }, open: ['c.txt'] });
  try {
    const { page } = c;
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(c.p('c.txt'), 'version externe');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitFor(async () => /modifié par un autre programme/.test(await infobarText(page)), { message: 'barre de modification externe' });
    await typeAtEnd(page, ' mienne');
    await page.keyboard.press('Control+s');
    assert.match(await dialogText(page), /modifié par un autre programme/);
    await dialogButton(page, 'Annuler');
    assert.equal(readFileSync(c.p('c.txt'), 'utf8'), 'version externe', 'aucun écrasement silencieux');
    await page.keyboard.press('Control+s');
    await dialogButton(page, 'Écraser');
    await waitSaved(page);
    assert.equal(readFileSync(c.p('c.txt'), 'utf8'), 'v1 mienne');
    // Rechargement depuis la barre d'information.
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(c.p('c.txt'), 'encore changé');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.locator('.infobar button', { hasText: 'Recharger' }).first().click({ timeout: 5000 });
    await waitFor(async () => (await editorValue(page)) === 'encore changé', { message: 'rechargé' });
  } finally {
    await c.dispose();
  }
});

t('fichier supprimé ou déplacé pendant son ouverture', async () => {
  const c = await setup({ files: { 'd.txt': 'contenu' }, open: ['d.txt'] });
  try {
    const { page } = c;
    const { renameSync } = await import('node:fs');
    renameSync(c.p('d.txt'), c.p('ailleurs.txt'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitFor(async () => /supprimé ou déplacé/.test(await infobarText(page)), { message: 'barre fichier introuvable' });
    assert.equal(await page.$eval('.tab.active', (e) => e.classList.contains('missing')), true);
    assert.match(await statusText(page), /Fichier introuvable/);
    await typeAtEnd(page, '!');
    await page.keyboard.press('Control+s');
    assert.match(await dialogText(page), /supprimé ou déplacé/);
    await dialogButton(page, 'Recréer le fichier');
    await waitSaved(page);
    assert.equal(readFileSync(c.p('d.txt'), 'utf8'), 'contenu!');
    assert.equal(readFileSync(c.p('ailleurs.txt'), 'utf8'), 'contenu', 'fichier déplacé intact');
  } finally {
    await c.dispose();
  }
});

t('fichier en lecture seule : édition bloquée, Enregistrer propose un autre nom', async () => {
  const c = await setup({ files: { 'ro.txt': 'protégé' } });
  try {
    const { chmodSync } = await import('node:fs');
    chmodSync(c.p('ro.txt'), 0o444);
    await c.restart();
    const { page } = c;
    await openFile(page, c.p('ro.txt'));
    await waitFor(async () => /lecture seule/.test(await infobarText(page)), { message: 'barre lecture seule' });
    assert.equal(await page.$eval('.editor-text', (e) => e.readOnly), true);
    await typeAtEnd(page, 'XYZ');
    assert.equal(await editorValue(page), 'protégé');
    await page.locator('.infobar button', { hasText: 'Modifier une copie' }).click();
    await typeAtEnd(page, '!');
    await page.keyboard.press('Control+s');
    await promptFill(page, c.p('copie.txt'));
    await waitSaved(page);
    assert.equal(readFileSync(c.p('ro.txt'), 'utf8'), 'protégé');
    assert.equal(readFileSync(c.p('copie.txt'), 'utf8'), 'protégé!');
  } finally {
    await c.dispose();
  }
});

t('onglets discrets : masqués avec un seul document ; Ctrl+Tab, Ctrl+1…9, glisser, onglet vierge remplacé', async () => {
  const c = await setup({ files: { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' } });
  try {
    const { page } = c;
    assert.deepEqual(await tabNames(page), ['Sans titre 1']);
    const barVisible = () => page.$eval('.tabbar', (e) => e.offsetParent !== null && e.getBoundingClientRect().height > 0);
    assert.equal(await barVisible(), false, 'un seul document : pas de barre d’onglets');
    await openFile(page, c.p('a.txt'));
    await waitFor(async () => (await tabNames(page)).join() === 'a.txt', { message: 'onglet vierge remplacé' });
    assert.equal(await barVisible(), false, 'toujours un seul document');
    // Ouverture multiple (chemins séparés par « ; »).
    await page.keyboard.press('Control+o');
    await promptFill(page, `${c.p('b.txt')};${c.p('c.txt')}`);
    await waitFor(async () => (await tabNames(page)).length === 3, { message: '3 onglets' });
    assert.equal(await barVisible(), true, 'barre affichée à partir de deux documents');
    assert.deepEqual(await tabNames(page), ['a.txt', 'b.txt', 'c.txt'], 'onglet vierge remplacé');
    await page.focus('.editor-text');
    await page.keyboard.press('Control+Tab');
    assert.equal(await activeTab(page), 'a.txt');
    await page.keyboard.press('Control+2');
    assert.equal(await activeTab(page), 'b.txt');
    // Glisser « c.txt » avant « a.txt ».
    const a = await page.locator('.tab', { hasText: 'a.txt' }).boundingBox();
    const cc = await page.locator('.tab', { hasText: 'c.txt' }).boundingBox();
    await page.mouse.move(cc.x + 20, cc.y + 10);
    await page.mouse.down();
    await page.mouse.move(cc.x - 40, cc.y + 10, { steps: 5 });
    await page.mouse.move(a.x + 5, a.y + 10, { steps: 5 });
    await page.mouse.up();
    assert.deepEqual(await tabNames(page), ['c.txt', 'a.txt', 'b.txt']);
  } finally {
    await c.dispose();
  }
});

t('raccourcis : aller à la ligne, date (F5), sélection de ligne, retour à la ligne, zoom', async () => {
  const lines = Array.from({ length: 300 }, (_, i) => `ligne ${i + 1}`).join('\n');
  const c = await setup({ files: { 'l.txt': lines }, open: ['l.txt'], settings: { version: 1, editor: { lineNumbers: true, wordWrap: false } } });
  try {
    const { page } = c;
    await page.keyboard.press('Control+g');
    await promptFill(page, '250');
    await waitFor(async () => /Ln 250, Col 1/.test(await statusText(page)), { message: 'ligne 250' });
    const top = await page.$eval('.editor-text', (e) => e.scrollTop);
    assert.ok(top > 3000, `défilement jusqu'à la ligne (scrollTop=${top})`);
    assert.ok(await page.locator('.gutter .gl', { hasText: /^250$/ }).count(), 'numéro 250 visible dans la gouttière');
    await page.keyboard.press('Control+l');
    await waitFor(async () => /\(10 sélectionnés\)/.test(await statusText(page)), { message: 'ligne sélectionnée' });
    // La sélection de ligne place le curseur au début de la ligne suivante.
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('End');
    await page.keyboard.press('F5');
    const v = await editorValue(page);
    assert.match(v.split('\n')[249], /^ligne 250\d\d:\d\d \d\d\/\d\d\/\d{4}$/);
    await page.keyboard.press('Alt+z');
    assert.equal(await page.$eval('.editor-text', (e) => e.getAttribute('wrap')), 'soft');
    await page.keyboard.press('Control+NumpadAdd');
    assert.match(await statusText(page), /110 %/);
    await page.keyboard.press('Control+0');
    assert.match(await statusText(page), /100 %/);
    // F5 hors de la zone d'édition (palette ouverte) : aucune insertion ni
    // rechargement de la page.
    const before = await editorValue(page);
    await page.keyboard.press('Control+Shift+p');
    await page.keyboard.press('F5');
    await page.keyboard.press('Escape');
    assert.equal(await editorValue(page), before);
  } finally {
    await c.dispose();
  }
});

t('frappe pendant le chargement : rien n’est perdu (rejouée à l’affichage)', async () => {
  const big = 'ligne de texte pour un fichier de taille moyenne\n'.repeat(2_000);
  const c = await setup({ files: { 'moyen.txt': big, 'petit.txt': 'abc', 'autre.txt': 'def' } });
  try {
    const { page } = c;
    // Lecture ralentie (disque lent, réseau) : réponse de doc.open retardée de 600 ms.
    await page.route('**/rpc', async (route) => {
      if (route.request().postDataBuffer()?.includes('doc.open')) await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    const tail = () => page.evaluate(() => document.querySelector('.editor-text').value.slice(-12));
    await page.evaluate((p) => void window.__swiftpad.ws.openPath(p), c.p('moyen.txt'));
    await page.focus('.editor-text');
    assert.equal(await page.evaluate(() => window.__swiftpad.ws.active.loaded), false, 'encore en chargement');
    await page.keyboard.press('Control+End');
    await page.keyboard.type('FIN x');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.__swiftpad.ws.active.loaded), false, 'toujours en chargement après la frappe');
    await waitFor(async () => (await tail()).endsWith('FIN \n'), { timeout: 5000, message: 'saisie rejouée en fin de document' });
    assert.equal(await page.evaluate(() => document.querySelector('.editor-text').value.length), big.length + 5);
    assert.equal(await page.$eval('.tab.active', (e) => e.classList.contains('dirty')), true);
    // La saisie rejouée s'annule comme une frappe normale (texte, retour
    // arrière, Entrée : trois étapes) jusqu'au contenu d'origine.
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
    await waitFor(async () => (await page.evaluate(() => document.querySelector('.editor-text').value.length)) === big.length, { message: 'annulation complète' });
    assert.equal(await page.$eval('.tab.active', (e) => e.classList.contains('dirty')), false);
    // Sans Ctrl+Fin : insertion au début, comme le Bloc-notes.
    await page.evaluate((p) => void window.__swiftpad.ws.openPath(p), c.p('petit.txt'));
    await page.focus('.editor-text');
    await page.keyboard.type('X');
    await waitFor(async () => (await editorValue(page)) === 'Xabc', { message: 'insertion au début' });
    // Focus parti ailleurs pendant le chargement : la saisie est abandonnée.
    await page.evaluate((p) => void window.__swiftpad.ws.openPath(p), c.p('autre.txt'));
    await page.focus('.editor-text');
    await page.keyboard.type('Y');
    await page.keyboard.press('Control+Shift+p');
    await waitFor(async () => (await page.evaluate(() => window.__swiftpad.ws.active.loaded)), { message: 'chargé' });
    assert.equal(await editorValue(page), 'def');
  } finally {
    await c.dispose();
  }
});

t('fin de chargement : le focus n’est pas repris à la palette ouverte entre-temps', async () => {
  const c = await setup({ files: { 'lent.txt': 'contenu\n' } });
  try {
    const { page } = c;
    await page.route('**/rpc', async (route) => {
      if (route.request().postDataBuffer()?.includes('doc.open')) await new Promise((r) => setTimeout(r, 500));
      await route.continue();
    });
    await page.evaluate((p) => void window.__swiftpad.ws.openPath(p), c.p('lent.txt'));
    await page.keyboard.press('Control+Shift+p');
    await page.keyboard.type('retour');
    await waitFor(async () => (await page.evaluate(() => window.__swiftpad.ws.active.loaded)), { message: 'chargé' });
    await page.waitForTimeout(100);
    await page.keyboard.type(' automatique');
    assert.equal(await page.$eval('.palette input', (e) => e.value), '>retour automatique');
    assert.equal(await page.evaluate(() => document.activeElement.closest('.palette') !== null), true);
    assert.equal(await editorValue(page), 'contenu\n');
    await page.keyboard.press('Escape');
  } finally {
    await c.dispose();
  }
});
