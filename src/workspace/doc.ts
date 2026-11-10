// Modèle d'un document ouvert dans un onglet.

import type { TextState } from '../editor/textview';
import { randomId } from '../ui/dom';

export type DocKind = 'text' | 'big' | 'image' | 'info';
export type Eol = 'crlf' | 'lf' | 'cr';
export type MdView = 'source' | 'split' | 'preview';

export interface FileMeta {
  encoding: string;
  encodingLabel: string;
  confidence: string;
  uncertain: boolean;
  replaced: number;
  eol: Eol;
  eolMixed: boolean;
  eolStats: { crlf: number; lf: number; cr: number } | null;
  stamp: string | null;
  mtimeMs: number;
  size: number;
  readonly: boolean;
  linkTarget: string | null;
  binaryReason: string | null;
}

export interface InfoAction {
  label: string;
  run: () => unknown;
  primary?: boolean;
}

export interface Infobar {
  id: string;
  kind: 'info' | 'warning' | 'error';
  text: string;
  actions: InfoAction[];
  dismissible?: boolean;
}

export const ENCODINGS: { id: string; label: string }[] = [
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'utf-8-bom', label: 'UTF-8 avec BOM' },
  { id: 'utf-16le', label: 'UTF-16 LE' },
  { id: 'utf-16be', label: 'UTF-16 BE' },
  { id: 'windows-1252', label: 'Windows-1252 (ANSI)' },
];

export function encodingLabel(id: string): string {
  return ENCODINGS.find((e) => e.id === id)?.label ?? (id === 'utf-16le-nobom' ? 'UTF-16 LE sans BOM' : id === 'utf-16be-nobom' ? 'UTF-16 BE sans BOM' : id);
}

export const EOL_LABELS: Record<Eol, string> = { crlf: 'CRLF', lf: 'LF', cr: 'CR' };
export const EOL_LONG: Record<Eol, string> = { crlf: 'Windows (CRLF)', lf: 'Unix (LF)', cr: 'Mac classique (CR)' };

const LANGS: Record<string, string> = {
  txt: 'Texte brut', text: 'Texte brut', log: 'Journal', md: 'Markdown', markdown: 'Markdown', csv: 'CSV', tsv: 'TSV',
  json: 'JSON', jsonc: 'JSON avec commentaires', xml: 'XML', html: 'HTML', htm: 'HTML', css: 'CSS', js: 'JavaScript',
  mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', jsx: 'JavaScript (JSX)', tsx: 'TypeScript (TSX)', py: 'Python',
  rs: 'Rust', c: 'C', cpp: 'C++', cc: 'C++', h: 'En-tête C/C++', hpp: 'En-tête C++', java: 'Java', sql: 'SQL',
  yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI', conf: 'Configuration', cfg: 'Configuration', bat: 'Batch',
  cmd: 'Batch', ps1: 'PowerShell', sh: 'Shell', gitignore: 'Git (ignore)', svg: 'SVG',
};

export function extOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower === '.gitignore') return 'gitignore';
  if (lower.endsWith('.env.example')) return 'env.example';
  const i = lower.lastIndexOf('.');
  return i > 0 ? lower.slice(i + 1) : '';
}

export function languageOf(name: string): string {
  const ext = extOf(name);
  if (ext === 'env.example') return 'Variables d’environnement';
  return LANGS[ext] ?? 'Texte';
}

export function isMarkdownName(name: string): boolean {
  const e = extOf(name);
  return e === 'md' || e === 'markdown';
}

export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);
/** Ouverture déléguée à l'application par défaut : documents inertes uniquement. */
export const SAFE_DEFAULT_APP_EXTS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'mp3', 'mp4', 'wav', 'flac', 'mkv', 'avi', 'zip', '7z']);

export class Doc {
  readonly id: string;
  kind: DocKind;
  path: string | null;
  name: string;
  untitledNo: number;
  loaded = false;
  loading = false;
  text: TextState | null = null;
  meta: FileMeta | null = null;
  /** Encodage et fins de ligne appliqués au prochain enregistrement. */
  encodingTarget = 'utf-8';
  eolTarget: Eol = 'crlf';
  metaDirty = false;
  external: null | 'changed' | 'deleted' = null;
  /** Empreinte externe déjà signalée et ignorée par l'utilisateur. */
  ignoredStamp: string | null = null;
  lossyAcknowledged = false;
  /** Contenu binaire ouvert comme texte : lecture seule tant que non déverrouillé. */
  editLocked = false;
  heavy = false;
  /** L'utilisateur a confirmé l'affichage d'un contenu binaire comme texte. */
  binaryOk = false;
  mdView: MdView = 'source';
  infobars: Infobar[] = [];
  big: { id: number; info: any; jobId: number | null } | null = null;
  imageUrl: string | null = null;
  imageInfo: { mime: string; size: number } | null = null;
  info: any = null;
  /** Restauration : sélection et défilement à appliquer au chargement. */
  restore: { sel?: [number, number]; scroll?: [number, number]; recoveryId?: string } | null = null;
  recoveryWritten = false;
  /** Position demandée à l'ouverture (résultat de recherche, aller à la ligne). */
  pendingGoto: { line: number; col?: number; len?: number } | null = null;

  constructor(kind: DocKind, path: string | null, name: string, untitledNo = 0, id?: string) {
    this.id = id ?? randomId('doc');
    this.kind = kind;
    this.path = path;
    this.name = name;
    this.untitledNo = untitledNo;
  }

  get dirty(): boolean {
    if (this.kind !== 'text' || !this.text) return false;
    return this.text.history.isDirty() || this.metaDirty;
  }

  get isMarkdown(): boolean {
    return isMarkdownName(this.name);
  }

  get language(): string {
    return this.path || this.name.includes('.') ? languageOf(this.name) : 'Texte brut';
  }

  get readOnlyView(): boolean {
    return !!this.text?.readOnly;
  }

  dir(sep: string): string | null {
    if (!this.path) return null;
    const i = Math.max(this.path.lastIndexOf('\\'), this.path.lastIndexOf('/'));
    if (i <= 0) return this.path.slice(0, i + 1) || sep;
    // « C:\fichier.txt » → « C:\ »
    if (i === 2 && this.path[1] === ':') return this.path.slice(0, 3);
    return this.path.slice(0, i);
  }

  addInfobar(bar: Infobar): void {
    this.infobars = this.infobars.filter((b) => b.id !== bar.id);
    this.infobars.push(bar);
  }

  removeInfobar(id: string): void {
    this.infobars = this.infobars.filter((b) => b.id !== id);
  }
}

export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i >= 0 ? p.slice(i + 1) || p : p;
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  if (i < 0) return p;
  if (i === 2 && p[1] === ':') return p.slice(0, 3);
  if (i === 0) return p.slice(0, 1);
  return p.slice(0, i);
}

/** Égalité de chemins (insensible à la casse sous Windows). */
export function samePath(a: string | null, b: string | null, windows: boolean): boolean {
  if (!a || !b) return false;
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isInside(child: string, parent: string, windows: boolean): boolean {
  const norm = (s: string) => (windows ? s.toLowerCase().replace(/\//g, '\\') : s);
  const c = norm(child);
  let p = norm(parent);
  if (c === p) return true;
  if (!p.endsWith('\\') && !p.endsWith('/')) p += windows ? '\\' : '/';
  return c.startsWith(p);
}
