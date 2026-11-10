// Préférences (appliquées immédiatement), liste des raccourcis, à propos.

import { h, humanSize } from './dom';
import { openDialog } from './dialog';
import { Settings } from '../core/settings';
import { rpc, errorMessage } from '../core/rpc';
import { Commands, displayKey } from './commands';
import { ENCODINGS } from '../workspace/doc';
import { confirmDanger } from './dialog';

export interface PrefsHost {
  settings: Settings;
  dataInfo: Record<string, string> | null;
  notify(msg: string, kind?: 'info' | 'error'): void;
  clearSession(): Promise<void>;
}

/** Polices proposées (fournies avec Windows) ; « Autre… » accepte toute pile CSS. */
const FONTS: [string, string][] = [
  ['Constantia, Cambria, Georgia, serif', 'Constantia — serif de lecture (par défaut)'],
  ['Georgia, serif', 'Georgia — serif'],
  ['Cambria, Georgia, serif', 'Cambria — serif'],
  ['"Palatino Linotype", "Book Antiqua", Palatino, serif', 'Palatino — serif'],
  ['"Segoe UI", system-ui, sans-serif', 'Segoe UI — sans serif'],
  ['Calibri, "Segoe UI", sans-serif', 'Calibri — sans serif'],
  ['"Cascadia Mono", "Cascadia Code", Consolas, monospace', 'Cascadia Mono — chasse fixe'],
  ['Consolas, "Courier New", monospace', 'Consolas — chasse fixe'],
];

export function openPreferences(host: PrefsHost): void {
  const s = host.settings;
  const d = openDialog<null>({ title: 'Préférences', cancelValue: null, wide: true, className: 'prefs' });
  let uid = 0;
  const id = () => `pref-${++uid}`;
  const check = (key: string, label: string, hint?: string) => {
    const i = id();
    const input = h('input', { type: 'checkbox', id: i });
    input.checked = !!s.get(key);
    input.addEventListener('change', () => s.set(key, input.checked));
    return h('div', { class: 'pref-row' }, input, h('label', { attrs: { for: i }, text: label }), hint ? h('span', { class: 'pref-hint', text: hint }) : null);
  };
  const select = (key: string, label: string, options: [string, string][]) => {
    const i = id();
    const sel = h('select', { class: 'input', id: i });
    for (const [v, l] of options) {
      const o = h('option', { text: l });
      o.value = v;
      sel.append(o);
    }
    sel.value = String(s.get(key));
    sel.addEventListener('change', () => s.set(key, sel.value));
    return h('div', { class: 'pref-row' }, h('label', { attrs: { for: i }, text: label }), sel);
  };
  const num = (key: string, label: string, min: number, max: number, unit = '') => {
    const i = id();
    const input = h('input', { class: 'input input-num', type: 'number', id: i, value: String(s.get(key)), attrs: { min, max } });
    input.addEventListener('change', () => {
      const v = Math.max(min, Math.min(max, Math.round(Number(input.value) || min)));
      input.value = String(v);
      s.set(key, v);
    });
    return h('div', { class: 'pref-row' }, h('label', { attrs: { for: i }, text: label }), input, unit ? h('span', { class: 'pref-unit', text: unit }) : null);
  };

  // Police : liste de polices Windows, ou pile CSS libre.
  const fontId = id();
  const fontSel = h('select', { class: 'input', id: fontId });
  for (const [v, l] of [...FONTS, ['custom', 'Autre police…'] as [string, string]]) {
    const o = h('option', { text: l });
    o.value = v;
    fontSel.append(o);
  }
  const fontOther = h('input', { class: 'input', value: s.get('editor.fontFamily'), attrs: { spellcheck: 'false', 'aria-label': 'Nom de la police', placeholder: 'ex. « Iowan Old Style », serif' } });
  const current = s.get<string>('editor.fontFamily');
  fontSel.value = FONTS.some(([v]) => v === current) ? current : 'custom';
  fontOther.hidden = fontSel.value !== 'custom';
  fontSel.addEventListener('change', () => {
    fontOther.hidden = fontSel.value !== 'custom';
    if (fontSel.value === 'custom') fontOther.focus();
    else s.set('editor.fontFamily', fontSel.value);
  });
  fontOther.addEventListener('change', () => fontOther.value.trim() && s.set('editor.fontFamily', fontOther.value.trim()));

  // Interligne : curseur avec valeur affichée (1,65…).
  const lhId = id();
  const lh = h('input', { type: 'range', id: lhId, class: 'pref-range', attrs: { min: 100, max: 250, step: 5 } });
  // La valeur s'affecte après les bornes : sinon le navigateur la ramène
  // dans l'intervalle par défaut (0 à 100).
  lh.value = String(s.get('editor.lineHeight') ?? 165);
  const lhOut = h('output', { class: 'pref-value', attrs: { for: lhId } });
  const showLh = () => (lhOut.textContent = (Number(lh.value) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2 }));
  showLh();
  lh.addEventListener('input', () => {
    showLh();
    s.set('editor.lineHeight', Number(lh.value));
  });

  // Couleurs libres : fond, texte, curseur. Vide = couleur du thème.
  const themeColor = (token: string) => getComputedStyle(document.documentElement).getPropertyValue(token).trim() || '#000000';
  const colorRow = (key: string, label: string, token: string) => {
    const i = id();
    const input = h('input', { type: 'color', id: i, class: 'pref-color' });
    const sync = () => (input.value = s.get<string | null>(key) ?? themeColor(token));
    sync();
    input.addEventListener('input', () => s.set(key, input.value.toLowerCase()));
    const state = h('span', { class: 'pref-unit' });
    const showState = () => (state.textContent = s.get(key) ? 'personnalisée' : 'du thème');
    showState();
    input.addEventListener('change', showState);
    return { row: h('div', { class: 'pref-row' }, h('label', { class: 'pref-color-label', attrs: { for: i }, text: label }), input, state), sync, showState };
  };
  const colors = [colorRow('colors.background', 'Fond', '--paper-t'), colorRow('colors.text', 'Texte', '--ink-t'), colorRow('colors.caret', 'Curseur', '--caret-t')];
  const resetColors = h('button', { class: 'btn btn-small', type: 'button', text: 'Revenir aux couleurs du thème' });
  resetColors.addEventListener('click', () => {
    for (const k of ['colors.background', 'colors.text', 'colors.caret']) s.set(k, null);
    for (const c of colors) {
      c.sync();
      c.showState();
    }
  });
  // Changer de thème met à jour les couleurs proposées (celles non
  // personnalisées) : aussitôt (le thème est déjà appliqué à la page), puis à
  // l'image suivante (thème « système » résolu de façon asynchrone).
  const off = s.onChange((k) => {
    if (k !== 'theme') return;
    colors.forEach((c) => c.sync());
    requestAnimationFrame(() => colors.forEach((c) => c.sync()));
  });

  const section = (title: string, ...rows: (HTMLElement | null)[]) => h('fieldset', { class: 'pref-group' }, h('legend', { text: title }), ...rows);
  const info = host.dataInfo ?? {};
  const btn = (label: string, fn: () => unknown) => {
    const b = h('button', { class: 'btn btn-small', type: 'button', text: label });
    b.addEventListener('click', () => void fn());
    return b;
  };
  d.body.append(
    h(
      'div',
      { class: 'prefs-grid' },
      section(
        'Apparence',
        select('theme', 'Thème', [
          ['system', 'Suivre Windows'],
          ['light', 'Clair'],
          ['dark', 'Sombre'],
          ['sepia', 'Sépia'],
        ]),
        h('div', { class: 'pref-row' }, h('label', { attrs: { for: fontId }, text: 'Police' }), fontSel),
        h('div', { class: 'pref-row pref-sub' }, fontOther),
        num('editor.fontSize', 'Taille du texte', 6, 72, 'px'),
        h('div', { class: 'pref-row' }, h('label', { attrs: { for: lhId }, text: 'Interligne' }), lh, lhOut),
        select('editor.columnWidth', 'Largeur du texte', [
          ['narrow', 'Colonne étroite'],
          ['medium', 'Colonne moyenne'],
          ['full', 'Pleine largeur'],
        ]),
      ),
      section('Couleurs', ...colors.map((c) => c.row), h('div', { class: 'pref-actions' }, resetColors)),
      section(
        'Écriture',
        check('editor.wordWrap', 'Retour automatique à la ligne'),
        check('editor.lineNumbers', 'Numéros de ligne'),
        check('editor.showInvisibles', 'Afficher les espaces et tabulations'),
        check('editor.highlightTrailing', 'Signaler les espaces en fin de ligne'),
        check('ui.statusBar', 'Barre d’état (position, encodage, fins de ligne)'),
        check('ui.reduceMotion', 'Réduire les animations'),
        num('editor.tabSize', 'Largeur des tabulations', 1, 16, 'espaces'),
        check('editor.insertSpaces', 'Insérer des espaces au lieu de tabulations'),
        check('editor.autoIndent', 'Conserver l’indentation à la ligne suivante'),
        select('files.defaultEncoding', 'Encodage des nouveaux documents', ENCODINGS.map((e) => [e.id, e.label])),
        select('files.defaultEol', 'Fins de ligne des nouveaux documents', [
          ['crlf', 'Windows (CRLF)'],
          ['lf', 'Unix (LF)'],
          ['cr', 'Mac classique (CR)'],
        ]),
      ),
      section(
        'Gros fichiers',
        num('files.fluidEditMB', 'Édition directe jusqu’à', 1, 64, 'Mo (au-delà : lecture rapide)'),
        num('files.maxEditMB', 'Édition sur demande jusqu’à', 1, 512, 'Mo'),
      ),
      section(
        'Session et confidentialité',
        check('session.restore', 'Rouvrir les onglets de la dernière session', 'Désactivé : aucun chemin n’est mémorisé.'),
        check('session.recovery', 'Copies de récupération des modifications non enregistrées', 'Stockées uniquement sur cet ordinateur.'),
        check('session.hotExit', 'Fermer sans demander et restaurer les modifications au prochain lancement', 'Nécessite les copies de récupération.'),
        h('dl', { class: 'pref-paths' }, h('dt', { text: 'Paramètres' }), h('dd', { text: info.settingsFile ?? '—' }), h('dt', { text: 'Session' }), h('dd', { text: info.sessionFile ?? '—' }), h('dt', { text: 'Récupération' }), h('dd', { text: info.recoveryDir ?? '—' })),
        h(
          'div',
          { class: 'pref-actions' },
          btn('Effacer les fichiers récents', () => {
            s.set('files.recent', []);
            host.notify('Liste des fichiers récents effacée.');
          }),
          btn('Supprimer les copies de récupération', async () => {
            if (!(await confirmDanger('Copies de récupération', 'Supprimer toutes les copies de récupération ?', 'Supprimer', 'Les modifications non enregistrées des documents ouverts restent dans l’éditeur.'))) return;
            try {
              const n = await rpc('recovery.purge');
              host.notify(`${n} fichier(s) de récupération supprimé(s).`);
            } catch (e) {
              host.notify(errorMessage(e), 'error');
            }
          }),
          btn('Oublier la session', () => host.clearSession()),
        ),
      ),
      section(
        'Markdown',
        select('markdown.defaultView', 'Vue à l’ouverture', [
          ['source', 'Source seule (aperçu désactivé)'],
          ['split', 'Source et aperçu'],
          ['preview', 'Aperçu seul'],
        ]),
        check('markdown.toc', 'Table des matières dans l’aperçu (3 titres ou plus)'),
      ),
    ),
  );
  const reset = h('button', { class: 'btn', type: 'button', text: 'Réinitialiser…' });
  reset.addEventListener('click', async () => {
    if (!(await confirmDanger('Réinitialiser', 'Rétablir tous les paramètres par défaut ?', 'Réinitialiser', 'Les fichiers récents sont conservés.'))) return;
    const def = await rpc('settings.defaults');
    await s.reset(def);
    d.close(null);
    host.notify('Paramètres par défaut rétablis.');
  });
  const close = h('button', { class: 'btn btn-primary', type: 'button', text: 'Fermer' });
  close.addEventListener('click', () => d.close(null));
  d.footer.append(reset, close);
  void d.result.finally(off);
  close.focus();
}

export function openShortcuts(commands: Commands): void {
  const d = openDialog<null>({ title: 'Raccourcis clavier', cancelValue: null, wide: true });
  const table = h('table', { class: 'keys-table' }, h('thead', null, h('tr', null, h('th', { text: 'Action' }), h('th', { text: 'Raccourci' }), h('th', { text: 'Contexte' }))));
  const tbody = h('tbody');
  const ctx: Record<string, string> = { editor: 'Éditeur', global: 'Partout' };
  const extra: [string, string, string][] = [
    ['Annuler / Rétablir', 'Ctrl+Z / Ctrl+Y (ou Ctrl+Maj+Z)', 'Éditeur'],
    ['Couper, copier, coller', 'Ctrl+X, Ctrl+C, Ctrl+V', 'Éditeur'],
    ['Indenter / désindenter', 'Tab / Maj+Tab', 'Éditeur'],
    ['Suivant / précédent dans la recherche', 'Entrée / Maj+Entrée, F3 / Maj+F3', 'Barre de recherche'],
    ['Casse, mot entier, expression', 'Alt+C, Alt+W, Alt+R', 'Barre de recherche'],
    ['Menus', 'Alt (ou F10), Alt+lettre soulignée', 'Partout'],
    ['Zoom', 'Ctrl+molette', 'Éditeur'],
  ];
  const rows = commands
    .list()
    .filter((c) => c.keys?.length)
    .map((c) => [c.label, c.keys!.map(displayKey).join(' ou '), ctx[c.scope ?? 'global']] as [string, string, string]);
  for (const [a, k, c] of [...rows, ...extra].sort((x, y) => x[0].localeCompare(y[0], 'fr'))) tbody.append(h('tr', null, h('td', { text: a }), h('td', null, h('kbd', { text: k })), h('td', { text: c })));
  table.append(tbody);
  d.body.append(
    h('p', { class: 'dlg-detail', text: 'F5 insère la date et l’heure (format du Bloc-notes : « HH:MM JJ/MM/AAAA », selon la langue du système).' }),
    h('div', { class: 'keys-wrap' }, table),
  );
  const close = h('button', { class: 'btn btn-primary', type: 'button', text: 'Fermer' });
  close.addEventListener('click', () => d.close(null));
  d.footer.append(close);
  close.focus();
}

export function openAbout(version: string): void {
  const d = openDialog<null>({ title: 'À propos de SwiftPad', cancelValue: null });
  d.body.append(
    h('p', { class: 'dlg-msg', text: `SwiftPad ${version}` }),
    h('p', { class: 'dlg-detail', text: 'Un écran pour écrire : éditeur de texte sobre et léger. Fonctionne entièrement hors ligne : aucun compte, aucune télémétrie, aucune intelligence artificielle, aucun appel réseau. Vos fichiers restent sur cet ordinateur.' }),
    h('p', { class: 'dlg-detail', text: 'Composants : Tauri 2 (MIT/Apache-2.0), WebView2 (Microsoft), markdown-it (MIT) et ses dépendances (MIT, BSD-2-Clause).' }),
  );
  const perf = h('dl', { class: 'about-perf' });
  d.body.append(h('p', { class: 'dlg-detail', text: 'Mesures de cette session (calculées sur cet ordinateur, jamais transmises) :' }), perf);
  void fillPerf(perf);
  const close = h('button', { class: 'btn btn-primary', type: 'button', text: 'Fermer' });
  close.addEventListener('click', () => d.close(null));
  d.footer.append(close);
  close.focus();
}

/** Mesures locales de la session : démarrage et mémoire. */
async function fillPerf(el: HTMLElement): Promise<void> {
  const p = (window as any).__swiftpadPerf as import('../main').PerfInfo | undefined;
  const rows: [string, string][] = [];
  const ms = (x: number) => `${Math.round(x).toLocaleString('fr-FR')} ms`;
  if (p?.processStartMs && p.shownEpochMs) rows.push(['Lancement → fenêtre affichée', ms(p.shownEpochMs - p.processStartMs)]);
  if (p?.processStartMs) rows.push(['Lancement → interface prête', ms(p.readyEpochMs - p.processStartMs)]);
  if (p) rows.push(['Chargement de l’interface (script → prête)', ms(p.scriptToReadyMs)]);
  try {
    const r = await rpc<any>('perf.report');
    if (r.residentBytes) rows.push(['Mémoire du processus SwiftPad (hors WebView2)', humanSize(r.residentBytes)]);
  } catch {
    /* mesure indisponible */
  }
  const mem = (performance as any).memory;
  if (mem?.usedJSHeapSize) rows.push(['Tas JavaScript utilisé', humanSize(mem.usedJSHeapSize)]);
  rows.push(['Éléments de l’interface (DOM)', document.getElementsByTagName('*').length.toLocaleString('fr-FR')]);
  for (const [k, v] of rows) el.append(h('dt', { text: k }), h('dd', { text: v }));
}
