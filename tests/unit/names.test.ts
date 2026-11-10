import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateName } from '../../src/workspace/names';
import { resolveLocal } from '../../src/markdown/preview';
import { extractHeadings, slugify } from '../../src/markdown/outline';
import { languageOf, extOf, basename, dirname, isInside, samePath } from '../../src/workspace/doc';

test('noms Windows (mêmes règles que le noyau)', () => {
  for (const ok of ['notes.txt', 'Mon fichier é.md', '.gitignore', 'a', 'con-tre.txt', 'console', 'COM10', 'x.y.z']) assert.equal(validateName(ok), null, ok);
  for (const bad of ['', '.', '..', 'a<b', 'a:b', 'a"b', 'a/b', 'a\\b', 'a|b', 'a?b', 'a*b', 'fin.', 'fin ', 'CON', 'con.txt', 'Nul', 'LPT1.log', 'COM¹', 'aux .txt', 'a\u0007']) {
    assert.notEqual(validateName(bad), null, JSON.stringify(bad));
  }
});

test('chemins relatifs de l’aperçu Markdown', () => {
  assert.equal(resolveLocal('C:\\docs\\notes', 'img/a.png', '\\'), 'C:\\docs\\notes\\img\\a.png');
  assert.equal(resolveLocal('C:\\docs\\notes', '../images/b%20c.png', '\\'), 'C:\\docs\\images\\b c.png');
  assert.equal(resolveLocal('C:\\docs', '..\\..\\..\\x.png', '\\'), 'C:\\x.png');
  assert.equal(resolveLocal('/home/zoe', './a.md#titre', '/'), '/home/zoe/a.md');
  assert.equal(resolveLocal('/home/zoe', '/etc/x.png', '/'), '/etc/x.png');
  assert.equal(resolveLocal('C:\\docs', 'D:\\autre\\y.png', '\\'), 'D:\\autre\\y.png');
  assert.equal(resolveLocal('C:\\docs', '#seulement', '\\'), null);
});

test('titres Markdown hors blocs de code', () => {
  const src = '# Un\ntexte\n```\n# pas un titre\n```\nDeux\n===\n### Trois ###\n    # code indenté\n';
  assert.deepEqual(
    extractHeadings(src).map((x) => [x.level, x.text, x.line]),
    [
      [1, 'Un', 0],
      [1, 'Deux', 5],
      [3, 'Trois', 7],
    ],
  );
  assert.equal(slugify('Été 2026 : bilan !'), 'ete-2026-bilan');
});

test('langages, extensions et chemins', () => {
  assert.equal(languageOf('a.rs'), 'Rust');
  assert.equal(languageOf('.gitignore'), 'Git (ignore)');
  assert.equal(languageOf('x.env.example'), 'Variables d’environnement');
  assert.equal(languageOf('inconnu.qqq'), 'Texte');
  assert.equal(extOf('archive.tar.GZ'), 'gz');
  assert.equal(basename('C:\\a\\b.txt'), 'b.txt');
  assert.equal(dirname('C:\\a\\b.txt'), 'C:\\a');
  assert.equal(dirname('C:\\b.txt'), 'C:\\');
  assert.equal(dirname('/b.txt'), '/');
  assert.ok(isInside('C:\\A\\b\\c.txt', 'c:\\a', true));
  assert.ok(!isInside('C:\\ab\\c.txt', 'C:\\a', true));
  assert.ok(samePath('C:\\X.txt', 'c:\\x.TXT', true));
  assert.ok(!samePath('/x', '/X', false));
});
