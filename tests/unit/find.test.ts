import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegex, findNext, findPrev, countMatches, expandReplacement, replaceAllIn } from '../../src/editor/find';

const re = (query: string, o: Partial<{ caseSensitive: boolean; wholeWord: boolean; regex: boolean }> = {}) => {
  const r = buildRegex({ query, caseSensitive: false, wholeWord: false, regex: false, ...o });
  assert.equal(r.error, null);
  return r.re!;
};

test('littéral, casse, mot entier, Unicode', () => {
  const t = 'Été été ÉTÉ étés (été) a.b a+b';
  assert.equal(findNext(t, re('été'), 0)!.start, 0);
  assert.equal(findNext(t, re('été', { caseSensitive: true }), 0)!.start, 4);
  const w = re('été', { wholeWord: true });
  const starts: number[] = [];
  let pos = 0;
  for (;;) {
    const m = findNext(t, w, pos, false);
    if (!m) break;
    starts.push(m.start);
    pos = m.end;
  }
  assert.deepEqual(starts, [0, 4, 8, 18]);
  // Caractères spéciaux pris littéralement.
  assert.equal(findNext(t, re('a.b'), 0)!.start, t.indexOf('a.b'));
  assert.equal(findNext(t, re('a+b'), 0)!.start, t.indexOf('a+b'));
  assert.equal(buildRegex({ query: '', caseSensitive: false, wholeWord: false, regex: false }).re, null);
});

test('suivant et précédent avec reprise', () => {
  const t = 'x1 x2 x3';
  const r = re('x');
  assert.deepEqual([findNext(t, r, 1)!.start, findNext(t, r, 1)!.wrapped], [3, false]);
  assert.deepEqual([findNext(t, r, 7)!.start, findNext(t, r, 7)!.wrapped], [0, true]);
  assert.equal(findPrev(t, r, 6)!.start, 3);
  const p = findPrev(t, r, 0)!;
  assert.deepEqual([p.start, p.wrapped], [6, true]);
  assert.equal(findNext(t, r, 7, false), null);
  // Grand texte : la recherche arrière élargit sa fenêtre.
  const big = 'needle' + 'a'.repeat(300_000) + 'X';
  assert.equal(findPrev(big, re('needle'), big.length)!.start, 0);
});

test('expressions régulières : validation, groupes, correspondances vides', () => {
  const bad = buildRegex({ query: '(', caseSensitive: false, wholeWord: false, regex: true });
  assert.equal(bad.re, null);
  assert.match(bad.error!, /invalide/);
  const r = re('(\\w+)@(\\w+)', { regex: true });
  const m = findNext('contact: zoe@exemple', r, 0)!;
  assert.equal(expandReplacement('$2 chez $1 ($&) $$', m.groups, true), 'exemple chez zoe (zoe@exemple) $');
  assert.equal(expandReplacement('$1', m.groups, false), '$1', 'mode littéral : modèle inséré tel quel');
  // Une expression pouvant correspondre à vide ne boucle pas.
  const empty = re('x*', { regex: true });
  assert.equal(findNext('aaxa', empty, 0)!.start, 2);
  assert.equal(findNext('aaa', empty, 0), null);
  const named = re('(?<an>\\d{4})-(?<mo>\\d\\d)', { regex: true });
  const n = findNext('le 2026-10', named, 0)!;
  assert.equal(expandReplacement('$<mo>/$<an>', n.groups, true), '10/2026');
});

test('comptage découpé et remplacement global', async () => {
  const text = 'ab '.repeat(10_000);
  const r = re('ab');
  const c = await countMatches(text, r, 1_000_000, () => false, 3, 1);
  assert.deepEqual(c, { total: 10_000, capped: false, activeIndex: 2 });
  const capped = await countMatches(text, r, 100, () => false);
  assert.deepEqual([capped!.total, capped!.capped], [100, true]);
  const stopped = await countMatches(text, r, 1_000_000, () => true, -1, 0);
  assert.equal(stopped, null);
  const rep = replaceAllIn('a-b-c', re('-'), '+', false)!;
  assert.deepEqual(rep, { start: 1, end: 4, insert: '+b+', count: 2 });
  const rep2 = replaceAllIn('x=1, y=2', re('(\\w)=(\\d)', { regex: true }), '$2=$1', true)!;
  assert.equal('x=1, y=2'.slice(0, rep2.start) + rep2.insert + 'x=1, y=2'.slice(rep2.end), '1=x, 2=y');
  assert.equal(replaceAllIn('abc', re('z'), 'y', false), null);
  // Remplacement littéral contenant « $ ».
  const lit = replaceAllIn('prix', re('prix'), '$&5', false)!;
  assert.equal(lit.insert, '$&5');
});
