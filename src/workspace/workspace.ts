// Espace de travail : documents, onglets, vues, enregistrement sûr,
// conflits, récupération et session.

import { Doc, Eol, MdView, FileMeta, Infobar, ENCODINGS, EOL_LABELS, EOL_LONG, IMAGE_EXTS, basename, dirname, samePath, extOf, isInside, encodingLabel } from './doc';
import { TabBar } from './tabs';
import { StatusBar } from './statusbar';
import { TextView, newTextState, type ViewOptions, type TextState } from '../editor/textview';
import { FindBar } from '../editor/findbar';
import { MarkdownPreview } from '../markdown/preview';
import { extractHeadings } from '../markdown/outline';
import { BigView } from '../viewers/bigview';
import { ImageView, InfoView } from '../viewers/simpleviews';
import { call, rpc, utf8, fromUtf8, errorMessage, errorCode, RpcError } from '../core/rpc';
import * as native from '../core/native';
import { Settings } from '../core/settings';
import { debounce, rafThrottle } from '../core/events';
import { h, clear, humanSize, copyText } from '../ui/dom';
import { icon } from '../ui/icons';
import { ask, alertMsg, promptText, confirmDanger, dialogOpen } from '../ui/dialog';
import { showContextMenu, act, sep, sub, type MenuItem } from '../ui/menu';
import { countCodePoints, offsetOfLine } from '../editor/text';
import * as ops from '../editor/ops';

const MB = 1024 * 1024;

export interface WorkspaceHost {
  settings: Settings;
  sep: string;
  windows: boolean;
  notify(msg: string, kind?: 'info' | 'error'): void;
  refreshCommands(): void;
  recentAdd(path: string): void;
  /** Dossier proposé par « Enregistrer sous » pour un nouveau document. */
  defaultDir(): string | null;
  sessionChanged(): void;
  validateName(name: string): string | null;
  pathsChanged(paths: string[]): void;
}

interface OpenOptions {
  activate?: boolean;
  line?: number;
  col?: number;
  len?: number;
  forceText?: boolean;
  encoding?: string;
  editAnyway?: boolean;
  /** Ouvert en arrière-plan sans remplacer l'onglet vierge. */
  keepUntitled?: boolean;
  /** Onglet après lequel insérer le nouveau (par défaut : l'onglet actif). */
  after?: Doc | null;
}

export class Workspace {
  docs: Doc[] = [];
  active: Doc | null = null;
  private mru: Doc[] = [];
  readonly root: HTMLElement;
  readonly tabbar: TabBar;
  readonly view: TextView;
  readonly findbar: FindBar;
  readonly preview: MarkdownPreview;
  readonly bigView: BigView;
  readonly imageView: ImageView;
  readonly infoView: InfoView;
  readonly status: StatusBar;
  private host: WorkspaceHost;
  private infobarHost: HTMLElement;
  readonly appBars: HTMLElement;
  private views: HTMLElement;
  private editorPane: HTMLElement;
  private previewPane: HTMLElement;
  private empty: HTMLElement;
  private untitledCounter = 0;
  private closed: string[] = [];
  private recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private updateStatusSoon = rafThrottle(() => this.updateStatus());
  /** Nombre de caractères (points de code) mémorisé par version du texte. */
  private chars: { st: TextState | null; version: number; value: number } = { st: null, version: -1, value: 0 };
  private recountChars = debounce(() => {
    this.chars.st = null;
    this.updateStatus();
  }, 300);
  private refreshPreviewSoon = debounce(() => void this.refreshPreview(), 200);
  private refreshFindSoon = debounce(() => this.findbar.refresh(), 300);
  private lastDirty = new Map<string, boolean>();
  private printRoot: HTMLElement;

  constructor(host: WorkspaceHost) {
    this.host = host;
    const s = host.settings;
    this.view = new TextView(this.viewOptions());
    this.findbar = new FindBar(() => (this.active?.kind === 'text' && this.active.loaded ? this.view : null), () => {});
    this.preview = new MarkdownPreview({
      openPath: (p) => void this.openPath(p),
      openExternal: (u) => void this.openExternal(u),
      notify: (m) => host.notify(m),
    });
    this.bigView = new BigView({
      notify: (m) => host.notify(m),
      editAnyway: (d) => void this.editAnyway(d),
      maxEditBytes: () => s.get<number>('files.maxEditMB') * MB,
    });
    this.imageView = new ImageView();
    this.infoView = new InfoView({
      openAsText: (d) => void this.openBinaryAsText(d),
      openWithDefault: (d) => d.path && native.openWithDefaultApp(d.path).catch((e) => host.notify(errorMessage(e), 'error')),
      reveal: (d) => this.reveal(d),
    });
    this.tabbar = new TabBar({
      activate: (d) => this.activate(d),
      close: (d) => void this.close(d),
      reorder: (d, to) => this.reorder(d, to),
      contextMenu: (d, x, y) => this.tabMenu(d, x, y),
      newTab: () => this.newDocument(),
    });
    this.status = new StatusBar({
      encoding: (el) => this.encodingMenu(el),
      eol: (el) => this.eolMenu(el),
      zoom: () => this.setZoom(100),
      position: () => void this.goToLinePrompt(),
    });
    this.infobarHost = h('div', { class: 'infobars' });
    this.appBars = h('div', { class: 'infobars app-bars' });
    this.editorPane = h('div', { class: 'pane pane-editor' }, this.view.root);
    this.previewPane = h('div', { class: 'pane pane-preview' }, this.preview.root);
    this.views = h('div', { class: 'doc-views view-source' }, this.editorPane, this.previewPane, this.bigView.root, this.imageView.root, this.infoView.root);
    this.empty = h(
      'div',
      { class: 'empty-state' },
      h('p', { class: 'empty-title', text: 'Aucun document ouvert' }),
      h('p', { class: 'empty-hint', text: 'Ctrl+N : nouveau document · Ctrl+O : ouvrir · Ctrl+E : documents récents · ou déposez un fichier ici' }),
    );
    this.printRoot = h('div', { id: 'print-root', attrs: { 'aria-hidden': 'true' } });
    document.body.append(this.printRoot);
    this.root = h('div', { class: 'workspace' }, this.tabbar.root, this.appBars, this.infobarHost, this.findbar.root, this.views, this.empty);

    // Document texte en cours de chargement : la zone d'édition est masquée
    // et le focus est sur la page ; la frappe est mise de côté puis rejouée
    // à l'affichage (voir TextView.bufferWhileLoading).
    const loadingTarget = (): boolean => {
      const d = this.active;
      const f = document.activeElement;
      return !!d && d.kind === 'text' && !d.loaded && (f === null || f === document.body) && !dialogOpen();
    };
    document.addEventListener('keydown', (e) => {
      if (!e.defaultPrevented && loadingTarget()) this.view.bufferWhileLoading(e);
    });
    document.addEventListener('paste', (e) => {
      if (!e.defaultPrevented && loadingTarget()) this.view.bufferPaste(e);
    });

    this.view.events.on('change', () => this.onTextChange());
    this.view.events.on('undoRedo', () => this.onTextChange());
    this.view.events.on('selection', () => this.updateStatusSoon());
    this.view.events.on('scroll', () => {
      const d = this.active;
      if (d && d.isMarkdown && d.mdView === 'split') this.preview.syncToLine(this.view.firstVisibleLine());
    });
    this.view.root.addEventListener('editor-zoom', (e) => this.setZoom(s.get<number>('editor.zoom') + (e as CustomEvent).detail * 10));
    this.bigView.root.addEventListener('big-goto', () => void this.goToLinePrompt());
    s.onChange((key) => {
      if (key === '*' || key.startsWith('editor.')) {
        this.view.setOptions(this.viewOptions());
        this.updateStatusSoon();
      }
    });
    this.render();
  }

  viewOptions(): ViewOptions {
    const s = this.host.settings;
    return {
      wrap: !!s.get('editor.wordWrap'),
      lineNumbers: !!s.get('editor.lineNumbers'),
      tabSize: s.get('editor.tabSize') ?? 4,
      insertSpaces: !!s.get('editor.insertSpaces'),
      autoIndent: !!s.get('editor.autoIndent'),
      fontFamily: s.get('editor.fontFamily'),
      fontSize: s.get('editor.fontSize') ?? 14,
      zoom: s.get('editor.zoom') ?? 100,
      showInvisibles: !!s.get('editor.showInvisibles'),
      highlightTrailing: !!s.get('editor.highlightTrailing'),
      lineHeight: s.get('editor.lineHeight') ?? 165,
      columnWidth: s.get('editor.columnWidth') ?? 'medium',
    };
  }

  // --- état général ----------------------------------------------------------

  textView(): TextView | null {
    return this.active?.kind === 'text' && this.active.loaded ? this.view : null;
  }

  canSave(): boolean {
    return this.active?.kind === 'text' && this.active.loaded;
  }

  setZoom(z: number): void {
    const v = Math.max(25, Math.min(500, Math.round(z / 5) * 5));
    this.host.settings.set('editor.zoom', v);
  }

  private onTextChange(): void {
    const d = this.active;
    if (!d) return;
    const dirty = d.dirty;
    if (this.lastDirty.get(d.id) !== dirty) {
      this.lastDirty.set(d.id, dirty);
      this.tabbar.render(this.docs, this.active);
      this.updateTitle();
      this.host.refreshCommands();
    }
    this.updateStatusSoon();
    if (d.isMarkdown && d.mdView !== 'source') this.refreshPreviewSoon();
    if (this.findbar.isOpen()) this.refreshFindSoon();
    this.scheduleRecovery(d);
  }

  private render(): void {
    const d = this.active;
    this.tabbar.render(this.docs, d);
    const ready = !!d && d.loaded;
    this.empty.hidden = ready;
    this.views.hidden = !ready;
    const title = this.empty.querySelector('.empty-title');
    const hint = this.empty.querySelector<HTMLElement>('.empty-hint');
    if (title) title.textContent = d && !d.loaded ? `Chargement de « ${d.name} »…` : 'Aucun document ouvert';
    if (hint) hint.hidden = !!d;
    this.views.dataset.kind = d?.kind ?? '';
    this.editorPane.hidden = !(d && d.kind === 'text');
    this.previewPane.hidden = !(d && d.kind === 'text' && d.isMarkdown && d.mdView !== 'source');
    this.bigView.root.hidden = d?.kind !== 'big';
    this.imageView.root.hidden = d?.kind !== 'image';
    this.infoView.root.hidden = d?.kind !== 'info';
    this.views.classList.remove('view-source', 'view-split', 'view-preview');
    this.views.classList.add(d && d.kind === 'text' && d.isMarkdown ? `view-${d.mdView}` : 'view-source');
    this.renderInfobars();
    this.updateStatus();
    this.updateTitle();
    this.host.refreshCommands();
  }

  private updateTitle(): void {
    const d = this.active;
    const t = d ? `${d.dirty ? '● ' : ''}${d.name} — SwiftPad` : 'SwiftPad';
    if (document.title !== t) {
      document.title = t;
      document.dispatchEvent(new CustomEvent('swiftpad-title', { detail: t }));
    }
  }

  /**
   * Points de code du document. Le comptage parcourt tout le texte (≈ 7 ms
   * par Mo, mesuré) : pendant la frappe dans un grand document, le dernier
   * total reste affiché et le recalcul a lieu après 300 ms de repos.
   */
  private charCount(st: TextState): number {
    const c = this.chars;
    if (c.st === st && c.version === st.version) return c.value;
    if (c.st === st && st.text.length > 256 * 1024) {
      this.recountChars();
      return c.value;
    }
    c.st = st;
    c.version = st.version;
    c.value = countCodePoints(st.text);
    return c.value;
  }

  updateStatus(): void {
    const d = this.active;
    const zoom = `${this.host.settings.get<number>('editor.zoom')} %`;
    if (!d) {
      this.status.set({});
      return;
    }
    if (d.kind === 'text' && d.loaded && d.text) {
      const lc = this.view.caretLineCol();
      const text = d.text.text;
      const chars = d.heavy ? text.length : this.charCount(d.text);
      const meta = d.meta;
      const enc = d.encodingTarget;
      const encChanged = meta && enc !== meta.encoding;
      const eolChanged = meta && d.eolTarget !== meta.eol;
      let state: { label: string; kind: 'saved' | 'dirty' | 'readonly' | 'new' | 'missing' | 'info' };
      if (d.external === 'deleted') state = { label: 'Fichier introuvable', kind: 'missing' };
      else if (d.text.readOnly) state = { label: 'Lecture seule', kind: 'readonly' };
      else if (d.dirty) state = { label: 'Modifié', kind: 'dirty' };
      else if (!d.path) state = { label: 'Nouveau', kind: 'new' };
      else state = { label: 'Enregistré', kind: 'saved' };
      this.status.set({
        position: `Ln ${lc.line.toLocaleString('fr-FR')}, Col ${lc.col.toLocaleString('fr-FR')}${lc.selLen ? ` (${lc.selLen.toLocaleString('fr-FR')} sélectionné${lc.selLen > 1 ? 's' : ''})` : ''}`,
        stats: `${this.view.getLineCount().toLocaleString('fr-FR')} ligne${this.view.getLineCount() > 1 ? 's' : ''}, ${chars.toLocaleString('fr-FR')} caractère${chars > 1 ? 's' : ''}`,
        lang: d.language,
        encoding: {
          label: encodingLabel(enc),
          uncertain: !!meta?.uncertain && !encChanged,
          title: encChanged
            ? `Lu en ${meta!.encodingLabel}, sera enregistré en ${encodingLabel(enc)}`
            : meta?.uncertain
              ? `Encodage incertain (${meta.confidence === 'heuristic' ? 'UTF-16 sans BOM supposé' : 'ni UTF-8 ni UTF-16 : Windows-1252 supposé'}). Cliquer pour rouvrir avec un autre encodage.`
              : 'Encodage (cliquer pour changer)',
        },
        eol: {
          label: `${EOL_LABELS[d.eolTarget]}${meta?.eolMixed && !eolChanged ? ' (mixtes)' : ''}`,
          title: eolChanged ? `Fins de ligne converties en ${EOL_LONG[d.eolTarget]} à l'enregistrement` : `Fins de ligne : ${EOL_LONG[d.eolTarget]}`,
        },
        state,
        zoom,
      });
    } else if (d.kind === 'big' && d.big) {
      this.status.set({ lang: d.language, encoding: { label: d.big.info.encodingLabel ?? '', uncertain: false, title: 'Encodage détecté' }, state: { label: 'Lecture rapide (lecture seule)', kind: 'readonly' } });
    } else if (d.kind === 'image') {
      this.status.set({ lang: 'Image', state: { label: 'Aperçu', kind: 'info' } });
    } else if (d.kind === 'info') {
      this.status.set({ state: { label: 'Fichier non textuel', kind: 'info' } });
    } else {
      this.status.set({ state: { label: 'Chargement…', kind: 'info' } });
    }
  }

  // --- barres d'information ---------------------------------------------------

  private renderInfobars(): void {
    clear(this.infobarHost);
    const d = this.active;
    if (!d) return;
    for (const bar of d.infobars) this.infobarHost.append(this.buildBar(bar, () => {
      d.removeInfobar(bar.id);
      this.renderInfobars();
    }));
  }

  buildBar(bar: Infobar, dismiss: () => void): HTMLElement {
    const el = h('div', { class: `infobar ${bar.kind}`, role: bar.kind === 'error' ? 'alert' : 'status' }, icon(bar.kind === 'info' ? 'info' : 'warning'), h('span', { class: 'infobar-text', text: bar.text }));
    for (const a of bar.actions) {
      const b = h('button', { class: `btn btn-small${a.primary ? ' btn-primary' : ''}`, type: 'button', text: a.label });
      b.addEventListener('click', () => {
        void (async () => {
          await a.run();
        })();
      });
      el.append(b);
    }
    if (bar.dismissible !== false) {
      const x = h('button', { class: 'tb-btn', type: 'button', title: 'Masquer', attrs: { 'aria-label': 'Masquer ce message' } }, icon('close'));
      x.addEventListener('click', dismiss);
      el.append(x);
    }
    return el;
  }

  showAppBar(bar: Infobar): void {
    this.appBars.querySelector(`[data-id="${bar.id}"]`)?.remove();
    const el = this.buildBar(bar, () => el.remove());
    el.dataset.id = bar.id;
    this.appBars.append(el);
  }

  removeAppBar(id: string): void {
    this.appBars.querySelector(`[data-id="${id}"]`)?.remove();
  }

  private setBar(d: Doc, bar: Infobar): void {
    d.addInfobar(bar);
    if (d === this.active) this.renderInfobars();
  }

  private clearBar(d: Doc, id: string): void {
    d.removeInfobar(id);
    if (d === this.active) this.renderInfobars();
  }

  // --- activation -------------------------------------------------------------

  activate(d: Doc): void {
    if (this.active === d) {
      if (d.kind === 'text' && d.loaded) this.view.focus();
      return;
    }
    this.leaveActive();
    this.active = d;
    this.mru = [d, ...this.mru.filter((x) => x !== d)];
    if (!d.loaded && !d.loading) {
      this.render();
      void this.load(d);
      return;
    }
    this.enterActive();
    this.host.sessionChanged();
  }

  private leaveActive(): void {
    const prev = this.active;
    if (!prev) return;
    if (prev.kind === 'text' && prev.loaded) this.view.detach();
    if (prev.kind === 'big') this.bigView.detach();
    if (prev.kind === 'image') this.imageView.detach();
  }

  /**
   * Fin d'un chargement asynchrone : le focus ne va à l'éditeur que s'il
   * n'a pas été placé ailleurs entre-temps (palette, boîte de dialogue,
   * champ de saisie) — la frappe en cours y resterait sinon interrompue.
   */
  private mayTakeFocus(): boolean {
    const f = document.activeElement as HTMLElement | null;
    if (!f || f === document.body || f === this.view.ta) return true;
    if (dialogOpen() || f.closest('[role=dialog], [role=menu], [role=menubar]')) return false;
    return !(f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement || f instanceof HTMLSelectElement || f.isContentEditable);
  }

  private enterActive(afterLoad = false): void {
    const d = this.active;
    this.render();
    if (!d) return;
    if (d.kind === 'text' && d.text) {
      this.view.attach(d.text);
      this.view.setOptions({ ...this.viewOptions() });
      if (d.isMarkdown && d.mdView !== 'source') void this.refreshPreview();
      if (d.pendingGoto) {
        const g = d.pendingGoto;
        d.pendingGoto = null;
        this.goTo(g.line, g.col, g.len);
      }
      if (!afterLoad || this.mayTakeFocus()) this.view.focus();
      if (this.findbar.isOpen()) this.findbar.refresh();
    } else if (d.kind === 'big') {
      this.bigView.attach(d);
      if (d.pendingGoto) {
        this.bigView.scrollToLine(d.pendingGoto.line);
        d.pendingGoto = null;
      }
    } else if (d.kind === 'image') this.imageView.attach(d);
    else if (d.kind === 'info') this.infoView.attach(d);
    this.lastDirty.set(d.id, d.dirty);
    this.updateStatus();
  }

  // --- création et ouverture ---------------------------------------------------

  newDocument(text = ''): Doc {
    this.untitledCounter++;
    const d = new Doc('text', null, `Sans titre ${this.untitledCounter}`, this.untitledCounter);
    d.text = newTextState(text);
    d.loaded = true;
    d.encodingTarget = this.host.settings.get('files.defaultEncoding') ?? 'utf-8';
    d.eolTarget = (this.host.settings.get('files.defaultEol') as Eol) ?? 'crlf';
    if (text) d.text.history.markUnsaved();
    this.insertDoc(d);
    this.activate(d);
    return d;
  }

  private insertDoc(d: Doc, after: Doc | null = null): void {
    const ref = after && this.docs.includes(after) ? after : this.active;
    const i = ref ? this.docs.indexOf(ref) + 1 : this.docs.length;
    this.docs.splice(i, 0, d);
  }

  findOpen(path: string): Doc | undefined {
    return this.docs.find((d) => samePath(d.path, path, this.host.windows));
  }

  /** Ouvre plusieurs fichiers : onglets dans l'ordre donné, le dernier actif. */
  async openPaths(paths: string[]): Promise<void> {
    let after: Doc | null = null;
    for (let i = 0; i < paths.length; i++) {
      const d = await this.openPath(paths[i], { activate: i === paths.length - 1, after });
      if (d) after = d;
    }
  }

  /** Ouvre un fichier (ou active son onglet). */
  async openPath(path: string, o: OpenOptions = {}): Promise<Doc | null> {
    const existing = this.findOpen(path);
    if (existing) {
      if (o.line) existing.pendingGoto = { line: o.line, col: o.col, len: o.len };
      if (o.activate !== false) {
        if (this.active === existing && existing.pendingGoto) {
          const g = existing.pendingGoto;
          existing.pendingGoto = null;
          if (existing.kind === 'big') this.bigView.scrollToLine(g.line);
          else this.goTo(g.line, g.col, g.len);
        } else this.activate(existing);
      }
      return existing;
    }
    // Onglet vierge inutilisé remplacé, comme le Bloc-notes.
    const blank = this.active && !this.active.path && this.active.kind === 'text' && !this.active.dirty && this.active.text?.text === '' && !o.keepUntitled ? this.active : null;
    const d = new Doc('text', path, basename(path));
    if (o.line) d.pendingGoto = { line: o.line, col: o.col, len: o.len };
    this.insertDoc(d, o.after ?? null);
    if (o.activate !== false) {
      this.leaveActive();
      this.active = d;
      this.mru = [d, ...this.mru];
      this.render();
    } else this.tabbar.render(this.docs, this.active);
    const ok = await this.load(d, o);
    if (!ok) {
      this.removeDoc(d);
      return null;
    }
    if (blank && blank !== d) this.removeDoc(blank);
    this.host.recentAdd(path);
    this.host.sessionChanged();
    return d;
  }

  /** Charge le contenu d'un document selon son type et sa taille. */
  private async load(d: Doc, o: OpenOptions = {}): Promise<boolean> {
    // Document sans nom restauré par la fermeture rapide : seule la copie de récupération existe.
    if (!d.path && !d.restore?.recoveryId) return false;
    d.loading = true;
    const s = this.host.settings;
    const fluid = s.get<number>('files.fluidEditMB') * MB;
    const maxEdit = s.get<number>('files.maxEditMB') * MB;
    try {
      // Copie de récupération à restaurer (arrêt inattendu ou fermeture rapide).
      if (d.restore?.recoveryId) {
        const ok = await this.loadFromRecovery(d, d.restore.recoveryId);
        if (ok) return true;
        if (!d.path) throw new RpcError('not_found', `Copie de récupération de « ${d.name} » introuvable.`);
      }
      if (!d.path) return false;
      if (IMAGE_EXTS.has(extOf(d.name)) && !o.forceText) {
        const r = await call('file.readBinary', { path: d.path, maxBytes: 50 * MB });
        d.kind = 'image';
        d.imageInfo = { mime: r.json.mime, size: r.json.size };
        d.imageUrl = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: r.json.mime }));
        d.loaded = true;
        return true;
      }
      try {
        await this.loadText(d, { maxBytes: o.editAnyway ? maxEdit : fluid, allowBinary: o.forceText, encoding: o.encoding });
        d.heavy = (d.meta?.size ?? 0) > fluid;
        if (d.text) d.text.heavy = d.heavy;
        return true;
      } catch (e) {
        let err = e;
        if (errorCode(err) === 'too_large') {
          // Lecteur rapide, sauf contenu binaire (refusé par le noyau sans
          // confirmation, comme pour un petit fichier).
          try {
            await this.openBig(d, d.binaryOk);
            return true;
          } catch (e2) {
            err = e2;
          }
        }
        if (errorCode(err) === 'binary') {
          const det = (err as RpcError).detail ?? {};
          let mtimeMs = 0;
          try {
            mtimeMs = (await rpc('file.info', { path: d.path })).mtimeMs;
          } catch {
            /* facultatif */
          }
          d.kind = 'info';
          d.info = { reason: det.reason, size: det.size, mtimeMs };
          d.loaded = true;
          return true;
        }
        throw err;
      }
    } catch (e) {
      d.loading = false;
      const code = errorCode(e);
      const msg = errorMessage(e);
      if (code === 'not_found') this.host.notify(msg, 'error');
      else await alertMsg('Ouverture impossible', msg);
      return false;
    } finally {
      d.loading = false;
      if (d.loaded && this.active === d) this.enterActive(true);
      else this.tabbar.render(this.docs, this.active);
    }
  }

  private async loadText(d: Doc, o: { maxBytes: number; allowBinary?: boolean; encoding?: string }): Promise<void> {
    const s = this.host.settings;
    const r = await call('doc.open', {
      path: d.path,
      maxBytes: o.maxBytes,
      allowBinary: !!o.allowBinary,
      encoding: o.encoding,
      defaultEol: s.get('files.defaultEol') ?? 'crlf',
    });
    const head = r.json;
    // La zone de texte travaille toujours en « \n » ; le type d'origine est conservé à part.
    const raw = fromUtf8(r.bytes!);
    const text = raw.includes('\r') ? raw.replace(/\r\n?/g, '\n') : raw;
    const meta: FileMeta = {
      encoding: head.encoding,
      encodingLabel: head.encodingLabel,
      confidence: head.confidence,
      uncertain: head.uncertain,
      replaced: head.replaced,
      eol: head.eol,
      eolMixed: head.eolMixed,
      eolStats: head.eolStats,
      stamp: head.stamp,
      mtimeMs: head.mtimeMs,
      size: head.size,
      readonly: head.readonly,
      linkTarget: head.linkTarget,
      binaryReason: head.binaryReason,
    };
    d.kind = 'text';
    d.meta = meta;
    d.path = head.path;
    d.name = head.name;
    d.encodingTarget = meta.encoding;
    d.eolTarget = meta.eol;
    d.metaDirty = false;
    d.external = null;
    d.lossyAcknowledged = false;
    d.editLocked = !!meta.binaryReason;
    const readOnly = meta.readonly || d.editLocked;
    const prev = d.text;
    d.text = newTextState(text, readOnly, d.heavy);
    if (prev && d.restore?.sel === undefined) {
      d.text.sel = [Math.min(prev.sel[0], text.length), Math.min(prev.sel[1], text.length)];
      d.text.scrollTop = prev.scrollTop;
    }
    if (d.restore) {
      if (d.restore.sel) d.text.sel = [Math.min(d.restore.sel[0], text.length), Math.min(d.restore.sel[1], text.length)];
      if (d.restore.scroll) [d.text.scrollTop, d.text.scrollLeft] = d.restore.scroll;
      d.restore = null;
    }
    if (d.isMarkdown && d.mdView === 'source') d.mdView = (s.get('markdown.defaultView') as MdView) ?? 'source';
    d.loaded = true;
    d.infobars = [];
    this.addLoadBars(d);
  }

  private addLoadBars(d: Doc): void {
    const m = d.meta!;
    if (m.binaryReason) {
      this.setBar(d, {
        id: 'binary',
        kind: 'warning',
        text: `Contenu non textuel (${m.binaryReason}) affiché comme texte, en lecture seule pour éviter de l'endommager.`,
        actions: [{ label: 'Autoriser la modification', run: () => this.unlockEdit(d) }],
      });
    }
    if (m.replaced > 0) {
      this.setBar(d, {
        id: 'lossy',
        kind: 'warning',
        text: `${m.replaced.toLocaleString('fr-FR')} séquence(s) d'octets invalide(s) en ${m.encodingLabel} remplacée(s) par « � ». L'enregistrement écrirait ce caractère à la place des octets d'origine.`,
        actions: [
          { label: 'Rouvrir en Windows-1252', run: () => this.reopenWithEncoding(d, 'windows-1252') },
          { label: 'Choisir l’encodage…', run: () => this.encodingMenu(this.status.root.querySelector('.sb-enc') as HTMLElement) },
        ],
      });
    } else if (m.uncertain) {
      this.setBar(d, {
        id: 'uncertain',
        kind: 'info',
        text: `Encodage détecté avec incertitude : ${m.encodingLabel}. Vérifiez les caractères accentués.`,
        actions: [
          { label: 'Rouvrir en UTF-8', run: () => this.reopenWithEncoding(d, 'utf-8') },
          { label: 'Autre encodage…', run: () => this.encodingMenu(this.status.root.querySelector('.sb-enc') as HTMLElement) },
        ],
      });
    }
    if (m.eolMixed && m.eolStats) {
      const st = m.eolStats;
      const parts = [st.crlf && `${st.crlf} CRLF`, st.lf && `${st.lf} LF`, st.cr && `${st.cr} CR`].filter(Boolean).join(', ');
      this.setBar(d, {
        id: 'eol',
        kind: 'info',
        text: `Fins de ligne mixtes (${parts}). Elles seront toutes enregistrées en ${EOL_LABELS[m.eol]}.`,
        actions: [{ label: 'Choisir…', run: () => this.eolMenu(this.status.root.querySelector('.sb-eol') as HTMLElement) }],
      });
    }
    if (m.readonly && !m.binaryReason) {
      this.setBar(d, {
        id: 'readonly',
        kind: 'info',
        text: 'Ce fichier est en lecture seule (attribut du système). Les modifications devront être enregistrées sous un autre nom.',
        actions: [{ label: 'Modifier une copie', run: () => this.unlockEdit(d) }],
      });
    }
    if (m.linkTarget) {
      this.setBar(d, { id: 'link', kind: 'info', text: `Ce fichier est un lien vers « ${m.linkTarget} ». L'enregistrement modifiera la cible.`, actions: [] });
    }
  }

  private unlockEdit(d: Doc): void {
    if (!d.text) return;
    d.editLocked = false;
    d.text.readOnly = false;
    if (d === this.active) this.view.setReadOnly(false);
    this.clearBar(d, 'binary');
    this.clearBar(d, 'readonly');
    this.updateStatus();
    this.host.refreshCommands();
  }

  private async openBig(d: Doc, allowBinary = false): Promise<void> {
    const r = await rpc('big.open', { path: d.path, allowBinary });
    d.kind = 'big';
    d.big = { id: r.info.id, info: r.info, jobId: r.jobId };
    d.loaded = true;
  }

  private async editAnyway(d: Doc): Promise<void> {
    const size = d.big?.info?.size ?? 0;
    const ok = await confirmDanger(
      'Modifier un gros fichier',
      `Charger « ${d.name} » (${humanSize(size)}) dans l'éditeur ?`,
      'Charger dans l’éditeur',
      `Au-delà de ${this.host.settings.get('files.fluidEditMB')} Mo, la zone d'édition native devient lente : l'ouverture peut prendre plusieurs secondes et la frappe sera moins fluide (mesures dans la documentation).`,
    );
    if (!ok) return;
    const big = d.big;
    if (big) {
      void rpc('big.close', { id: big.id }).catch(() => {});
      if (big.jobId) void rpc('job.cancel', { id: big.jobId }).catch(() => {});
    }
    this.bigView.detach();
    d.big = null;
    d.loaded = false;
    d.kind = 'text';
    d.heavy = true;
    this.render();
    try {
      await this.loadText(d, { maxBytes: this.host.settings.get<number>('files.maxEditMB') * MB, allowBinary: d.binaryOk });
      if (d.text) d.text.heavy = true;
      this.setBar(d, { id: 'heavy', kind: 'info', text: 'Gros document : retour à la ligne, calque des caractères invisibles et numérotation en retour à la ligne désactivés pour rester réactif.', actions: [] });
    } catch (e) {
      await alertMsg('Ouverture impossible', errorMessage(e));
      await this.openBig(d, d.binaryOk).catch((e2) => this.host.notify(errorMessage(e2), 'error'));
    }
    if (this.active === d) this.enterActive();
  }

  private async openBinaryAsText(d: Doc): Promise<void> {
    const ok = await confirmDanger(
      'Ouvrir comme texte',
      `« ${d.name} » ne semble pas être un fichier texte. L'afficher quand même ?`,
      'Afficher comme texte',
      'Le contenu sera affiché en lecture seule. Le modifier puis l’enregistrer pourrait endommager le fichier.',
    );
    if (!ok || !d.path) return;
    d.binaryOk = true;
    // Au-delà du seuil d'édition directe : lecteur rapide (lecture seule,
    // jamais chargé entièrement en mémoire), quelle que soit la taille.
    if ((d.info?.size ?? 0) > this.host.settings.get<number>('files.fluidEditMB') * MB) {
      try {
        await this.openBig(d, true);
      } catch (e) {
        await alertMsg('Ouverture impossible', errorMessage(e));
        return;
      }
      d.info = null;
      if (this.active === d) this.enterActive();
      return;
    }
    d.loaded = false;
    try {
      await this.loadText(d, { maxBytes: this.host.settings.get<number>('files.maxEditMB') * MB, allowBinary: true });
    } catch (e) {
      d.loaded = true;
      await alertMsg('Ouverture impossible', errorMessage(e));
      return;
    }
    if (this.active === d) this.enterActive();
  }

  private async loadFromRecovery(d: Doc, id: string): Promise<boolean> {
    try {
      const r = await call('recovery.read', { id });
      const text = fromUtf8(r.bytes!);
      const meta = d.restore as any;
      d.kind = 'text';
      d.text = newTextState(text);
      d.text.history.markUnsaved();
      d.loaded = true;
      d.recoveryWritten = true;
      if (meta?.recoveryMeta) {
        const m = meta.recoveryMeta;
        d.encodingTarget = m.encoding ?? 'utf-8';
        d.eolTarget = m.eol ?? 'crlf';
        if (d.path) {
          d.meta = {
            encoding: m.encoding ?? 'utf-8', encodingLabel: encodingLabel(m.encoding ?? 'utf-8'), confidence: 'forced', uncertain: false, replaced: 0,
            eol: m.eol ?? 'crlf', eolMixed: false, eolStats: null, stamp: m.stamp ?? null, mtimeMs: 0, size: 0, readonly: false, linkTarget: null, binaryReason: null,
          };
        }
      }
      d.restore = null;
      this.setBar(d, { id: 'recovered', kind: 'info', text: 'Contenu restauré depuis une copie de récupération locale (modifications non enregistrées).', actions: [] });
      if (id !== d.id) {
        // Copie d'un autre onglet : remplacée par une copie au nom de celui-ci.
        await rpc('recovery.delete', { id }).catch(() => {});
        d.recoveryWritten = false;
        void this.writeRecovery(d);
      }
      return true;
    } catch {
      d.restore = { ...(d.restore ?? {}), recoveryId: undefined };
      return false;
    }
  }

  // --- fermeture ------------------------------------------------------------

  private removeDoc(d: Doc): void {
    const i = this.docs.indexOf(d);
    if (i < 0) return;
    if (this.active === d) this.leaveActive();
    this.docs.splice(i, 1);
    this.mru = this.mru.filter((x) => x !== d);
    this.lastDirty.delete(d.id);
    const t = this.recoveryTimers.get(d.id);
    if (t) clearTimeout(t);
    this.recoveryTimers.delete(d.id);
    if (d.big) {
      void rpc('big.close', { id: d.big.id }).catch(() => {});
      if (d.big.jobId) void rpc('job.cancel', { id: d.big.jobId }).catch(() => {});
    }
    if (d.imageUrl) URL.revokeObjectURL(d.imageUrl);
    d.text = null;
    if (this.active === d) {
      this.active = null;
      const next = this.mru[0] ?? this.docs[Math.min(i, this.docs.length - 1)] ?? null;
      if (next) {
        this.active = null;
        this.activate(next);
      } else this.render();
    } else this.render();
    this.host.sessionChanged();
  }

  /** Ferme un document ; demande quoi faire des modifications. Faux = annulé. */
  async close(d: Doc): Promise<boolean> {
    if (d.dirty) {
      if (this.active !== d) this.activate(d);
      const r = await ask({
        title: 'SwiftPad',
        message: `Voulez-vous enregistrer les modifications apportées à « ${d.name} » ?`,
        buttons: [
          { id: 'save', label: 'Enregistrer', kind: 'primary' },
          { id: 'discard', label: 'Ne pas enregistrer' },
          { id: 'cancel', label: 'Annuler' },
        ],
        cancelId: 'cancel',
        defaultId: 'save',
      });
      if (r === 'cancel') return false;
      if (r === 'save' && !(await this.save(d))) return false;
    }
    if (d.recoveryWritten) await rpc('recovery.delete', { id: d.id }).catch(() => {});
    if (d.path) {
      this.closed = [d.path, ...this.closed.filter((p) => p !== d.path)].slice(0, 20);
    }
    this.removeDoc(d);
    return true;
  }

  async closeMany(list: Doc[]): Promise<boolean> {
    for (const d of [...list]) if (!(await this.close(d))) return false;
    return true;
  }

  async reopenClosed(): Promise<void> {
    const p = this.closed.shift();
    if (p) await this.openPath(p);
  }

  hasClosed(): boolean {
    return this.closed.length > 0;
  }

  private reorder(d: Doc, to: number): void {
    const from = this.docs.indexOf(d);
    if (from < 0) return;
    this.docs.splice(from, 1);
    this.docs.splice(Math.max(0, Math.min(to, this.docs.length)), 0, d);
    this.tabbar.render(this.docs, this.active);
    this.host.sessionChanged();
  }

  nextTab(dir: 1 | -1): void {
    if (this.docs.length < 2 || !this.active) return;
    const i = this.docs.indexOf(this.active);
    this.activate(this.docs[(i + dir + this.docs.length) % this.docs.length]);
  }

  goToTab(n: number): void {
    const d = n === 9 ? this.docs[this.docs.length - 1] : this.docs[n - 1];
    if (d) this.activate(d);
  }

  // --- enregistrement ----------------------------------------------------------

  /** Enregistre ; renvoie vrai si le document est enregistré au retour. */
  async save(d: Doc | null = this.active, saveAs = false): Promise<boolean> {
    if (!d || d.kind !== 'text' || !d.text) return false;
    let path = d.path;
    let isNew = false;
    if (!path || saveAs || d.meta?.readonly) {
      const dir = d.dir(this.host.sep) ?? this.host.defaultDir();
      const name = d.path ? d.name : `${d.name}.txt`;
      path = await native.pickSaveFile(dir, name);
      if (!path) return false;
      isNew = !samePath(path, d.path, this.host.windows);
    }
    if (d.meta && d.meta.replaced > 0 && !d.lossyAcknowledged && d.encodingTarget === d.meta.encoding) {
      const r = await ask({
        title: 'Caractères non décodés',
        message: `« ${d.name} » contenait ${d.meta.replaced} séquence(s) d'octets illisible(s) en ${d.meta.encodingLabel}, affichée(s) comme « � ».`,
        detail: 'En enregistrant, ces octets d’origine seront définitivement remplacés par le caractère « � ». Rouvrir avec un autre encodage permet de les conserver.',
        buttons: [
          { id: 'save', label: 'Enregistrer quand même', kind: 'danger' },
          { id: 'cancel', label: 'Annuler' },
        ],
        cancelId: 'cancel',
        defaultId: 'cancel',
      });
      if (r !== 'save') return false;
      d.lossyAcknowledged = true;
    }
    return this.writeDoc(d, path, isNew, false);
  }

  private async writeDoc(d: Doc, path: string, isNew: boolean, force: boolean): Promise<boolean> {
    const text = d.text!.text;
    const args: Record<string, unknown> = {
      path,
      encoding: d.encodingTarget,
      eol: d.eolTarget,
      force,
    };
    if (!isNew && d.meta?.stamp) args.expected = d.meta.stamp;
    if (!isNew && !d.meta?.stamp && d.path) args.expected = 'inconnu';
    let res: any;
    try {
      res = await rpc('doc.save', args, utf8(text));
    } catch (e) {
      return this.handleSaveError(d, path, isNew, e);
    }
    const oldPath = d.path;
    d.path = res.path;
    d.name = basename(res.path);
    d.meta = {
      ...(d.meta ?? { confidence: 'forced', uncertain: false, replaced: 0, eolMixed: false, eolStats: null, readonly: false, linkTarget: null, binaryReason: null, encodingLabel: '', encoding: '', eol: d.eolTarget, stamp: null, mtimeMs: 0, size: 0 }),
      encoding: d.encodingTarget,
      encodingLabel: encodingLabel(d.encodingTarget),
      eol: d.eolTarget,
      eolMixed: false,
      uncertain: false,
      confidence: 'forced',
      replaced: 0,
      stamp: res.stamp,
      mtimeMs: res.mtimeMs,
      size: res.size,
      readonly: false,
    };
    d.text!.history.markSaved();
    d.metaDirty = false;
    d.external = null;
    d.ignoredStamp = null;
    for (const id of ['lossy', 'uncertain', 'eol', 'external', 'deleted', 'readonly', 'recovered']) d.removeInfobar(id);
    if (d.recoveryWritten) {
      d.recoveryWritten = false;
      void rpc('recovery.delete', { id: d.id }).catch(() => {});
    }
    this.lastDirty.set(d.id, false);
    this.host.recentAdd(res.path);
    this.host.pathsChanged([res.path, ...(oldPath && !samePath(oldPath, res.path, this.host.windows) ? [oldPath] : [])]);
    if (!res.atomic) this.host.notify('Enregistré directement dans le fichier (dossier non modifiable : écriture atomique impossible).');
    else this.host.notify(`Enregistré : ${d.name}`);
    if (d === this.active) this.render();
    else this.tabbar.render(this.docs, this.active);
    this.host.sessionChanged();
    return true;
  }

  private async handleSaveError(d: Doc, path: string, isNew: boolean, e: unknown): Promise<boolean> {
    const code = errorCode(e);
    const msg = errorMessage(e);
    if (code === 'conflict') {
      const r = await ask({
        title: 'Conflit d’enregistrement',
        message: msg,
        detail: 'Écraser remplacera la version modifiée par l’autre programme par la vôtre.',
        buttons: [
          { id: 'saveas', label: 'Enregistrer sous…', kind: 'primary' },
          { id: 'overwrite', label: 'Écraser', kind: 'danger' },
          { id: 'reload', label: 'Recharger (perdre mes modifications)' },
          { id: 'cancel', label: 'Annuler' },
        ],
        cancelId: 'cancel',
        defaultId: 'saveas',
      });
      if (r === 'overwrite') return this.writeDoc(d, path, isNew, true);
      if (r === 'saveas') return this.save(d, true);
      if (r === 'reload') await this.reload(d, true);
      return false;
    }
    if (code === 'deleted') {
      const r = await ask({
        title: 'Fichier introuvable',
        message: msg,
        buttons: [
          { id: 'recreate', label: 'Recréer le fichier', kind: 'primary' },
          { id: 'saveas', label: 'Enregistrer sous…' },
          { id: 'cancel', label: 'Annuler' },
        ],
        cancelId: 'cancel',
      });
      if (r === 'recreate') return this.writeDoc(d, path, isNew, true);
      if (r === 'saveas') return this.save(d, true);
      return false;
    }
    if (code === 'unencodable') {
      const r = await ask({
        title: 'Encodage incompatible',
        message: msg,
        detail: 'Aucun caractère n’a été remplacé : le fichier n’a pas été modifié.',
        buttons: [
          { id: 'utf8', label: 'Enregistrer en UTF-8', kind: 'primary' },
          { id: 'cancel', label: 'Annuler' },
        ],
        cancelId: 'cancel',
      });
      if (r === 'utf8') {
        d.encodingTarget = 'utf-8';
        d.metaDirty = true;
        return this.writeDoc(d, path, isNew, false);
      }
      return false;
    }
    const r = await ask({
      title: 'Enregistrement impossible',
      message: msg,
      detail: 'Le fichier d’origine n’a pas été modifié.',
      buttons: [
        { id: 'saveas', label: 'Enregistrer sous…', kind: 'primary' },
        { id: 'cancel', label: 'Annuler' },
      ],
      cancelId: 'cancel',
    });
    if (r === 'saveas') return this.save(d, true);
    return false;
  }

  async saveAll(): Promise<void> {
    for (const d of this.docs.filter((x) => x.dirty)) {
      if (!(await this.save(d))) break;
    }
  }

  // --- rechargement, encodage, fins de ligne ---------------------------------

  async reload(d: Doc | null = this.active, force = false): Promise<void> {
    if (!d || !d.path || d.kind !== 'text') return;
    if (d.dirty && !force) {
      const ok = await confirmDanger('Recharger', `Recharger « ${d.name} » depuis le disque ?`, 'Recharger', 'Vos modifications non enregistrées seront perdues.');
      if (!ok) return;
    }
    await this.reloadWith(d, undefined);
  }

  private async reloadWith(d: Doc, encoding: string | undefined): Promise<void> {
    const wasActive = this.active === d;
    if (wasActive) this.view.detach();
    try {
      await this.loadText(d, { maxBytes: this.host.settings.get<number>(d.heavy ? 'files.maxEditMB' : 'files.fluidEditMB') * MB, encoding, allowBinary: !!d.meta?.binaryReason });
    } catch (e) {
      await alertMsg('Rechargement impossible', errorMessage(e));
    }
    if (d.recoveryWritten) {
      d.recoveryWritten = false;
      void rpc('recovery.delete', { id: d.id }).catch(() => {});
    }
    this.lastDirty.set(d.id, false);
    if (wasActive) this.enterActive();
    else this.tabbar.render(this.docs, this.active);
  }

  async reopenWithEncoding(d: Doc | null, encoding: string): Promise<void> {
    if (!d || !d.path || d.kind !== 'text') return;
    if (d.dirty) {
      const ok = await confirmDanger('Rouvrir avec un autre encodage', `Rouvrir « ${d.name} » en ${encodingLabel(encoding)} ?`, 'Rouvrir', 'Vos modifications non enregistrées seront perdues.');
      if (!ok) return;
    }
    await this.reloadWith(d, encoding);
  }

  setSaveEncoding(d: Doc | null, encoding: string): void {
    if (!d || d.kind !== 'text') return;
    d.encodingTarget = encoding;
    d.metaDirty = !!d.meta && (d.meta.encoding !== encoding || d.meta.eol !== d.eolTarget);
    if (!d.meta) d.metaDirty = false;
    this.lastDirty.delete(d.id);
    this.onTextChange();
    this.updateStatus();
  }

  setEol(d: Doc | null, eol: Eol): void {
    if (!d || d.kind !== 'text') return;
    d.eolTarget = eol;
    d.metaDirty = !!d.meta && (d.meta.eol !== eol || d.meta.encoding !== d.encodingTarget || (d.meta.eolMixed && d.meta.eol !== eol));
    if (d.meta?.eolMixed) this.clearBar(d, 'eol');
    this.lastDirty.delete(d.id);
    this.onTextChange();
    this.updateStatus();
  }

  encodingMenu(anchor: HTMLElement | null): void {
    const d = this.active;
    if (!d || d.kind !== 'text') return;
    const r = (anchor ?? this.status.root).getBoundingClientRect();
    const items: MenuItem[] = [
      sub('Rouvrir avec l’encodage', () => ENCODINGS.filter((e) => e.id !== 'utf-8-bom').map((e) => act(e.label, () => this.reopenWithEncoding(d, e.id), { enabled: !!d.path }))),
      sub('Enregistrer avec l’encodage', () => ENCODINGS.map((e) => act(e.label, () => this.setSaveEncoding(d, e.id), { checked: d.encodingTarget === e.id }))),
    ];
    showContextMenu(items, r.left, r.top - 8 - 60);
  }

  eolMenu(anchor: HTMLElement | null): void {
    const d = this.active;
    if (!d || d.kind !== 'text') return;
    const r = (anchor ?? this.status.root).getBoundingClientRect();
    const items: MenuItem[] = (['crlf', 'lf', 'cr'] as Eol[]).map((e) => act(EOL_LONG[e], () => this.setEol(d, e), { checked: d.eolTarget === e }));
    showContextMenu(items, r.left, r.top - 90);
  }

  // --- modifications externes -----------------------------------------------

  /** Vérifie les fichiers ouverts (retour du focus) : modifiés, supprimés, déplacés. */
  async checkExternal(): Promise<void> {
    const list = this.docs.filter((d) => d.path && d.loaded && d.kind === 'text' && d.meta);
    if (!list.length) return;
    let stats: any[];
    try {
      stats = await rpc('doc.stat', { paths: list.map((d) => d.path) });
    } catch {
      return;
    }
    list.forEach((d, i) => {
      const st = stats[i];
      if (!st) return;
      if (!st.exists) {
        if (d.external !== 'deleted') {
          d.external = 'deleted';
          this.setBar(d, {
            id: 'deleted',
            kind: 'warning',
            text: `« ${d.name} » a été supprimé ou déplacé par un autre programme. Son contenu n’existe plus que dans SwiftPad.`,
            actions: [
              { label: 'Enregistrer sous…', primary: true, run: () => this.save(d, true) },
              { label: 'Recréer (Enregistrer)', run: () => this.writeDoc(d, d.path!, false, true) },
            ],
          });
          this.tabbar.render(this.docs, this.active);
          if (d === this.active) this.updateStatus();
        }
        return;
      }
      if (d.external === 'deleted') {
        d.external = null;
        this.clearBar(d, 'deleted');
        this.tabbar.render(this.docs, this.active);
      }
      if (d.meta && st.readonly !== d.meta.readonly) d.meta.readonly = st.readonly;
      if (st.stamp !== d.meta!.stamp && st.stamp !== d.ignoredStamp) {
        d.external = 'changed';
        const dirty = d.dirty;
        this.setBar(d, {
          id: 'external',
          kind: 'warning',
          text: dirty
            ? `« ${d.name} » a été modifié par un autre programme, et vous avez des modifications non enregistrées.`
            : `« ${d.name} » a été modifié par un autre programme.`,
          actions: [
            { label: dirty ? 'Recharger (perdre mes modifications)' : 'Recharger', primary: !dirty, run: () => this.reload(d, true) },
            {
              label: 'Conserver ma version',
              run: () => {
                d.ignoredStamp = st.stamp;
                d.external = null;
                this.clearBar(d, 'external');
              },
            },
          ],
        });
      }
    });
  }

  /** Fichier renommé (Fichier → Renommer) : chemins des documents mis à jour. */
  onPathMoved(from: string, to: string): void {
    let changed = false;
    for (const d of this.docs) {
      if (!d.path) continue;
      if (samePath(d.path, from, this.host.windows) || isInside(d.path, from, this.host.windows)) {
        d.path = to + d.path.slice(from.length);
        d.name = basename(d.path);
        changed = true;
      }
    }
    if (changed) {
      this.render();
      this.host.sessionChanged();
    }
  }

  // --- récupération -------------------------------------------------------------

  private scheduleRecovery(d: Doc): void {
    const s = this.host.settings;
    if (!s.get('session.recovery') || d.kind !== 'text') return;
    const t = this.recoveryTimers.get(d.id);
    if (t) clearTimeout(t);
    this.recoveryTimers.set(
      d.id,
      setTimeout(() => {
        this.recoveryTimers.delete(d.id);
        void this.writeRecovery(d);
      }, 2000),
    );
  }

  private noticeShown = false;

  async writeRecovery(d: Doc): Promise<void> {
    const s = this.host.settings;
    if (!s.get('session.recovery') || !d.text || !this.docs.includes(d)) return;
    if (!d.dirty) {
      if (d.recoveryWritten) {
        d.recoveryWritten = false;
        await rpc('recovery.delete', { id: d.id }).catch(() => {});
      }
      return;
    }
    if (d.text.text.length > 32 * MB) return;
    try {
      await rpc('recovery.write', { id: d.id, meta: { path: d.path, name: d.name, encoding: d.encodingTarget, eol: d.eolTarget, stamp: d.meta?.stamp ?? null } }, utf8(d.text.text));
      d.recoveryWritten = true;
    } catch (e) {
      this.host.notify(`Copie de récupération impossible : ${errorMessage(e)}`, 'error');
      return;
    }
    if (!s.get('session.recoveryNoticeSeen') && !this.noticeShown) {
      this.noticeShown = true;
      this.showAppBar({
        id: 'recovery-notice',
        kind: 'info',
        text: 'Les modifications non enregistrées sont copiées localement (dossier de données de SwiftPad, jamais ailleurs) pour pouvoir les récupérer après un arrêt inattendu.',
        actions: [
          {
            label: 'Désactiver',
            run: async () => {
              s.set('session.recovery', false);
              s.set('session.recoveryNoticeSeen', true);
              await rpc('recovery.purge').catch(() => {});
              for (const x of this.docs) x.recoveryWritten = false;
              this.removeAppBar('recovery-notice');
            },
          },
          {
            label: 'OK',
            primary: true,
            run: () => {
              s.set('session.recoveryNoticeSeen', true);
              this.removeAppBar('recovery-notice');
            },
          },
        ],
        dismissible: false,
      });
    }
  }

  async flushRecovery(): Promise<void> {
    for (const [id, t] of this.recoveryTimers) {
      clearTimeout(t);
      this.recoveryTimers.delete(id);
      const d = this.docs.find((x) => x.id === id);
      if (d) await this.writeRecovery(d);
    }
  }

  /** Copies orphelines (arrêt inattendu) : propose de les restaurer. */
  offerRecovered(list: any[]): void {
    if (!list.length) return;
    this.showAppBar({
      id: 'recovered',
      kind: 'warning',
      text: `${list.length} document(s) non enregistré(s) ont été retrouvés après un arrêt inattendu de SwiftPad.`,
      actions: [
        {
          label: 'Restaurer',
          primary: true,
          run: async () => {
            this.removeAppBar('recovered');
            for (const m of list) await this.restoreRecovered(m);
          },
        },
        {
          label: 'Supprimer les copies',
          run: async () => {
            const ok = await confirmDanger('Supprimer les copies de récupération', `Supprimer définitivement ${list.length} copie(s) de récupération ?`, 'Supprimer');
            if (!ok) return;
            for (const m of list) await rpc('recovery.delete', { id: m.id }).catch(() => {});
            this.removeAppBar('recovered');
          },
        },
      ],
    });
  }

  private async restoreRecovered(m: any): Promise<void> {
    const existing = m.path ? this.findOpen(m.path) : undefined;
    if (existing) {
      // Onglet déjà rouvert depuis le disque par la session : on y place le
      // contenu récupéré, sauf s'il a déjà été modifié entre-temps.
      if (existing.dirty) {
        this.host.notify(`« ${existing.name} » a déjà des modifications : copie de récupération conservée.`);
        return;
      }
      if (!existing.loaded) {
        existing.restore = { ...(existing.restore ?? {}), recoveryId: m.id, ...({ recoveryMeta: m } as any) };
        this.activate(existing);
        return;
      }
      const wasActive = this.active === existing;
      if (wasActive) this.view.detach();
      existing.restore = { recoveryId: m.id, ...({ recoveryMeta: m } as any) };
      await this.loadFromRecovery(existing, m.id);
      if (wasActive) this.enterActive();
      else this.activate(existing);
      return;
    }
    this.untitledCounter++;
    const d = new Doc('text', m.path ?? null, m.path ? basename(m.path) : (m.name ?? `Récupéré ${this.untitledCounter}`), m.path ? 0 : this.untitledCounter, m.id);
    d.restore = { recoveryId: m.id, ...({ recoveryMeta: m } as any) };
    this.insertDoc(d);
    this.leaveActive();
    this.active = d;
    this.render();
    const ok = await this.loadFromRecovery(d, m.id);
    if (!ok) {
      this.removeDoc(d);
      this.host.notify('Copie de récupération illisible.', 'error');
      return;
    }
    this.enterActive();
  }

  // --- session ---------------------------------------------------------------

  sessionSnapshot(hotExit: boolean): any {
    return {
      version: 1,
      active: this.active ? this.docs.indexOf(this.active) : -1,
      tabs: this.docs
        .filter((d) => d.path || (hotExit && d.dirty))
        .map((d) => {
          const sel = d === this.active && d.kind === 'text' && d.loaded ? this.view.getSelection() : (d.text?.sel ?? d.restore?.sel ?? [0, 0]);
          const scroll = d === this.active && d.kind === 'text' && d.loaded ? [this.view.ta.scrollTop, this.view.ta.scrollLeft] : d.text ? [d.text.scrollTop, d.text.scrollLeft] : (d.restore?.scroll ?? [0, 0]);
          return {
            path: d.path,
            name: d.path ? undefined : d.name,
            recoveryId: hotExit && d.dirty ? d.id : undefined,
            sel,
            scroll,
            mdView: d.mdView,
          };
        }),
    };
  }

  /** Restaure les onglets (contenu chargé à l'activation seulement). */
  restoreSession(session: any, recovery: any[]): Set<string> {
    const used = new Set<string>();
    if (!session || !Array.isArray(session.tabs)) return used;
    for (const t of session.tabs) {
      if (!t || (typeof t.path !== 'string' && !t.recoveryId)) continue;
      const rec = t.recoveryId ? recovery.find((m) => m.id === t.recoveryId) : null;
      if (t.recoveryId && !rec && !t.path) continue;
      if (t.path && this.findOpen(t.path)) continue;
      const name = t.path ? basename(t.path) : (t.name ?? 'Sans titre');
      const d = new Doc('text', t.path ?? null, name, 0, rec ? rec.id : undefined);
      if (!t.path) {
        this.untitledCounter++;
        d.untitledNo = this.untitledCounter;
      }
      d.mdView = t.mdView === 'split' || t.mdView === 'preview' ? t.mdView : 'source';
      d.restore = { sel: Array.isArray(t.sel) ? t.sel : undefined, scroll: Array.isArray(t.scroll) ? t.scroll : undefined };
      if (rec) {
        (d.restore as any).recoveryId = rec.id;
        (d.restore as any).recoveryMeta = rec;
        used.add(rec.id);
      }
      this.docs.push(d);
    }
    const i = typeof session.active === 'number' ? session.active : 0;
    const target = this.docs[Math.max(0, Math.min(i, this.docs.length - 1))];
    if (target) this.activate(target);
    else this.render();
    return used;
  }

  /** Fermeture de la fenêtre : vrai si l'on peut quitter. */
  async requestQuit(): Promise<boolean> {
    const s = this.host.settings;
    const hotExit = !!s.get('session.hotExit') && !!s.get('session.recovery');
    const dirty = this.docs.filter((d) => d.dirty);
    if (dirty.length && hotExit) {
      for (const d of dirty) await this.writeRecovery(d);
      if (dirty.every((d) => d.recoveryWritten)) return true;
    }
    if (dirty.length === 1) {
      if (!(await this.close(dirty[0]))) return false;
    } else if (dirty.length > 1) {
      const r = await ask({
        title: 'SwiftPad',
        message: `${dirty.length} documents contiennent des modifications non enregistrées :`,
        list: dirty.map((d) => d.path ?? d.name),
        buttons: [
          { id: 'save', label: 'Tout enregistrer', kind: 'primary' },
          { id: 'discard', label: 'Ne pas enregistrer' },
          { id: 'cancel', label: 'Annuler' },
        ],
        cancelId: 'cancel',
        defaultId: 'save',
      });
      if (r === 'cancel') return false;
      if (r === 'save') {
        for (const d of dirty) if (!(await this.save(d))) return false;
      }
    }
    // Sortie normale : aucune copie de récupération ne doit subsister.
    for (const d of this.docs) {
      if (d.recoveryWritten && !(hotExit && d.dirty)) {
        await rpc('recovery.delete', { id: d.id }).catch(() => {});
        d.recoveryWritten = false;
      }
    }
    return true;
  }

  // --- navigation ------------------------------------------------------------

  goTo(line: number, col?: number, len?: number): void {
    const d = this.active;
    if (!d) return;
    if (d.kind === 'big') {
      this.bigView.scrollToLine(line);
      return;
    }
    if (d.kind !== 'text' || !d.text) return;
    const text = d.text.text;
    const start = offsetOfLine(text, line);
    const lineEnd = text.indexOf('\n', start);
    const maxCol = (lineEnd === -1 ? text.length : lineEnd) - start;
    const c = Math.max(0, Math.min((col ?? 1) - 1, maxCol));
    const a = start + c;
    const b = len ? Math.min(text.length, a + len) : a;
    this.view.setSelection(a, b, true);
    this.view.focus();
    if (d.isMarkdown && d.mdView !== 'source') this.preview.syncToLine(line - 1);
  }

  async goToLinePrompt(): Promise<void> {
    const d = this.active;
    if (!d || (d.kind !== 'text' && d.kind !== 'big')) return;
    const max = d.kind === 'big' ? this.bigView.lineCount() : this.view.getLineCount();
    const cur = d.kind === 'text' ? this.view.caretLineCol().line : 1;
    const v = await promptText({
      title: 'Aller à la ligne',
      label: `Numéro de ligne (1 à ${max.toLocaleString('fr-FR')}), éventuellement suivi de « :colonne »`,
      value: String(cur),
      okLabel: 'Atteindre',
      validate: (s) => {
        const m = /^\s*(\d+)\s*(?::\s*(\d+))?\s*$/.exec(s);
        if (!m) return 'Saisissez un nombre, par exemple 120 ou 120:8.';
        const n = Number(m[1]);
        if (n < 1 || n > max) return `La ligne doit être comprise entre 1 et ${max.toLocaleString('fr-FR')}.`;
        return null;
      },
    });
    if (!v) return;
    const m = /^\s*(\d+)\s*(?::\s*(\d+))?/.exec(v)!;
    this.goTo(Number(m[1]), m[2] ? Number(m[2]) : undefined);
  }

  headings(): { level: number; text: string; line: number }[] {
    const d = this.active;
    if (!d || d.kind !== 'text' || !d.text || !d.isMarkdown) return [];
    return extractHeadings(d.text.text);
  }

  // --- Markdown -----------------------------------------------------------------

  setMdView(mode: MdView): void {
    const d = this.active;
    if (!d || d.kind !== 'text' || !d.isMarkdown) return;
    if (mode === 'split' && this.views.clientWidth < 720) {
      this.host.notify('Fenêtre trop étroite pour la vue partagée : aperçu seul affiché.');
      mode = 'preview';
    }
    d.mdView = mode;
    this.render();
    if (mode !== 'source') {
      void this.refreshPreview();
      if (mode === 'preview') this.preview.root.focus();
    } else this.view.focus();
    this.host.sessionChanged();
  }

  togglePreview(): void {
    const d = this.active;
    if (!d || !d.isMarkdown) return;
    this.setMdView(d.mdView === 'source' ? 'split' : 'source');
  }

  private async refreshPreview(): Promise<void> {
    const d = this.active;
    if (!d || d.kind !== 'text' || !d.text || !d.isMarkdown || d.mdView === 'source') return;
    const text = d.text.text;
    if (text.length > 4 * MB) {
      this.host.notify('Document trop volumineux pour l’aperçu en direct (4 Mo maximum).');
      return;
    }
    try {
      await this.preview.update(text, d.dir(this.host.sep), this.host.sep, !!this.host.settings.get('markdown.toc'));
      if (d.mdView === 'split') this.preview.syncToLine(this.view.firstVisibleLine());
    } catch (e) {
      this.host.notify(`Aperçu indisponible : ${errorMessage(e)}`, 'error');
    }
  }

  // --- impression ---------------------------------------------------------------

  async print(): Promise<void> {
    const d = this.active;
    if (!d || d.kind !== 'text' || !d.text) return;
    clear(this.printRoot);
    this.printRoot.append(h('div', { class: 'print-title', text: d.path ?? d.name }));
    if (d.isMarkdown && d.mdView !== 'source') {
      const body = this.preview.root.querySelector('.md-body');
      if (body) this.printRoot.append(body.cloneNode(true));
    } else {
      this.printRoot.append(h('pre', { class: 'print-text', text: d.text.text }));
    }
    document.body.classList.add('printing');
    const done = () => {
      document.body.classList.remove('printing');
      clear(this.printRoot);
    };
    window.addEventListener('afterprint', done, { once: true });
    setTimeout(done, 120_000);
    await native.printPage();
  }

  // --- divers -----------------------------------------------------------------

  reveal(d: Doc | null = this.active): void {
    if (!d?.path) return;
    native.revealInExplorer(d.path).catch((e) => this.host.notify(errorMessage(e), 'error'));
  }

  async openExternal(url: string): Promise<void> {
    const r = await ask({
      title: 'Ouvrir un lien',
      message: 'Ouvrir ce lien dans le navigateur par défaut ?',
      detail: url,
      buttons: [
        { id: 'open', label: 'Ouvrir', kind: 'primary' },
        { id: 'copy', label: 'Copier le lien' },
        { id: 'cancel', label: 'Annuler' },
      ],
      cancelId: 'cancel',
    });
    if (r === 'open') await native.openExternalUrl(url).catch((e) => this.host.notify(errorMessage(e), 'error'));
    if (r === 'copy') await copyText(url);
  }

  async renameFile(d: Doc | null = this.active): Promise<void> {
    if (!d?.path) return;
    if (d.dirty) {
      this.host.notify('Enregistrez d’abord le document avant de le renommer.');
      return;
    }
    const name = d.name;
    const dot = name.lastIndexOf('.');
    const v = await promptText({ title: 'Renommer', label: 'Nouveau nom', value: name, select: [0, dot > 0 ? dot : name.length], okLabel: 'Renommer', validate: (s) => this.host.validateName(s) });
    if (!v || v === name) return;
    try {
      const r = await rpc('fs.rename', { path: d.path, name: v });
      const old = d.path;
      this.onPathMoved(old, r.path);
      this.host.pathsChanged([dirname(old)]);
    } catch (e) {
      await alertMsg('Renommage impossible', errorMessage(e));
    }
  }

  private tabMenu(d: Doc, x: number, y: number): void {
    const idx = this.docs.indexOf(d);
    const items: MenuItem[] = [
      act('Fermer', () => this.close(d), { key: 'Ctrl+W' }),
      act('Fermer les autres onglets', () => this.closeMany(this.docs.filter((o) => o !== d)), { enabled: this.docs.length > 1 }),
      act('Fermer les onglets à droite', () => this.closeMany(this.docs.slice(idx + 1)), { enabled: idx < this.docs.length - 1 }),
      act('Fermer les onglets enregistrés', () => this.closeMany(this.docs.filter((o) => !o.dirty))),
      sep(),
      act('Copier le chemin complet', () => d.path && copyText(d.path).then(() => this.host.notify('Chemin copié.')), { enabled: !!d.path }),
      act('Afficher dans l’Explorateur Windows', () => this.reveal(d), { enabled: !!d.path }),
      sep(),
      act('Renommer…', () => this.renameFile(d), { enabled: !!d.path && d.kind === 'text', key: 'F2' }),
      act('Recharger depuis le disque', () => this.reload(d), { enabled: !!d.path && d.kind === 'text' }),
    ];
    showContextMenu(items, x, y);
  }

  /** Opérations d'édition déléguées au document actif. */
  edit(op: 'duplicate' | 'deleteLine' | 'moveUp' | 'moveDown' | 'indent' | 'outdent' | 'selectLine' | 'trimTrailing' | 'dateTime'): void {
    const v = this.textView();
    if (!v) return;
    const text = v.getText();
    const [s, e] = v.getSelection();
    const unit = this.host.settings.get('editor.insertSpaces') ? ' '.repeat(this.host.settings.get('editor.tabSize')) : '\t';
    switch (op) {
      case 'duplicate':
        v.apply(ops.duplicateLines(text, s, e), 'duplicate');
        break;
      case 'deleteLine':
        v.apply(ops.deleteLines(text, s, e), 'delete-line');
        break;
      case 'moveUp':
        v.apply(ops.moveLines(text, s, e, -1), 'move');
        break;
      case 'moveDown':
        v.apply(ops.moveLines(text, s, e, 1), 'move');
        break;
      case 'indent':
        v.apply(ops.indentLines(text, s, e, unit), 'indent');
        break;
      case 'outdent':
        v.apply(ops.outdentLines(text, s, e, this.host.settings.get('editor.tabSize')), 'outdent');
        break;
      case 'selectLine': {
        const [a, b] = ops.selectLines(text, s, e);
        v.setSelection(a, b, true);
        break;
      }
      case 'trimTrailing': {
        const c = ops.trimTrailingWhitespace(text);
        if (!c) this.host.notify('Aucun espace en fin de ligne.');
        else v.apply({ ...c, sel: [s, s] }, 'trim');
        break;
      }
      case 'dateTime':
        v.insertText(ops.dateTimeStamp(new Date()), 'date');
        break;
    }
    v.focus();
  }
}
