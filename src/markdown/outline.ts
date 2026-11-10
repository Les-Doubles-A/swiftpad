// Titres d'un document Markdown, extraits sans moteur de rendu (léger,
// utilisable même aperçu fermé) : titres ATX (« # Titre ») et Setext
// (« Titre » souligné par === ou ---), hors blocs de code.

export interface OutlineItem {
  level: number;
  text: string;
  /** Ligne (base 0). */
  line: number;
}

export function extractHeadings(src: string, max = 2000): OutlineItem[] {
  const out: OutlineItem[] = [];
  const lines = src.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const line = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0].repeat(f[1].length);
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    const atx = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line);
    if (atx) {
      out.push({ level: atx[1].length, text: atx[2].trim(), line: i });
      continue;
    }
    if (i + 1 < lines.length && line.trim() && !/^ {0,3}[-*+>]|^ {4}/.test(line)) {
      const next = lines[i + 1];
      if (/^ {0,3}=+[ \t]*$/.test(next)) out.push({ level: 1, text: line.trim(), line: i });
      else if (/^ {0,3}-+[ \t]*$/.test(next) && next.trim().length >= 2) out.push({ level: 2, text: line.trim(), line: i });
    }
  }
  return out;
}

/** Identifiant d’ancre d’un titre (identique dans l’aperçu et la table des matières). */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'titre'
  );
}
