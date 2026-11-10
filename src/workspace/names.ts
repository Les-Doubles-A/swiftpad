// Règles de nommage Windows (miroir de crates/swiftpad-core/src/names.rs,
// pour un retour immédiat pendant la saisie ; le noyau revalide toujours).

const FORBIDDEN = /[<>:"/\\|?*]/;
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 10 }, (_, i) => `COM${i}`), ...Array.from({ length: 10 }, (_, i) => `LPT${i}`), 'COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³']);

export function validateName(name: string): string | null {
  if (!name) return 'Le nom ne peut pas être vide.';
  if (name === '.' || name === '..') return '« . » et « .. » ne sont pas des noms valides.';
  const bad = FORBIDDEN.exec(name);
  if (bad) return `Le caractère « ${bad[0]} » n’est pas autorisé (interdits : < > : " / \\ | ? *).`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return 'Le nom contient un caractère de contrôle.';
  if (name.endsWith(' ') || name.endsWith('.')) return 'Le nom ne peut pas se terminer par une espace ou un point.';
  const base = name.split('.')[0].trimEnd().toUpperCase();
  if (RESERVED.has(base)) return `« ${name.split('.')[0].trimEnd()} » est un nom réservé par Windows.`;
  if (name.length > 255) return 'Le nom est trop long (255 caractères au maximum).';
  return null;
}
