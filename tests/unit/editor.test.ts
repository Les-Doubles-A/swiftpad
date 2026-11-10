import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countNewlines,
  lineColOf,
  buildLineStarts,
  lineOfOffset,
  offsetOfLine,
  diffFull,
  editFromSelections,
  applyEdit,
  revertEdit,
  trimEdit,
  countCodePoints,
} from '../../src/editor/text';
import { History } from '../../src/editor/history';
import { duplicateLines, deleteLines, moveLines, indentLines, outdentLines, selectLines, newlineWithIndent, trimTrailingWhitespace, dateTimeStamp } from '../../src/editor/ops';
import type { Change } from '../../src/editor/ops';

const apply = (t: string, c: Change) => t.slice(0, c.start) + c.insert + t.slice(c.end);

test('lignes, colonnes et index', () => {
  const t = 'ab\ncd\n\nefg';
  assert.equal(countNewlines(t), 3);
  assert.deepEqual(lineColOf(t, 0), { line: 1, col: 1 });
  assert.deepEqual(lineColOf(t, 4), { line: 2, col: 2 });
  assert.deepEqual(lineColOf(t, 7), { line: 4, col: 1 });
  const s = buildLineStarts(t);
  assert.deepEqual([...s], [0, 3, 6, 7]);
  assert.equal(lineOfOffset(s, 0), 0);
  assert.equal(lineOfOffset(s, 5), 1);
  assert.equal(lineOfOffset(s, 6), 2);
  assert.equal(lineOfOffset(s, 10), 3);
  assert.equal(offsetOfLine(t, 1), 0);
  assert.equal(offsetOfLine(t, 3), 6);
  assert.equal(offsetOfLine(t, 99), t.length);
  assert.deepEqual([...buildLineStarts('')], [0]);
});

test('différence complète et réduction', () => {
  assert.deepEqual(diffFull('abcdef', 'abXYef'), { start: 2, removed: 'cd', inserted: 'XY' });
  assert.deepEqual(diffFull('aaa', 'aaaa'), { start: 3, removed: '', inserted: 'a' });
  assert.deepEqual(diffFull('', 'x'), { start: 0, removed: '', inserted: 'x' });
  // Ne coupe jamais une paire de substitution (émoji).
  const e = diffFull('a😀b', 'a😃b');
  assert.equal(applyEdit('a😀b', e), 'a😃b');
  assert.ok(!/^[\uDC00-\uDFFF]/.test(e.removed));
  assert.deepEqual(trimEdit({ start: 0, removed: 'abc', inserted: 'abd' }), { start: 2, removed: 'c', inserted: 'd' });
});

test('modification déduite des sélections (saisie, effacement, collage, remplacement)', () => {
  const cases: [string, string, number, number, number, number][] = [
    ['hello world', 'hello, world', 5, 5, 6, 6], // frappe
    ['hello world', 'hell world', 5, 5, 4, 4], // retour arrière
    ['hello world', 'hello orld', 6, 6, 6, 6], // suppr
    ['hello world', 'hello there', 6, 11, 11, 11], // remplacement de sélection
    ['abc', 'aXYZbc', 1, 1, 4, 4], // collage
    ['aaaa', 'aaaaa', 2, 2, 3, 3], // texte répété
    ['ligne1\nligne2', 'ligne1\n\nligne2', 7, 7, 8, 8], // entrée
    ['x', '', 0, 1, 0, 0], // couper tout
  ];
  for (const [old, neu, s0, e0, s1, e1] of cases) {
    const e = editFromSelections(old, neu, s0, e0, s1, e1);
    assert.ok(e, `${old} → ${neu}`);
    assert.equal(applyEdit(old, e!), neu);
    assert.equal(revertEdit(neu, e!), old);
  }
  // Incohérence détectée : repli nécessaire.
  assert.equal(editFromSelections('abcdef', 'zbcdef', 5, 5, 6, 6), null);
});

test('historique : annuler, rétablir, regroupement de frappe, état enregistré', () => {
  const h = new History();
  let text = '';
  const type = (s: string, t: number) => {
    const e = { start: text.length, removed: '', inserted: s };
    text = applyEdit(text, e);
    h.record(e, 'type', [e.start, e.start], [text.length, text.length], t);
  };
  type('a', 0);
  type('b', 100);
  type('c', 200);
  assert.equal(h.stats().steps, 1, 'frappe regroupée');
  h.markSaved();
  assert.equal(h.isDirty(), false);
  type('d', 300); // ne fusionne pas avec l'étape enregistrée
  assert.equal(h.stats().steps, 2);
  assert.equal(h.isDirty(), true);
  let st = h.undo()!;
  for (const e of [...st.edits].reverse()) text = revertEdit(text, e);
  assert.equal(text, 'abc');
  assert.equal(h.isDirty(), false, 'retour à l’état enregistré');
  st = h.redo()!;
  for (const e of st.edits) text = applyEdit(text, e);
  assert.equal(text, 'abcd');
  assert.equal(h.isDirty(), true);
  // Une pause rompt le regroupement.
  type('e', 5000);
  assert.equal(h.stats().steps, 3);
  // Nouvelle saisie après annulation : la pile « rétablir » est vidée.
  h.undo();
  type('f', 9000);
  assert.equal(h.canRedo(), false);
});

test('historique : retour arrière regroupé et limite mémoire', () => {
  const h = new History();
  let text = 'abcdef';
  for (let i = 0; i < 3; i++) {
    const pos = text.length - 1;
    const e = { start: pos, removed: text[pos], inserted: '' };
    text = applyEdit(text, e);
    h.record(e, 'delete-back', [pos + 1, pos + 1], [pos, pos], i * 10);
  }
  assert.equal(h.stats().steps, 1);
  const st = h.undo()!;
  for (const e of [...st.edits].reverse()) text = revertEdit(text, e);
  assert.equal(text, 'abcdef');
  const small = new History();
  small.maxChars = 10;
  for (let i = 0; i < 5; i++) small.record({ start: 0, removed: '', inserted: 'xxxx' }, 'paste', [0, 0], [4, 4], i * 5000);
  assert.ok(small.stats().chars <= 10 || small.stats().steps === 1);
  assert.equal(small.isDirty(), true);
});

test('opérations sur les lignes', () => {
  const t = 'un\ndeux\ntrois';
  let c = duplicateLines(t, 4, 4);
  assert.equal(apply(t, c), 'un\ndeux\ndeux\ntrois');
  assert.deepEqual(c.sel, [9, 9]);
  c = duplicateLines(t, 0, 5); // un + début de deux
  assert.equal(apply(t, c), 'un\ndeux\nun\ndeux\ntrois');
  c = deleteLines(t, 4, 4);
  assert.equal(apply(t, c), 'un\ntrois');
  c = deleteLines(t, 9, 9);
  assert.equal(apply(t, c), 'un\ndeux');
  assert.equal(apply('seule', deleteLines('seule', 2, 2)), '');
  c = moveLines(t, 4, 4, -1)!;
  assert.equal(apply(t, c), 'deux\nun\ntrois');
  assert.equal(apply(t, c).slice(c.sel[0], c.sel[0] + 3), 'eux');
  c = moveLines(t, 4, 4, 1)!;
  assert.equal(apply(t, c), 'un\ntrois\ndeux');
  assert.equal(moveLines(t, 0, 0, -1), null);
  assert.equal(moveLines(t, 10, 10, 1), null);
  c = indentLines(t, 0, 7, '\t');
  assert.equal(apply(t, c), '\tun\n\tdeux\ntrois');
  const ind = apply(t, c);
  const o = outdentLines(ind, 0, ind.length, 4)!;
  assert.equal(apply(ind, o), t);
  assert.equal(outdentLines('a', 0, 0, 4), null);
  assert.equal(apply('    x\n  y', outdentLines('    x\n  y', 0, 9, 4)!), 'x\ny');
  assert.deepEqual(selectLines(t, 4, 4), [3, 8]);
  // Sélection terminant au début d'une ligne : ligne non incluse.
  assert.equal(apply(t, deleteLines(t, 0, 3)), 'deux\ntrois');
  c = newlineWithIndent('  a', 3, 3);
  assert.equal(apply('  a', c), '  a\n  ');
  c = trimTrailingWhitespace('a  \nb\nc\t \n')!;
  assert.equal(apply('a  \nb\nc\t \n', c), 'a\nb\nc\n');
  assert.equal(trimTrailingWhitespace('propre\n'), null);
});

test('date et heure façon Bloc-notes', () => {
  const s = dateTimeStamp(new Date(2026, 9, 12, 9, 5), 'fr-FR');
  assert.equal(s, '09:05 12/10/2026');
});

test('caractères comptés en points de code', () => {
  assert.equal(countCodePoints('a😀é'), 3);
  assert.equal(countCodePoints(''), 0);
});
