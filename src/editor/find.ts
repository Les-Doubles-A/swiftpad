// Moteur de recherche dans un document : construction d'expression,
// occurrence suivante/précédente sans parcourir tout le texte, comptage
// découpé en tranches (l'interface reste réactive), remplacement.

export interface FindOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface Match {
  start: number;
  end: number;
  groups: RegExpExecArray;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD_BEFORE = '(?<![\\p{L}\\p{N}_])';
const WORD_AFTER = '(?![\\p{L}\\p{N}_])';

/** Expression de recherche ; `error` est un message lisible si invalide. */
export function buildRegex(o: FindOptions): { re: RegExp | null; error: string | null } {
  if (!o.query) return { re: null, error: null };
  let src = o.regex ? o.query : escapeRegex(o.query);
  if (o.wholeWord) src = `${WORD_BEFORE}(?:${src})${WORD_AFTER}`;
  const flags = `gmu${o.caseSensitive ? '' : 'i'}`;
  try {
    return { re: new RegExp(src, flags), error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : String(e);
    return { re: null, error: `Expression régulière invalide : ${msg}` };
  }
}

function execAt(re: RegExp, text: string, from: number): RegExpExecArray | null {
  re.lastIndex = from;
  const m = re.exec(text);
  return m;
}

/** Première correspondance non vide commençant à `pos` ou après (et avant `limit`). */
function firstFrom(text: string, re: RegExp, pos: number, limit = Infinity): Match | null {
  while (pos <= text.length) {
    const m = execAt(re, text, pos);
    if (!m || m.index >= limit) return null;
    // Correspondance vide : on avance d'un caractère pour ne pas boucler.
    if (m[0].length > 0) return { start: m.index, end: m.index + m[0].length, groups: m };
    pos = m.index + 1;
  }
  return null;
}

/** Dernière correspondance non vide commençant avant `limit`, par fenêtres croissantes. */
function lastBefore(text: string, re: RegExp, limit: number): Match | null {
  let win = 64 * 1024;
  for (;;) {
    const from = Math.max(0, limit - win);
    let last: Match | null = null;
    let pos = from;
    while (pos < limit && pos <= text.length) {
      const m = execAt(re, text, pos);
      if (!m || m.index >= limit) break;
      if (m[0].length > 0) last = { start: m.index, end: m.index + m[0].length, groups: m };
      pos = m.index + Math.max(1, m[0].length);
    }
    if (last || from === 0) return last;
    win *= 4;
  }
}

/** Occurrence suivante à partir de `from`, en reprenant au début si besoin. */
export function findNext(text: string, re: RegExp, from: number, wrap = true): (Match & { wrapped: boolean }) | null {
  const pos = Math.max(0, Math.min(from, text.length));
  const m = firstFrom(text, re, pos);
  if (m) return { ...m, wrapped: false };
  if (!wrap || pos === 0) return null;
  const w = firstFrom(text, re, 0, pos);
  return w ? { ...w, wrapped: true } : null;
}

/** Occurrence précédente (commençant avant `before`), en reprenant à la fin si besoin. */
export function findPrev(text: string, re: RegExp, before: number, wrap = true): (Match & { wrapped: boolean }) | null {
  const limit = Math.max(0, Math.min(before, text.length));
  const m = lastBefore(text, re, limit);
  if (m) return { ...m, wrapped: false };
  if (!wrap) return null;
  const w = lastBefore(text, re, text.length + 1);
  return w && w.start >= limit ? { ...w, wrapped: true } : null;
}

/**
 * Compte les occurrences par tranches de temps. `shouldStop` permet
 * d'abandonner (nouvelle recherche). Renvoie le total, plafonné à `cap`
 * (`capped` vrai si atteint), et l'index (base 1) de l'occurrence active.
 */
export async function countMatches(
  text: string,
  re: RegExp,
  cap: number,
  shouldStop: () => boolean,
  activeStart = -1,
  sliceMs = 8,
): Promise<{ total: number; capped: boolean; activeIndex: number } | null> {
  let total = 0;
  let activeIndex = 0;
  let pos = 0;
  let t0 = performance.now();
  re.lastIndex = 0;
  while (pos <= text.length) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) break;
    if (m[0].length === 0) {
      pos = m.index + 1;
      continue;
    }
    total++;
    if (m.index === activeStart) activeIndex = total;
    if (total >= cap) return { total, capped: true, activeIndex };
    pos = m.index + m[0].length;
    if (performance.now() - t0 > sliceMs) {
      await new Promise((r) => setTimeout(r, 0));
      if (shouldStop()) return null;
      t0 = performance.now();
    }
  }
  return { total, capped: false, activeIndex };
}

/**
 * Développe un modèle de remplacement ($&, $1…$99, $<nom>, $$) pour une
 * correspondance. En mode littéral, le modèle est inséré tel quel.
 */
export function expandReplacement(template: string, m: RegExpExecArray, regex: boolean): string {
  if (!regex) return template;
  return template.replace(/\$(\$|&|<([^>]+)>|(\d{1,2}))/g, (whole, tok: string, name?: string, num?: string) => {
    if (tok === '$') return '$';
    if (tok === '&') return m[0];
    if (name !== undefined) return m.groups?.[name] ?? '';
    if (num !== undefined) {
      const n = parseInt(num, 10);
      if (n > 0 && n < m.length) return m[n] ?? '';
      // « $12 » avec un seul groupe : $1 suivi de « 2 ».
      if (num.length === 2) {
        const n1 = parseInt(num[0], 10);
        if (n1 > 0 && n1 < m.length) return (m[n1] ?? '') + num[1];
      }
      return whole;
    }
    return whole;
  });
}

/** Remplace toutes les occurrences ; renvoie la plage modifiée minimale. */
export function replaceAllIn(text: string, re: RegExp, template: string, regex: boolean): { start: number; end: number; insert: string; count: number } | null {
  let count = 0;
  let first = -1;
  let lastEnd = -1;
  const parts: string[] = [];
  let pos = 0;
  re.lastIndex = 0;
  while (pos <= text.length) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) break;
    if (m[0].length === 0) {
      pos = m.index + 1;
      continue;
    }
    if (first < 0) first = m.index;
    else parts.push(text.slice(lastEnd, m.index));
    parts.push(expandReplacement(template, m, regex));
    lastEnd = m.index + m[0].length;
    pos = lastEnd;
    count++;
  }
  if (count === 0) return null;
  return { start: first, end: lastEnd, insert: parts.join(''), count };
}
