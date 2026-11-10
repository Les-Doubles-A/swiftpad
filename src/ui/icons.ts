// Icônes SVG locales (16 × 16, trait). Aucune police ni ressource distante.

const P: Record<string, string> = {
  open: '<path d="M1.5 4.5v8h11l2-6H4l-2.5 6"/><path d="M1.5 12.5v-9h4l1.5 1.5H12v1.5"/>',
  save: '<path d="M2.5 2.5h9l2 2v9h-11z"/><path d="M5 2.5v3h5v-3M5 13.5v-4h6v4"/>',
  search: '<circle cx="6.5" cy="6.5" r="4"/><path d="m9.5 9.5 4.5 4.5"/>',
  replace: '<path d="M2 4.5h7M6.5 2 9 4.5 6.5 7"/><path d="M14 11.5H7M9.5 9 7 11.5 9.5 14"/>',
  preview: '<path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2"/>',
  split: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M8 2.5v11"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  chevronRight: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
  folder: '<path d="M1.5 3.5h4.5l1.5 1.5h7v8h-13z"/>',
  folderOpen: '<path d="M1.5 12.5v-9H6l1.5 1.5h5v2"/><path d="M1.5 12.5 3.5 7h11l-2 5.5z"/>',
  file: '<path d="M3.5 1.5h6L13 5v9.5H3.5z"/><path d="M9.5 1.5V5H13"/>',
  fileText: '<path d="M3.5 1.5h6L13 5v9.5H3.5z"/><path d="M9.5 1.5V5H13M5.5 8h5M5.5 10h5M5.5 12h3"/>',
  fileCode: '<path d="M3.5 1.5h6L13 5v9.5H3.5z"/><path d="M9.5 1.5V5H13M7 8 5.5 9.75 7 11.5M9.5 8l1.5 1.75-1.5 1.75"/>',
  fileMd: '<path d="M3.5 1.5h6L13 5v9.5H3.5z"/><path d="M9.5 1.5V5H13M5.5 12V8.5l1.5 2 1.5-2V12M10.5 8.5V12M9.5 11l1 1 1-1"/>',
  image: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><circle cx="5.5" cy="6" r="1.25"/><path d="m1.5 12 4-4 3 3 2-2 4 4"/>',
  back: '<path d="M7 3.5 2.5 8 7 12.5M2.5 8h11"/>',
  more: '<circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/>',
  settings: '<circle cx="8" cy="8" r="2.25"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  home: '<path d="M2 7.5 8 2.5l6 5"/><path d="M3.5 6.5v7h9v-7"/>',
  caseSensitive: '<path d="M1.5 12 4.5 4l3 8M2.6 9.5h3.8"/><path d="M13.5 8.5v3.5M13.5 10a2 2 0 1 1-2-2 2 2 0 0 1 2 2z"/>',
  wholeWord: '<path d="M1.5 13.5h13"/><path d="M3 4l1.5 6L6 6l1.5 4L9 4"/><path d="M11 4v6M11 8a1.5 1.5 0 1 1 1.5 1.5"/>',
  regex: '<path d="M10.5 2v6M8 3.5l5 3M8 6.5l5-3"/><rect x="2.5" y="10.5" width="3" height="3"/>',
  arrowDown: '<path d="M8 2.5v11M3.5 9 8 13.5 12.5 9"/>',
  arrowUp: '<path d="M8 13.5v-11M3.5 7 8 2.5 12.5 7"/>',
  link: '<path d="M6.5 9.5 9.5 6.5"/><path d="M7 4.5 8.5 3a2.8 2.8 0 0 1 4 4L11 8.5M9 11.5 7.5 13a2.8 2.8 0 0 1-4-4L5 7.5"/>',
  warning: '<path d="M8 1.5 15 14H1z"/><path d="M8 6v4M8 12h.01"/>',
  info: '<circle cx="8" cy="8" r="6.5"/><path d="M8 7v4.5M8 4.75h.01"/>',
  lock: '<rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/>',
  check: '<path d="m2.5 8.5 3.5 3.5 7.5-8"/>',
  plus: '<path d="M8 2.5v11M2.5 8h11"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="9" rx="1"/><path d="M10.5 5.5v-3h-8v9h3"/>',
  cut: '<circle cx="4" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><path d="M5.5 10.5 12 2M10.5 10.5 4 2"/>',
  paste: '<path d="M5.5 2.5h-3v12h11v-12h-3"/><rect x="5.5" y="1.5" width="5" height="2.5" rx=".5"/>',
  external: '<path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5"/><path d="M11.5 9.5v4h-9v-9h4"/>',
  wrap: '<path d="M2 3.5h12M2 8h9.5a2 2 0 0 1 0 4H8M2 12.5h3.5"/><path d="M9.5 10.5 8 12l1.5 1.5"/>',
  goto: '<path d="M2 4h12M2 8h7M2 12h12"/><path d="M11.5 6 13.5 8l-2 2"/>',
  list: '<path d="M5.5 4h9M5.5 8h9M5.5 12h9"/><path d="M2 4h.01M2 8h.01M2 12h.01"/>',
};

export type IconName = keyof typeof P;

export function icon(name: IconName | string, cls = ''): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon ${cls}`.trim());
  // Contenu statique défini ci-dessus (jamais de données utilisateur).
  svg.innerHTML = P[name] ?? P.file;
  return svg;
}

/** Icône d'un fichier selon son extension. */
export function fileIconName(name: string, isDir: boolean, open = false): IconName {
  if (isDir) return open ? 'folderOpen' : 'folder';
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (['md', 'markdown'].includes(ext)) return 'fileMd';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif'].includes(ext)) return 'image';
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'rs', 'c', 'cpp', 'h', 'java', 'sql', 'json', 'jsonc', 'xml', 'html', 'css', 'yaml', 'yml', 'toml', 'sh', 'ps1', 'bat', 'cmd', 'ini', 'conf'].includes(ext)) return 'fileCode';
  if (['txt', 'log', 'text', 'csv', 'tsv'].includes(ext)) return 'fileText';
  return 'file';
}
