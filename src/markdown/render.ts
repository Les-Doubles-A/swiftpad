// Rendu Markdown (module chargé à la demande : markdown-it n'est téléchargé
// en mémoire qu'à la première ouverture de l'aperçu).
//
// Sécurité :
// * `html: false` : tout HTML brut du document est échappé (aucun script,
//   aucun gestionnaire d'événement, aucun iframe) ;
// * liens : markdown-it refuse javascript:, vbscript:, file: et data:
//   (sauf images) ; les liens restants sont neutralisés (`href="#"`) et
//   traités par l'application (confirmation avant navigateur externe) ;
// * images : seules les images locales sont chargées (via le noyau), les
//   images distantes ne sont jamais téléchargées ;
// * identifiants de titres préfixés (« md-h- ») : pas de collision avec
//   les globales de la page (DOM clobbering).

import MarkdownIt, { type Token } from 'markdown-it';
import { slugify } from './outline';

export { slugify };

export interface Heading {
  level: number;
  text: string;
  line: number;
  id: string;
}

export interface Rendered {
  html: string;
  headings: Heading[];
}

let instance: MarkdownIt | null = null;

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function create(): MarkdownIt {
  const md = new MarkdownIt('default', { html: false, linkify: false, typographer: false });

  md.core.ruler.push('swiftpad_meta', (state) => {
    const used = new Map<string, number>();
    const headings: Heading[] = [];
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.map && t.block && (t.nesting === 1 || t.type === 'fence' || t.type === 'code_block' || t.type === 'hr')) {
        t.attrSet('data-line', String(t.map[0]));
      }
      if (t.type === 'heading_open') {
        const inline = tokens[i + 1];
        const text = inline?.children ? inline.children.filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join('') : inline?.content ?? '';
        let slug = slugify(text);
        const n = used.get(slug) ?? 0;
        used.set(slug, n + 1);
        if (n > 0) slug = `${slug}-${n}`;
        const id = `md-h-${slug}`;
        t.attrSet('id', id);
        headings.push({ level: Number(t.tag.slice(1)), text, line: t.map ? t.map[0] : 0, id });
      }
    }
    state.env.headings = headings;
  });

  const rules = md.renderer.rules;

  rules.image = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    const src = t.attrGet('src') ?? '';
    const alt = self.renderInlineAsText(t.children ?? [], options, env);
    const title = t.attrGet('title');
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
    if (/^data:image\/(png|jpe?g|gif|webp);/i.test(src)) {
      return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"${titleAttr}>`;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) {
      // Image distante (http, https…) : jamais téléchargée.
      return `<span class="md-remote" title="${escapeAttr(src)}">[Image distante non chargée${alt ? ` : ${escapeAttr(alt)}` : ''}]</span>`;
    }
    return `<img class="md-img-pending" data-local="${escapeAttr(src)}" alt="${escapeAttr(alt)}"${titleAttr}>`;
  };

  rules.link_open = (tokens, idx, options, _env, self) => {
    const t = tokens[idx];
    const href = t.attrGet('href') ?? '';
    t.attrSet('data-href', href);
    t.attrSet('href', '#');
    t.attrSet('title', href);
    t.attrSet('rel', 'noopener noreferrer');
    return self.renderToken(tokens, idx, options);
  };

  const align = (tokens: Token[], idx: number, options: unknown, _env: unknown, self: MarkdownIt['renderer']) => {
    const t = tokens[idx];
    const style = t.attrGet('style');
    if (style && t.attrs) {
      t.attrs = t.attrs.filter(([k]) => k !== 'style');
      const m = /text-align:\s*(left|center|right)/.exec(style);
      if (m) t.attrSet('class', `md-align-${m[1]}`);
    }
    return self.renderToken(tokens, idx, options);
  };
  rules.th_open = align;
  rules.td_open = align;
  return md;
}

export function render(src: string): Rendered {
  if (!instance) instance = create();
  const env: Record<string, unknown> = {};
  const html = instance.render(src, env);
  return { html, headings: (env.headings as Heading[]) ?? [] };
}
