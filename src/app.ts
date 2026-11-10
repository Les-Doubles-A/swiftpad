// Composition de l'application : un écran d'écriture sobre (barre de menus,
// onglets discrets, colonne de texte), commandes, menus, thème et couleurs,
// session et cycle de vie de la fenêtre.

import { Settings } from './core/settings';
import { rpc, isTauri, errorMessage } from './core/rpc';
import * as native from './core/native';
import { debounce } from './core/events';
import { h } from './ui/dom';
import { Commands, focusContext, keyOf, type Command } from './ui/commands';
import { createMenubar, setMenuCommands, cmd, sep, sub, act, menuIsOpen, type MenuItem } from './ui/menu';
import { dialogOpen, alertMsg } from './ui/dialog';
import { Palette } from './ui/palette';
import { openPreferences, openShortcuts, openAbout } from './ui/prefs';
import { Workspace } from './workspace/workspace';
import { validateName } from './workspace/names';
import { basename, dirname } from './workspace/doc';

export interface Boot {
  version: string;
  platform: string;
  pathSep: string;
  settings: any;
  settingsNotice: any;
  session: any;
  recovery: any[];
  launchFiles: string[];
  home: string | null;
  places: { label: string; path: string }[];
  dataInfo: Record<string, string>;
  processStartMs: number | null;
  bootMs: number;
  /** Banc d'essai : SWIFTPAD_PERF_LOG définie (voir main.ts). */
  perfLog?: boolean;
}

/** Raccourcis du navigateur intégré (WebView2) à neutraliser : rechargement,
 *  historique, impression du navigateur, sources, téléchargements… */
const BROWSER_KEYS = new Set(['F5', 'Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+F5', 'Alt+Left', 'Alt+Right', 'Ctrl+U', 'Ctrl+J', 'Ctrl+Shift+Delete', 'Ctrl+Shift+I', 'F12', 'F7', 'Ctrl+Shift+J', 'Ctrl+Shift+C', 'Ctrl+Shift+B', 'Ctrl+Shift+O', 'Ctrl+D', 'Ctrl+E', 'Ctrl+Shift+M', 'Ctrl+N', 'Ctrl+T', 'Ctrl+Shift+T', 'Ctrl+W', 'Ctrl+P', 'Ctrl+S', 'Ctrl+O', 'Ctrl+F', 'Ctrl+G', 'Ctrl+H', 'F3', 'Shift+F3', 'Ctrl+Shift+G', 'Ctrl+Plus', 'Ctrl+Minus', 'Ctrl+0', 'Ctrl+Shift+Plus', 'F11', 'Alt+Home']);

export class App {
  readonly settings: Settings;
  readonly commands = new Commands();
  readonly ws: Workspace;
  readonly palette: Palette;
  private boot: Boot;
  private windows: boolean;
  private sep: string;
  private root: HTMLElement;
  private quitting = false;
  private saveSessionSoon = debounce(() => void this.saveSession(false), 1000);
  private refreshCommandsSoon = debounce(() => this.refreshCommands(), 30);

  constructor(boot: Boot, root: HTMLElement) {
    this.boot = boot;
    this.root = root;
    this.windows = boot.platform === 'windows';
    this.sep = boot.pathSep || (this.windows ? '\\' : '/');
    this.settings = new Settings(boot.settings);
    this.settings.onError = (m) => this.notify(m, 'error');
    setMenuCommands(this.commands);
    const notify = (m: string, k?: 'info' | 'error') => this.notify(m, k);
    this.ws = new Workspace({
      settings: this.settings,
      sep: this.sep,
      windows: this.windows,
      notify,
      refreshCommands: () => this.refreshCommandsSoon(),
      recentAdd: (p) => this.recentAdd(p),
      defaultDir: () => this.defaultDir(),
      sessionChanged: () => this.saveSessionSoon(),
      validateName,
      pathsChanged: () => {},
    });
    this.palette = new Palette({
      openTabs: () => this.ws.docs.map((d) => ({ label: d.name, detail: d.path ?? 'Non enregistré', run: () => this.ws.activate(d) })),
      recent: () => this.settings.get<string[]>('files.recent') ?? [],
      // Pas de recherche de fichiers dans un dossier : onglets et récents seulement.
      openPath: (p) => void this.ws.openPath(p),
      commands: () => this.commands.list().filter((c) => c.palette !== false).map((c) => ({ label: c.label, key: c.keys?.[0] ?? c.menuKey, run: () => this.commands.run(c.id), enabled: this.commands.isEnabled(c.id) })),
      goToLine: (l, c) => this.ws.goTo(l, c),
      lineCount: () => (this.ws.active?.kind === 'big' ? this.ws.bigView.lineCount() : this.ws.view.getLineCount()),
      headings: () => this.ws.headings(),
      goToHeading: (line) => {
        this.ws.goTo(line + 1);
        this.ws.preview.scrollToHeading(line);
      },
    });
    this.registerCommands();
    this.buildLayout();
    this.applySettings('*');
    this.settings.onChange((k) => this.applySettings(k));
    this.bindGlobal();
  }

  // --- notifications ---------------------------------------------------------

  notify(msg: string, kind: 'info' | 'error' = 'info'): void {
    this.ws.status.message(msg, kind, kind === 'error' ? 8000 : 4000);
  }

  private recentAdd(path: string): void {
    const list = (this.settings.get<string[]>('files.recent') ?? []).filter((p) => (this.windows ? p.toLowerCase() !== path.toLowerCase() : p !== path));
    this.settings.set('files.recent', [path, ...list].slice(0, 30));
    // Dernier dossier utilisé : proposé par Ouvrir et Enregistrer sous.
    const dir = dirname(path);
    if (dir && dir !== path) this.settings.set('files.workingDir', dir);
  }

  /** Dossier proposé par les boîtes de dialogue : document actif, dernier
   *  dossier utilisé, sinon Documents. */
  private defaultDir(): string | null {
    return this.ws?.active?.dir(this.sep) ?? this.settings.get<string>('files.workingDir') ?? this.boot.places.find((p) => p.label === 'Documents')?.path ?? this.boot.home;
  }

  // --- commandes -------------------------------------------------------------

  private registerCommands(): void {
    const c = (x: Command) => this.commands.register(x);
    const ws = this.ws;
    const s = this.settings;
    const hasText = () => !!ws.textView();
    const editable = () => !!ws.textView() && !ws.active?.readOnlyView;
    const isMd = () => !!ws.active && ws.active.kind === 'text' && ws.active.isMarkdown;
    const toggle = (key: string) => () => s.set(key, !s.get(key));

    // Fichier
    c({ id: 'file.new', label: 'Nouveau document', keys: ['Ctrl+N'], inInput: true, run: () => ws.newDocument() });
    c({ id: 'file.open', label: 'Ouvrir…', keys: ['Ctrl+O'], inInput: true, run: () => this.openDialog() });
    c({ id: 'file.quickOpen', label: 'Ouverture rapide…', keys: ['Ctrl+E'], inInput: true, run: () => this.palette.open('') });
    c({ id: 'file.save', label: 'Enregistrer', keys: ['Ctrl+S'], inInput: true, enabled: () => ws.canSave(), run: () => ws.save() });
    c({ id: 'file.saveAs', label: 'Enregistrer sous…', keys: ['Ctrl+Shift+S'], inInput: true, enabled: () => ws.canSave(), run: () => ws.save(ws.active, true) });
    c({ id: 'file.saveAll', label: 'Tout enregistrer', enabled: () => ws.docs.some((d) => d.dirty), run: () => ws.saveAll() });
    c({ id: 'file.close', label: 'Fermer l’onglet', keys: ['Ctrl+W', 'Ctrl+F4'], inInput: true, enabled: () => !!ws.active, run: () => ws.active && ws.close(ws.active) });
    c({ id: 'file.closeAll', label: 'Fermer tous les onglets', enabled: () => ws.docs.length > 0, run: () => ws.closeMany(ws.docs) });
    c({ id: 'file.reopenClosed', label: 'Rouvrir l’onglet fermé', keys: ['Ctrl+Shift+T'], inInput: true, enabled: () => ws.hasClosed(), run: () => ws.reopenClosed() });
    c({ id: 'file.reload', label: 'Recharger depuis le disque', enabled: () => hasText() && !!ws.active?.path, run: () => ws.reload() });
    c({ id: 'file.rename', label: 'Renommer le fichier…', keys: ['F2'], scope: 'editor', enabled: () => !!ws.active?.path && !ws.active.dirty, run: () => ws.renameFile() });
    c({ id: 'file.print', label: 'Imprimer…', keys: ['Ctrl+P'], inInput: true, enabled: hasText, run: () => ws.print() });
    c({ id: 'file.reveal', label: 'Afficher dans l’Explorateur Windows', enabled: () => !!ws.active?.path, run: () => ws.reveal() });
    c({ id: 'file.copyPath', label: 'Copier le chemin du document', enabled: () => !!ws.active?.path, run: () => navigator.clipboard.writeText(ws.active!.path!).then(() => this.notify('Chemin copié.'), () => this.notify('Copie impossible.', 'error')) });
    c({ id: 'file.prefs', label: 'Préférences…', keys: ['Ctrl+,'], inInput: true, run: () => this.openPrefs() });
    c({ id: 'file.quit', label: 'Quitter', menuKey: 'Alt+F4', run: () => this.quit() });

    // Édition
    c({ id: 'edit.undo', label: 'Annuler', keys: ['Ctrl+Z'], scope: 'editor', enabled: () => editable() && !!ws.active?.text?.history.canUndo(), run: () => ws.view.undo() });
    c({ id: 'edit.redo', label: 'Rétablir', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'], scope: 'editor', enabled: () => editable() && !!ws.active?.text?.history.canRedo(), run: () => ws.view.redo() });
    c({ id: 'edit.cut', label: 'Couper', menuKey: 'Ctrl+X', enabled: editable, run: () => this.clipboardOp('cut') });
    c({ id: 'edit.copy', label: 'Copier', menuKey: 'Ctrl+C', enabled: hasText, run: () => this.clipboardOp('copy') });
    c({ id: 'edit.paste', label: 'Coller', menuKey: 'Ctrl+V', enabled: editable, run: () => this.clipboardOp('paste') });
    c({ id: 'edit.delete', label: 'Supprimer', menuKey: 'Delete', enabled: editable, run: () => {
      const v = ws.view;
      const [a, b] = v.getSelection();
      if (a !== b) v.replaceRange(a, b, '', [a, a], 'delete');
      v.focus();
    } });
    c({ id: 'edit.selectAll', label: 'Tout sélectionner', menuKey: 'Ctrl+A', enabled: hasText, run: () => {
      ws.view.setSelection(0, ws.view.getText().length, false);
      ws.view.focus();
    } });
    c({ id: 'edit.find', label: 'Rechercher…', keys: ['Ctrl+F'], inInput: true, enabled: () => hasText() || ws.active?.kind === 'big', run: () => (ws.active?.kind === 'big' ? ws.bigView.focusSearch() : ws.findbar.open(false)) });
    c({ id: 'edit.replace', label: 'Remplacer…', keys: ['Ctrl+H'], inInput: true, enabled: editable, run: () => ws.findbar.open(true) });
    c({ id: 'edit.findNext', label: 'Rechercher le suivant', keys: ['F3'], inInput: true, enabled: hasText, run: () => ws.findbar.next() });
    c({ id: 'edit.findPrev', label: 'Rechercher le précédent', keys: ['Shift+F3'], inInput: true, enabled: hasText, run: () => ws.findbar.prev() });
    c({ id: 'edit.goto', label: 'Atteindre la ligne…', keys: ['Ctrl+G'], inInput: true, enabled: () => hasText() || ws.active?.kind === 'big', run: () => ws.goToLinePrompt() });
    c({ id: 'edit.duplicate', label: 'Dupliquer la ligne', keys: ['Ctrl+D'], scope: 'editor', enabled: editable, run: () => ws.edit('duplicate') });
    c({ id: 'edit.deleteLine', label: 'Supprimer la ligne', keys: ['Ctrl+Shift+K'], scope: 'editor', enabled: editable, run: () => ws.edit('deleteLine') });
    c({ id: 'edit.moveUp', label: 'Déplacer la ligne vers le haut', keys: ['Alt+Up'], scope: 'editor', enabled: editable, run: () => ws.edit('moveUp') });
    c({ id: 'edit.moveDown', label: 'Déplacer la ligne vers le bas', keys: ['Alt+Down'], scope: 'editor', enabled: editable, run: () => ws.edit('moveDown') });
    c({ id: 'edit.selectLine', label: 'Sélectionner la ligne', keys: ['Ctrl+L'], scope: 'editor', enabled: hasText, run: () => ws.edit('selectLine') });
    c({ id: 'edit.indent', label: 'Augmenter le retrait', menuKey: 'Tab', enabled: editable, run: () => ws.edit('indent') });
    c({ id: 'edit.outdent', label: 'Diminuer le retrait', menuKey: 'Shift+Tab', enabled: editable, run: () => ws.edit('outdent') });
    c({ id: 'edit.dateTime', label: 'Insérer la date et l’heure', keys: ['F5'], scope: 'editor', enabled: editable, run: () => ws.edit('dateTime') });
    c({ id: 'edit.trimTrailing', label: 'Supprimer les espaces en fin de ligne', enabled: editable, run: () => ws.edit('trimTrailing') });
    c({ id: 'edit.tabFocus', label: 'La touche Tab déplace le focus', keys: ['Ctrl+M'], scope: 'editor', checked: () => ws.view.tabMovesFocus, run: () => {
      ws.view.tabMovesFocus = !ws.view.tabMovesFocus;
      this.notify(ws.view.tabMovesFocus ? 'Tab déplace maintenant le focus (Ctrl+M pour rétablir la tabulation).' : 'Tab insère de nouveau une tabulation.');
    } });

    // Affichage
    c({ id: 'view.wrap', label: 'Retour automatique à la ligne', keys: ['Alt+Z'], inInput: true, checked: () => !!s.get('editor.wordWrap'), run: toggle('editor.wordWrap') });
    c({ id: 'view.lineNumbers', label: 'Numéros de ligne', checked: () => !!s.get('editor.lineNumbers'), run: toggle('editor.lineNumbers') });
    c({ id: 'view.invisibles', label: 'Espaces et tabulations', checked: () => !!s.get('editor.showInvisibles'), run: toggle('editor.showInvisibles') });
    c({ id: 'view.trailing', label: 'Espaces en fin de ligne', checked: () => !!s.get('editor.highlightTrailing'), run: toggle('editor.highlightTrailing') });
    c({ id: 'view.statusBar', label: 'Barre d’état', checked: () => !!s.get('ui.statusBar'), run: toggle('ui.statusBar') });
    c({ id: 'view.zoomIn', label: 'Zoom avant', keys: ['Ctrl+Plus', 'Ctrl+Shift+Plus'], inInput: true, run: () => ws.setZoom(s.get<number>('editor.zoom') + 10) });
    c({ id: 'view.zoomOut', label: 'Zoom arrière', keys: ['Ctrl+Minus'], inInput: true, run: () => ws.setZoom(s.get<number>('editor.zoom') - 10) });
    c({ id: 'view.zoomReset', label: 'Rétablir le zoom par défaut', keys: ['Ctrl+0'], inInput: true, run: () => ws.setZoom(100) });
    c({ id: 'view.mdToggle', label: 'Aperçu Markdown', keys: ['Ctrl+Shift+V'], inInput: true, enabled: isMd, checked: () => isMd() && ws.active!.mdView !== 'source', run: () => ws.togglePreview() });
    c({ id: 'view.mdSource', label: 'Source seule', enabled: isMd, checked: () => isMd() && ws.active!.mdView === 'source', run: () => ws.setMdView('source') });
    c({ id: 'view.mdSplit', label: 'Source et aperçu', enabled: isMd, checked: () => isMd() && ws.active!.mdView === 'split', run: () => ws.setMdView('split') });
    c({ id: 'view.mdPreview', label: 'Aperçu seul', enabled: isMd, checked: () => isMd() && ws.active!.mdView === 'preview', run: () => ws.setMdView('preview') });
    c({ id: 'view.mdToc', label: 'Table des matières dans l’aperçu', checked: () => !!s.get('markdown.toc'), run: () => {
      s.set('markdown.toc', !s.get('markdown.toc'));
      if (isMd() && ws.active!.mdView !== 'source') ws.setMdView(ws.active!.mdView);
    } });
    c({ id: 'view.nextRegion', label: 'Zone suivante', keys: ['F6'], inInput: true, palette: false, run: () => this.cycleFocus(1) });
    c({ id: 'view.prevRegion', label: 'Zone précédente', keys: ['Shift+F6'], inInput: true, palette: false, run: () => this.cycleFocus(-1) });
    const themes = { system: 'Thème : suivre Windows', light: 'Thème clair', dark: 'Thème sombre', sepia: 'Thème sépia' } as const;
    for (const [t, label] of Object.entries(themes)) {
      c({ id: `view.theme.${t}`, label, checked: () => s.get('theme') === t, run: () => s.set('theme', t) });
    }
    const widths = { narrow: 'Colonne étroite', medium: 'Colonne moyenne', full: 'Pleine largeur' } as const;
    for (const [w, label] of Object.entries(widths)) {
      c({ id: `view.column.${w}`, label, checked: () => s.get('editor.columnWidth') === w, run: () => s.set('editor.columnWidth', w) });
    }

    // Aller
    c({ id: 'go.nextTab', label: 'Document suivant', keys: ['Ctrl+Tab', 'Ctrl+PageDown'], inInput: true, run: () => ws.nextTab(1) });
    c({ id: 'go.prevTab', label: 'Document précédent', keys: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'], inInput: true, run: () => ws.nextTab(-1) });
    for (let i = 1; i <= 9; i++) c({ id: `go.tab${i}`, label: `Onglet ${i === 9 ? 'dernier' : i}`, keys: [`Ctrl+${i}`], inInput: true, palette: false, run: () => ws.goToTab(i) });
    c({ id: 'go.heading', label: 'Aller au titre…', keys: ['Ctrl+Shift+O'], inInput: true, enabled: isMd, run: () => this.palette.open('#') });
    c({ id: 'go.commands', label: 'Palette de commandes…', keys: ['Ctrl+Shift+P'], inInput: true, run: () => this.palette.open('>') });
    c({ id: 'go.tabs', label: 'Aller à l’onglet', palette: false, run: () => ws.tabbar.focusActive() });

    // Aide
    c({ id: 'help.shortcuts', label: 'Raccourcis clavier', keys: ['F1'], inInput: true, run: () => openShortcuts(this.commands) });
    c({ id: 'help.about', label: 'À propos de SwiftPad', run: () => openAbout(this.boot.version) });
    c({ id: 'help.data', label: 'Données stockées localement…', run: () => this.openPrefs() });

    const conflicts = this.commands.conflicts();
    if (conflicts.length) console.error('Conflits de raccourcis :', conflicts);
  }

  private async clipboardOp(op: 'cut' | 'copy' | 'paste'): Promise<void> {
    const v = this.ws.textView();
    if (!v) return;
    v.focus();
    if (op === 'paste') {
      try {
        const text = await navigator.clipboard.readText();
        if (text) v.insertText(text.replace(/\r\n?/g, '\n'), 'paste');
      } catch {
        this.notify('Accès au presse-papiers refusé : utilisez Ctrl+V.', 'error');
      }
      return;
    }
    const [a, b] = v.getSelection();
    if (a === b) return;
    const text = v.getText().slice(a, b);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      if (!document.execCommand('copy')) {
        this.notify('Accès au presse-papiers refusé : utilisez Ctrl+C.', 'error');
        return;
      }
    }
    if (op === 'cut') v.replaceRange(a, b, '', [a, a], 'cut');
  }

  // --- menus -----------------------------------------------------------------

  private recentMenu(): MenuItem[] {
    const list = (this.settings.get<string[]>('files.recent') ?? []).slice(0, 12);
    if (!list.length) return [act('(aucun fichier récent)', () => {}, { enabled: false })];
    return [
      ...list.map((p, i) => act(`${i < 9 ? `&${i + 1} ` : ''}${basename(p)}`, () => this.ws.openPath(p), { key: p.length > 48 ? '…' + p.slice(-46) : p })),
      sep(),
      act('Effacer la liste', () => this.settings.set('files.recent', [])),
    ];
  }

  private menus() {
    return [
      {
        label: '&Fichier',
        items: (): MenuItem[] => [
          cmd('file.new'),
          cmd('file.open'),
          cmd('file.quickOpen'),
          sub('Fichiers &récents', () => this.recentMenu()),
          cmd('file.reopenClosed'),
          sep(),
          cmd('file.save'),
          cmd('file.saveAs'),
          cmd('file.saveAll'),
          sub('Enregistrer avec l’encodage', () => this.encodingItems(), this.ws.canSave()),
          sep(),
          cmd('file.reload'),
          cmd('file.rename'),
          cmd('file.reveal'),
          cmd('file.copyPath'),
          sep(),
          cmd('file.print'),
          sep(),
          cmd('file.close'),
          cmd('file.closeAll'),
          cmd('file.prefs'),
          sep(),
          cmd('file.quit'),
        ],
      },
      {
        label: '&Édition',
        items: (): MenuItem[] => [
          cmd('edit.undo'),
          cmd('edit.redo'),
          sep(),
          cmd('edit.cut'),
          cmd('edit.copy'),
          cmd('edit.paste'),
          cmd('edit.delete'),
          sep(),
          cmd('edit.find'),
          cmd('edit.findNext'),
          cmd('edit.findPrev'),
          cmd('edit.replace'),
          cmd('edit.goto'),
          sep(),
          cmd('edit.selectAll'),
          cmd('edit.selectLine'),
          sub('&Lignes', () => [cmd('edit.duplicate'), cmd('edit.deleteLine'), cmd('edit.moveUp'), cmd('edit.moveDown'), sep(), cmd('edit.indent'), cmd('edit.outdent'), sep(), cmd('edit.trimTrailing')]),
          cmd('edit.dateTime'),
          sep(),
          cmd('edit.tabFocus'),
        ],
      },
      {
        label: '&Affichage',
        items: (): MenuItem[] => [
          sub('&Thème', () => [cmd('view.theme.system'), cmd('view.theme.light'), cmd('view.theme.dark'), cmd('view.theme.sepia')]),
          sub('&Largeur du texte', () => [cmd('view.column.narrow'), cmd('view.column.medium'), cmd('view.column.full')]),
          sub('&Zoom', () => [cmd('view.zoomIn'), cmd('view.zoomOut'), cmd('view.zoomReset')]),
          sep(),
          cmd('view.wrap'),
          cmd('view.lineNumbers'),
          cmd('view.invisibles'),
          cmd('view.trailing'),
          cmd('view.statusBar'),
          sep(),
          sub('&Markdown', () => [cmd('view.mdToggle'), sep(), cmd('view.mdSource'), cmd('view.mdSplit'), cmd('view.mdPreview'), sep(), cmd('view.mdToc')]),
          sep(),
          cmd('file.prefs'),
        ],
      },
      {
        label: 'A&ller',
        items: (): MenuItem[] => [cmd('go.nextTab'), cmd('go.prevTab'), sep(), cmd('edit.goto'), cmd('go.heading'), cmd('file.quickOpen'), cmd('go.commands')],
      },
      {
        label: 'Ai&de',
        items: (): MenuItem[] => [cmd('help.shortcuts'), cmd('help.data'), sep(), cmd('help.about')],
      },
    ];
  }

  private encodingItems(): MenuItem[] {
    const d = this.ws.active;
    return [
      ['utf-8', 'UTF-8'],
      ['utf-8-bom', 'UTF-8 avec BOM'],
      ['utf-16le', 'UTF-16 LE'],
      ['utf-16be', 'UTF-16 BE'],
      ['windows-1252', 'Windows-1252 (ANSI)'],
    ].map(([id, label]) => act(label, () => this.ws.setSaveEncoding(d, id), { checked: d?.encodingTarget === id }));
  }

  // --- mise en page ------------------------------------------------------------

  private buildLayout(): void {
    document.addEventListener('swiftpad-title', (e) => void native.setWindowTitle((e as CustomEvent).detail as string));
    const topbar = h('header', { class: 'topbar' }, createMenubar(this.menus()));
    const main = h('main', { class: 'main' }, this.ws.root);
    this.root.append(topbar, main, this.ws.status.root);
  }

  private cycleFocus(dir: 1 | -1): void {
    const regions: HTMLElement[] = [];
    const tab = this.root.querySelector<HTMLElement>('.tab.active');
    if (tab) regions.push(tab);
    const d = this.ws.active;
    if (d?.kind === 'text') regions.push(d.isMarkdown && d.mdView === 'preview' ? this.ws.preview.root : this.ws.view.ta);
    else if (d?.kind === 'big') regions.push(this.root.querySelector('.big-scroller') as HTMLElement);
    regions.push(this.root.querySelector('.menubar-item') as HTMLElement);
    const live = regions.filter((r) => r && r.offsetParent !== null);
    if (!live.length) return;
    const i = live.findIndex((r) => r === document.activeElement || r.contains(document.activeElement));
    live[(i + dir + live.length) % live.length].focus();
  }

  refreshCommands(): void {
    // Menus construits à l'ouverture : état des commandes toujours à jour.
  }

  // --- paramètres --------------------------------------------------------------

  private applySettings(key: string): void {
    const s = this.settings;
    const all = key === '*';
    const html = document.documentElement;
    if (all || key === 'theme') {
      const t = s.get<string>('theme');
      if (t === 'light' || t === 'dark' || t === 'sepia') html.dataset.theme = t;
      else delete html.dataset.theme;
      // Au lancement, la fenêtre native est déjà créée avec ce thème. Ensuite,
      // en mode « système », le thème effectif renvoyé par Windows est
      // appliqué explicitement.
      if (!all) {
        void native.setWindowTheme(t ?? 'system').then((eff) => {
          if (eff && s.get<string>('theme') === 'system') html.dataset.theme = eff;
        });
      }
    }
    if (all || key === 'ui.reduceMotion') html.classList.toggle('reduce-motion', !!s.get('ui.reduceMotion'));
    if (all || key === 'ui.statusBar') this.root.classList.toggle('no-status', !s.get('ui.statusBar'));
    // Couleurs libres de la zone d'écriture (sinon celles du thème).
    if (all || key.startsWith('colors.')) {
      for (const [k, v] of [['background', '--paper'], ['text', '--ink'], ['caret', '--caret']] as const) {
        const c = s.get<string | null>(`colors.${k}`);
        if (c) this.root.style.setProperty(v, c);
        else this.root.style.removeProperty(v);
      }
      this.root.classList.toggle('custom-colors', !!(s.get('colors.background') || s.get('colors.text')));
    }
    if (key === 'session.restore' && !s.get('session.restore')) void rpc('session.clear').catch(() => {});
    if (key === 'session.recovery' && !s.get('session.recovery')) {
      void rpc('recovery.purge').catch(() => {});
      for (const d of this.ws.docs) d.recoveryWritten = false;
    }
    if (key.startsWith('editor.') || key.startsWith('ui.') || all) this.refreshCommandsSoon();
    if (key === 'editor.zoom') this.ws.updateStatus();
  }

  private openPrefs(): void {
    openPreferences({
      settings: this.settings,
      dataInfo: this.boot.dataInfo,
      notify: (m, k) => this.notify(m, k),
      clearSession: async () => {
        await rpc('session.clear').catch(() => {});
        this.notify('Session oubliée.');
      },
    });
  }

  private async openDialog(): Promise<void> {
    const paths = await native.pickOpenFiles(this.defaultDir());
    if (paths?.length) await this.ws.openPaths(paths);
  }

  // --- événements globaux ------------------------------------------------------

  private bindGlobal(): void {
    // Sous une boîte de dialogue, un menu ou la palette (qui interceptent les
    // touches), les raccourcis du navigateur restent neutralisés.
    window.addEventListener(
      'keydown',
      (e) => {
        if (!(dialogOpen() || menuIsOpen() || this.palette.isOpen())) return;
        const k = keyOf(e);
        if (k && BROWSER_KEYS.has(k)) e.preventDefault();
      },
      true,
    );
    window.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || dialogOpen() || menuIsOpen() || this.palette.isOpen()) return;
      const ctx = focusContext();
      const command = this.commands.resolve(e, ctx);
      if (command) {
        e.preventDefault();
        e.stopPropagation();
        this.commands.run(command.id);
        return;
      }
      const k = keyOf(e);
      // Raccourcis du navigateur intégré : jamais de rechargement ni de navigation.
      if (k && BROWSER_KEYS.has(k)) e.preventDefault();
    });
    // Menu contextuel du navigateur (« Actualiser », « Enregistrer sous »…) hors zones de saisie.
    window.addEventListener('contextmenu', (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest('textarea, input, .md-preview, .big-scroller')) e.preventDefault();
    });
    // Boutons « précédent/suivant » de la souris : jamais de navigation.
    window.addEventListener('mouseup', (e) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    });
    // Fichiers déposés dans une page du harnais : jamais de navigation.
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    const onFocus = debounce(() => void this.ws.checkExternal(), 150);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') onFocus();
      else void this.saveSession(false);
    });
    window.addEventListener('error', (e) => this.notify(`Erreur interne : ${e.message}`, 'error'));
    window.addEventListener('unhandledrejection', (e) => this.notify(`Erreur interne : ${errorMessage(e.reason)}`, 'error'));
    if (!isTauri()) {
      window.addEventListener('beforeunload', (e) => {
        if (this.ws.docs.some((d) => d.dirty)) e.preventDefault();
      });
    }
    void native.onNativeEvent<string[]>('open-files', (paths) => void this.ws.openPaths(paths));
    void native.onNativeEvent<string>('theme-changed', (eff) => {
      if (this.settings.get<string>('theme') === 'system' && (eff === 'light' || eff === 'dark')) document.documentElement.dataset.theme = eff;
    });
    void native.onNativeEvent<null>('close-requested', () => {
      void native.closeAck();
      void this.quit();
    });
  }

  async quit(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    try {
      await this.ws.flushRecovery();
      const ok = await this.ws.requestQuit();
      if (!ok) return;
      await this.saveSession(true);
      await this.settings.saveNow();
      await native.closeWindowConfirmed();
    } finally {
      this.quitting = false;
    }
  }

  private async saveSession(final: boolean): Promise<void> {
    if (!this.settings.get('session.restore')) return;
    const hotExit = final && !!this.settings.get('session.hotExit') && !!this.settings.get('session.recovery');
    const snap = this.ws.sessionSnapshot(hotExit);
    try {
      await rpc('session.save', { session: snap });
    } catch (e) {
      if (final) console.error(e);
    }
  }

  // --- démarrage ---------------------------------------------------------------

  async start(): Promise<void> {
    const b = this.boot;
    if (b.settingsNotice) this.ws.showAppBar({ id: 'settings', kind: 'warning', text: b.settingsNotice.message, actions: [] });
    const used = this.ws.restoreSession(b.session, b.recovery ?? []);
    const orphans = (b.recovery ?? []).filter((m: any) => !used.has(m.id));
    this.ws.offerRecovered(orphans);
    if (b.launchFiles?.length) await this.ws.openPaths(b.launchFiles);
    if (!this.ws.docs.length) this.ws.newDocument();
    this.refreshCommands();
    // Fichiers transmis entre-temps (seconde instance, glisser-déposer).
    try {
      const pending = await rpc<string[]>('app.pendingOpen');
      if (pending.length) await this.ws.openPaths(pending);
    } catch {
      /* rien */
    }
  }

  /** Accès aux composants pour les tests de bout en bout (harnais uniquement). */
  testHooks(): unknown {
    return { app: this, ws: this.ws, settings: this.settings };
  }
}

export async function showFatal(root: HTMLElement, e: unknown): Promise<void> {
  root.textContent = '';
  root.append(h('div', { class: 'fatal' }, h('h1', { text: 'SwiftPad n’a pas pu démarrer' }), h('pre', { text: errorMessage(e) })));
  await alertMsg('Erreur', errorMessage(e));
}
