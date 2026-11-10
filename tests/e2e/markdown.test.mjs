import { setup, editorValue, activeTab, dialogText, dialogButton, waitFor, assert } from './lib.mjs';

export const tests = [];
const t = (name, fn) => tests.push({ name, fn });

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

t('Markdown : aperçu désactivé par défaut, modes source/partagé/aperçu, rendu complet', async () => {
  const md = [
    '# Titre principal',
    '',
    'Paragraphe avec **gras**, *italique* et `code`.',
    '',
    '## Liste',
    '',
    '- un',
    '- deux',
    '',
    '> citation',
    '',
    '| Col | Nombre |',
    '|-----|-------:|',
    '| a   | 1      |',
    '',
    '```js',
    'const x = 1 < 2;',
    '```',
    '',
    '![logo local](img/logo.png)',
    '',
    '[vers autre](autre.md) et [ancre](#liste)',
    '',
    '### Fin',
  ].join('\n');
  const c = await setup({ files: { 'doc.md': md, 'autre.md': '# Autre', 'img/logo.png': PNG }, open: ['doc.md'] });
  try {
    const { page } = c;
    assert.equal(await page.locator('.pane-preview').isHidden(), true, 'aperçu désactivé par défaut');
    const chunksBefore = c.requests.filter((u) => /\/render-[A-Z0-9]+\.js/.test(u)).length;
    assert.equal(chunksBefore, 0, 'moteur Markdown non chargé tant que l’aperçu est fermé');
    await page.keyboard.press('Control+Shift+v');
    await page.locator('.md-body h1', { hasText: 'Titre principal' }).waitFor();
    assert.ok(c.requests.some((u) => /\/render-[A-Z0-9]+\.js/.test(u)), 'moteur chargé à la demande');
    assert.equal(await page.locator('.doc-views.view-split').count(), 1);
    assert.equal(await page.locator('.md-body ul li').count(), 2);
    assert.equal(await page.locator('.md-body blockquote').count(), 1);
    assert.equal(await page.locator('.md-body table td.md-align-right').count(), 1);
    assert.equal(await page.locator('.md-body pre code').textContent(), 'const x = 1 < 2;\n');
    await waitFor(() => page.locator('.md-body img').evaluate((i) => i.complete && i.naturalWidth === 1 && i.src.startsWith('blob:')), { message: 'image locale chargée' });
    // Modification → aperçu mis à jour.
    await page.focus('.editor-text');
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n\nNouveau paragraphe');
    await page.locator('.md-body p', { hasText: 'Nouveau paragraphe' }).waitFor({ timeout: 3000 });
    // Ancre interne puis lien relatif ouvert dans SwiftPad.
    await page.locator('.md-body a', { hasText: 'ancre' }).click();
    await page.locator('.md-body a', { hasText: 'vers autre' }).click();
    await waitFor(async () => (await activeTab(page)) === 'autre.md', { message: 'lien relatif ouvert' });
    await page.locator('.tab', { hasText: 'doc.md' }).click();
    // Aperçu seul, puis source seule.
    await page.click('.menubar-item:has-text("Affichage")');
    await page.locator('.menu-item', { hasText: 'Markdown' }).hover();
    await page.locator('.menu-item', { hasText: 'Aperçu seul' }).click();
    await waitFor(() => page.locator('.doc-views.view-preview').count(), { message: 'aperçu seul' });
    await page.keyboard.press('Control+Shift+v');
    await waitFor(() => page.locator('.doc-views.view-source').count(), { message: 'source seule' });
    // Navigation entre les titres (Ctrl+Maj+O).
    await page.focus('.editor-text');
    await page.keyboard.press('Control+Shift+o');
    await page.keyboard.type('fin');
    await page.keyboard.press('Enter');
    await waitFor(async () => /Ln 24,/.test(await page.textContent('.statusbar')), { message: 'titre atteint' });
  } finally {
    await c.dispose();
  }
});

t('Markdown : rendu sécurisé (aucun script, gestionnaire, iframe ni lien actif)', async () => {
  const evil = [
    '# Test',
    '<script>window.__pwned = 1</script>',
    '<img src=x onerror="window.__pwned = 2">',
    '<iframe src="javascript:window.__pwned=3"></iframe>',
    '<a href="javascript:window.__pwned=4">html</a>',
    '[js](javascript:window.__pwned=5)',
    '[vb](vbscript:msgbox)',
    '[data](data:text/html;base64,PHNjcmlwdD53aW5kb3cuX19wd25lZD02PC9zY3JpcHQ+)',
    '![x](javascript:window.__pwned=7)',
    '<svg onload="window.__pwned=8"></svg>',
    '<style>body{display:none}</style>',
    '<form action="https://exemple.org"><input></form>',
    '[clobber](#x) <a id="__swiftpad">x</a>',
    '## __swiftpad',
    '[ext](https://exemple.org/page)',
  ].join('\n\n');
  const c = await setup({ files: { 'evil.md': evil }, open: ['evil.md'] });
  try {
    const { page } = c;
    await page.keyboard.press('Control+Shift+v');
    await page.locator('.md-body h1').waitFor();
    for (const a of await page.locator('.md-body a').all()) await a.click().catch(() => {});
    // Le lien http(s) demande confirmation avant le navigateur externe.
    await page.waitForTimeout(200);
    if (await page.locator('.dlg-backdrop').count()) {
      assert.match(await dialogText(page), /navigateur par défaut/);
      await dialogButton(page, 'Annuler');
    }
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const body = document.querySelector('.md-body');
      const all = [...body.querySelectorAll('*')];
      return {
        pwned: window.__pwned ?? null,
        scripts: body.querySelectorAll('script, iframe, object, embed, form, style, svg').length,
        handlers: all.filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length,
        jsHrefs: all.filter((e) => /^\s*(javascript|vbscript|data):/i.test(e.getAttribute('href') ?? '') || /^\s*javascript:/i.test(e.getAttribute('src') ?? '')).length,
        ids: all.map((e) => e.id).filter(Boolean),
        hooksIntact: typeof window.__swiftpad === 'object' && !!window.__swiftpad.ws,
        bodyVisible: getComputedStyle(document.body).display !== 'none',
      };
    });
    assert.equal(r.pwned, null, 'aucun code du document exécuté');
    assert.equal(r.scripts, 0, 'aucun élément actif');
    assert.equal(r.handlers, 0, 'aucun gestionnaire d’événement');
    assert.equal(r.jsHrefs, 0, 'aucun lien javascript/vbscript/data');
    assert.ok(r.ids.every((id) => id.startsWith('md-h-')), `identifiants préfixés : ${r.ids}`);
    assert.ok(r.hooksIntact && r.bodyVisible, 'page intacte');
    // Le HTML brut est affiché comme texte.
    assert.match(await page.textContent('.md-body'), /<script>window.__pwned = 1<\/script>/);
    const external = c.requests.filter((u) => !/^https?:\/\/127\.0\.0\.1[:/]/.test(u) && !u.startsWith('blob:') && !u.startsWith('data:'));
    assert.deepEqual(external, []);
  } finally {
    await c.dispose();
  }
});

t('Markdown : table des matières facultative', async () => {
  const c = await setup({ files: { 'toc.md': '# A\n\n## B\n\n## C\n\n### D\n' }, open: ['toc.md'] });
  try {
    const { page } = c;
    await page.evaluate(() => window.__swiftpad.settings.set('markdown.toc', true));
    await page.keyboard.press('Control+Shift+v');
    await page.locator('.md-toc li').first().waitFor();
    assert.equal(await page.locator('.md-toc li').count(), 4);
    await page.locator('.md-toc a', { hasText: 'D' }).click();
    assert.equal(await editorValue(page), '# A\n\n## B\n\n## C\n\n### D\n');
  } finally {
    await c.dispose();
  }
});
