// Fonctions pures sur le texte (testées sans navigateur, voir tests/unit).
// Le texte de l'éditeur utilise toujours « \n » : la zone de texte native
// normalise CRLF et CR ; le type de fin de ligne d'origine est conservé à
// part et réappliqué à l'enregistrement par le noyau.

export interface Edit {
  start: number;
  removed: string;
  inserted: string;
}

export function countNewlines(s: string, from = 0, to = s.length): number {
  let n = 0;
  let i = s.indexOf('\n', from);
  while (i !== -1 && i < to) {
    n++;
    i = s.indexOf('\n', i + 1);
  }
  return n;
}

export function lineStartOf(text: string, pos: number): number {
  if (pos <= 0) return 0;
  return text.lastIndexOf('\n', pos - 1) + 1;
}

export function lineEndOf(text: string, pos: number): number {
  const i = text.indexOf('\n', pos);
  return i === -1 ? text.length : i;
}

/** Ligne et colonne (à partir de 1) d'une position, en unités UTF-16. */
export function lineColOf(text: string, pos: number): { line: number; col: number } {
  const p = Math.max(0, Math.min(pos, text.length));
  const line = countNewlines(text, 0, p) + 1;
  return { line, col: p - lineStartOf(text, p) + 1 };
}

/** Positions de début de chaque ligne. */
export function buildLineStarts(text: string): Uint32Array {
  const n = countNewlines(text) + 1;
  const out = new Uint32Array(n);
  let k = 1;
  let i = text.indexOf('\n');
  while (i !== -1) {
    out[k++] = i + 1;
    i = text.indexOf('\n', i + 1);
  }
  return out;
}

/** Index de ligne (à partir de 0) contenant `pos` (recherche dichotomique). */
export function lineOfOffset(starts: Uint32Array, pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Position du début de la ligne `line` (1 = première), bornée. */
export function offsetOfLine(text: string, line: number): number {
  if (line <= 1) return 0;
  let i = -1;
  for (let k = 1; k < line; k++) {
    i = text.indexOf('\n', i + 1);
    if (i === -1) return text.length;
  }
  return i + 1;
}

export function leadingWhitespace(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

/** Retire le préfixe et le suffixe communs d'une modification. */
export function trimEdit(e: Edit): Edit {
  let { start, removed, inserted } = e;
  let p = 0;
  const maxP = Math.min(removed.length, inserted.length);
  while (p < maxP && removed.charCodeAt(p) === inserted.charCodeAt(p)) p++;
  // Ne coupe pas une paire de substitution UTF-16.
  if (p > 0 && isHighSurrogate(removed.charCodeAt(p - 1))) p--;
  let s = 0;
  const maxS = Math.min(removed.length, inserted.length) - p;
  while (s < maxS && removed.charCodeAt(removed.length - 1 - s) === inserted.charCodeAt(inserted.length - 1 - s)) s++;
  if (s > 0 && isLowSurrogate(removed.charCodeAt(removed.length - s))) s--;
  start += p;
  removed = removed.slice(p, removed.length - s);
  inserted = inserted.slice(p, inserted.length - s);
  return { start, removed, inserted };
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}
function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** Différence complète (préfixe et suffixe communs) : O(n), sert de repli. */
export function diffFull(old: string, neu: string): Edit {
  let p = 0;
  const max = Math.min(old.length, neu.length);
  while (p < max && old.charCodeAt(p) === neu.charCodeAt(p)) p++;
  if (p > 0 && isHighSurrogate(old.charCodeAt(p - 1))) p--;
  let s = 0;
  const maxS = max - p;
  while (s < maxS && old.charCodeAt(old.length - 1 - s) === neu.charCodeAt(neu.length - 1 - s)) s++;
  if (s > 0 && isLowSurrogate(old.charCodeAt(old.length - s))) s--;
  return { start: p, removed: old.slice(p, old.length - s), inserted: neu.slice(p, neu.length - s) };
}

/**
 * Modification produite par un événement de saisie, déduite des sélections
 * avant (s0, e0) et après (s1, e1) : une saisie remplace toujours une plage
 * contiguë, se terminant au plus tard à la fin de la nouvelle sélection et
 * commençant au plus tôt au minimum des deux débuts de sélection. Renvoie
 * `null` si les contrôles de cohérence échouent (l'appelant utilise alors
 * `diffFull`).
 */
export function editFromSelections(old: string, neu: string, s0: number, e0: number, s1: number, e1: number): Edit | null {
  void e0;
  const c = e1;
  const start = Math.min(s0, s1);
  const suffix = neu.length - c;
  const oldEnd = old.length - suffix;
  if (start < 0 || c < start || suffix < 0 || oldEnd < start || oldEnd > old.length) return null;
  // Contrôles locaux : quelques caractères de part et d'autre doivent être identiques.
  for (let k = 1; k <= 8 && start - k >= 0; k++) {
    if (old.charCodeAt(start - k) !== neu.charCodeAt(start - k)) return null;
  }
  for (let k = 0; k < 8 && oldEnd + k < old.length; k++) {
    if (old.charCodeAt(oldEnd + k) !== neu.charCodeAt(c + k)) return null;
  }
  return trimEdit({ start, removed: old.slice(start, oldEnd), inserted: neu.slice(start, c) });
}

/** Applique une modification à un texte (tests, vérifications). */
export function applyEdit(text: string, e: Edit): string {
  return text.slice(0, e.start) + e.inserted + text.slice(e.start + e.removed.length);
}

export function revertEdit(text: string, e: Edit): string {
  return text.slice(0, e.start) + e.removed + text.slice(e.start + e.inserted.length);
}

/** Nombre de caractères (points de code) — les paires UTF-16 comptent pour un. */
export function countCodePoints(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n--;
        i++;
      }
    }
  }
  return n;
}
