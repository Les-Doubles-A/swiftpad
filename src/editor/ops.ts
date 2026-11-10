// Opérations d'édition sur les lignes. Chaque opération renvoie une seule
// modification contiguë (plage remplacée + nouvelle sélection), appliquée
// par l'éditeur et annulable d'un bloc.

import { lineStartOf, lineEndOf, leadingWhitespace } from './text';

export interface Change {
  start: number;
  end: number;
  insert: string;
  sel: [number, number];
}

/** Plage de lignes couverte par la sélection : [début, fin) sans le « \n » final. */
export function lineBlock(text: string, s: number, e: number): [number, number] {
  let end = e;
  // Sélection s'arrêtant au début d'une ligne : cette ligne n'est pas incluse.
  if (e > s && text[e - 1] === '\n') end = e - 1;
  return [lineStartOf(text, s), lineEndOf(text, end)];
}

export function duplicateLines(text: string, s: number, e: number): Change {
  const [a, b] = lineBlock(text, s, e);
  const block = text.slice(a, b);
  // Copie insérée sous le bloc ; la sélection suit la copie.
  const insert = '\n' + block;
  const shift = block.length + 1;
  return { start: b, end: b, insert, sel: [s + shift, e + shift] };
}

export function deleteLines(text: string, s: number, e: number): Change {
  const [a, b] = lineBlock(text, s, e);
  if (b < text.length) {
    return { start: a, end: b + 1, insert: '', sel: [a, a] };
  }
  // Dernière ligne : supprime aussi le saut de ligne qui la précède.
  const start = a > 0 ? a - 1 : a;
  const caret = lineStartOf(text, start);
  return { start, end: b, insert: '', sel: [caret, caret] };
}

export function moveLines(text: string, s: number, e: number, dir: -1 | 1): Change | null {
  const [a, b] = lineBlock(text, s, e);
  const block = text.slice(a, b);
  if (dir < 0) {
    if (a === 0) return null;
    const pa = lineStartOf(text, a - 1);
    const prev = text.slice(pa, a - 1);
    return { start: pa, end: b, insert: block + '\n' + prev, sel: [s - (a - pa), e - (a - pa)] };
  }
  if (b >= text.length) return null;
  const nb = lineEndOf(text, b + 1);
  const next = text.slice(b + 1, nb);
  return { start: a, end: nb, insert: next + '\n' + block, sel: [s + next.length + 1, e + next.length + 1] };
}

export function indentLines(text: string, s: number, e: number, unit: string): Change {
  const [a, b] = lineBlock(text, s, e);
  const lines = text.slice(a, b).split('\n');
  let added = 0;
  let firstAdded = 0;
  const out = lines.map((l, i) => {
    if (l.length === 0 && lines.length > 1) return l;
    added += unit.length;
    if (i === 0) firstAdded = unit.length;
    return unit + l;
  });
  return { start: a, end: b, insert: out.join('\n'), sel: [s + firstAdded, e + added] };
}

export function outdentLines(text: string, s: number, e: number, tabSize: number): Change | null {
  const [a, b] = lineBlock(text, s, e);
  const lines = text.slice(a, b).split('\n');
  let removed = 0;
  let firstRemoved = 0;
  const out = lines.map((l, i) => {
    let n = 0;
    if (l.startsWith('\t')) n = 1;
    else {
      while (n < tabSize && l[n] === ' ') n++;
    }
    removed += n;
    if (i === 0) firstRemoved = n;
    return l.slice(n);
  });
  if (removed === 0) return null;
  const firstLineStart = a;
  const ns = Math.max(firstLineStart, s - firstRemoved);
  return { start: a, end: b, insert: out.join('\n'), sel: [ns, Math.max(ns, e - removed)] };
}

/** Sélectionne les lignes entières (avec le saut de ligne final). */
export function selectLines(text: string, s: number, e: number): [number, number] {
  const [a, b] = lineBlock(text, s, e);
  return [a, Math.min(text.length, b + 1)];
}

export function newlineWithIndent(text: string, s: number, e: number): Change {
  const ls = lineStartOf(text, s);
  const indent = leadingWhitespace(text.slice(ls, s));
  const insert = '\n' + indent;
  return { start: s, end: e, insert, sel: [s + insert.length, s + insert.length] };
}

/** Supprime les espaces et tabulations en fin de ligne (plage minimale). */
export function trimTrailingWhitespace(text: string): Change | null {
  const re = /[ \t]+$/gm;
  let first = -1;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (first < 0) first = m.index;
    last = m.index + m[0].length;
  }
  if (first < 0) return null;
  const start = lineStartOf(text, first);
  const end = lineEndOf(text, last);
  const insert = text.slice(start, end).replace(/[ \t]+$/gm, '');
  return { start, end, insert, sel: [start, start] };
}

/** Date et heure « HH:mm JJ/MM/AAAA » (convention du Bloc-notes, format local). */
export function dateTimeStamp(d: Date, locale?: string): string {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(d);
  const date = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
  return `${time} ${date}`;
}
