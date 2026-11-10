// Vue d'édition : une zone de texte native (accessible, saisie IME, menu
// contextuel du système) complétée par :
// * une pile d'annulation propre à chaque document (voir history.ts) ;
// * une gouttière de numéros de ligne virtualisée (seules les lignes
//   visibles sont dessinées) ;
// * un calque facultatif sous le texte (caractères invisibles, espaces de
//   fin de ligne, occurrences de la recherche), limité aux lignes visibles.

import { History, type Sel } from './history';
import { Edit, editFromSelections, diffFull, applyEdit, buildLineStarts, lineOfOffset, countNewlines, lineStartOf, lineEndOf } from './text';
import { indentLines, outdentLines, type Change } from './ops';
import { Emitter, Disposer, rafThrottle, debounce } from '../core/events';
import { h, clear, measureText } from '../ui/dom';

export interface TextState {
  text: string;
  history: History;
  sel: Sel;
  scrollTop: number;
  scrollLeft: number;
  readOnly: boolean;
  /** Mode allégé (gros document) : pas de calque ni de gouttière en retour à la ligne. */
  heavy: boolean;
  version: number;
}

export function newTextState(text: string, readOnly = false, heavy = false): TextState {
  return { text, history: new History(), sel: [0, 0], scrollTop: 0, scrollLeft: 0, readOnly, heavy, version: 0 };
}

export interface ViewOptions {
  wrap: boolean;
  lineNumbers: boolean;
  tabSize: number;
  insertSpaces: boolean;
  autoIndent: boolean;
  fontFamily: string;
  fontSize: number;
  zoom: number;
  showInvisibles: boolean;
  highlightTrailing: boolean;
  /** Interligne en pourcentage de la taille du texte (165 = 1,65). */
  lineHeight: number;
  /** Colonne d'écriture centrée : étroite, moyenne ou pleine largeur. */
  columnWidth: 'narrow' | 'medium' | 'full';
}

const PAD_TOP = 28;
/** Marge horizontale minimale autour du texte. */
const PAD_MIN = 24;
/** Largeur des colonnes, en largeurs moyennes de caractère (lignes de
 *  60 à 75 signes environ pour la colonne moyenne, en police proportionnelle). */
const COLUMN_CHARS = { narrow: 58, medium: 74 } as const;
/** Au-delà, pas de numéros de ligne en mode « retour à la ligne » (mesure coûteuse). */
const WRAP_MEASURE_MAX_LINES = 20_000;
/** Vérification exhaustive des modifications déduites jusqu'à cette taille. */
const VERIFY_MAX = 256 * 1024;

type Events = { change: Edit | null; selection: void; scroll: void; undoRedo: void };

export class TextView {
  readonly root: HTMLElement;
  readonly ta: HTMLTextAreaElement;
  readonly events = new Emitter<Events>();
  private gutter: HTMLElement;
  private gutterInner: HTMLElement;
  private overlay: HTMLElement;
  private overlayInner: HTMLElement;
  private mirror: HTMLElement;
  private state: TextState | null = null;
  private d = new Disposer();
  private opts: ViewOptions;
  private lineHeight = 20;
  private charWidth = 8;
  /** Largeur moyenne d'un caractère de texte courant (colonne d'écriture). */
  private avgCharWidth = 8;
  /** Marge horizontale courante (colonne centrée). */
  private padX = PAD_MIN;
  private lineCount = 1;
  private starts: Uint32Array | null = null;
  private startsVersion = -1;
  private wrapTops: Float64Array | null = null;
  private wrapVersion = -1;
  private wrapWidth = -1;
  private pending: { s: number; e: number } | null = null;
  /**
   * Saisie faite pendant le chargement d'un document (zone de texte en
   * lecture seule) : rejouée dès qu'il est affiché, comme le Bloc-notes qui
   * traite les frappes en attente. Texte, Entrée, Retour arrière et
   * Ctrl+Début/Fin ; abandonnée si le focus a quitté l'éditeur.
   */
  private typedWhileLoading: ({ t: 'text'; s: string } | { t: 'back' } | { t: 'home' } | { t: 'end' })[] = [];
  private typedAt = 0;
  private composing: { text: string; s: number; e: number } | null = null;
  private applying = false;
  private highlight: RegExp | null = null;
  private active: [number, number] | null = null;
  tabMovesFocus = false;

  private scheduleRender = rafThrottle(() => this.render());
  private measureWrapLater = debounce(() => {
    this.measureWrap();
    this.render();
  }, 150);

  constructor(opts: ViewOptions) {
    this.opts = { ...opts };
    this.ta = h('textarea', {
      class: 'editor-text',
      attrs: { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', 'aria-multiline': 'true', wrap: 'off', readonly: true },
    });
    this.gutterInner = h('div', { class: 'gutter-inner' });
    this.gutter = h('div', { class: 'gutter', attrs: { 'aria-hidden': 'true' } }, this.gutterInner);
    this.overlayInner = h('div', { class: 'overlay-inner' });
    this.overlay = h('div', { class: 'editor-overlay', attrs: { 'aria-hidden': 'true' } }, this.overlayInner);
    this.mirror = h('div', { class: 'editor-mirror', attrs: { 'aria-hidden': 'true' } });
    this.root = h('div', { class: 'editor' }, this.gutter, h('div', { class: 'editor-body' }, this.overlay, this.ta, this.mirror));
    this.bind();
    this.applyOptions();
  }

  // --- options -----------------------------------------------------------

  setOptions(patch: Partial<ViewOptions>): void {
    this.opts = { ...this.opts, ...patch };
    this.applyOptions();
  }

  getOptions(): ViewOptions {
    return { ...this.opts };
  }

  private applyOptions(): void {
    const o = this.opts;
    const size = Math.max(4, Math.round((o.fontSize * o.zoom) / 100));
    this.lineHeight = Math.max(size, Math.round((size * (o.lineHeight || 150)) / 100));
    const font = `${size}px ${o.fontFamily}`;
    this.charWidth = measureText('0', font) || size * 0.6;
    const sample = 'Le texte courant sert de mesure moyenne, avec ses espaces.';
    this.avgCharWidth = measureText(sample, font) / sample.length || this.charWidth;
    const st = this.root.style;
    st.setProperty('--ed-font', o.fontFamily);
    st.setProperty('--ed-size', `${size}px`);
    st.setProperty('--ed-lh', `${this.lineHeight}px`);
    st.setProperty('--ed-tab', String(o.tabSize));
    st.setProperty('--ed-pad-top', `${PAD_TOP}px`);
    this.updateColumn();
    const wrap = o.wrap;
    this.ta.setAttribute('wrap', wrap ? 'soft' : 'off');
    this.root.classList.toggle('wrap', wrap);
    this.wrapVersion = -1;
    this.updateGutterVisibility();
    this.scheduleRender();
    if (wrap) this.measureWrapLater();
  }

  /**
   * Marges latérales de la colonne d'écriture centrée. La zone de texte garde
   * toute la largeur (barre de défilement au bord de la fenêtre) ; seules ses
   * marges intérieures changent. Renvoie vrai si elles ont changé.
   */
  private updateColumn(): boolean {
    const chars = this.opts.columnWidth === 'full' ? 0 : COLUMN_CHARS[this.opts.columnWidth] ?? COLUMN_CHARS.medium;
    // Largeur disponible mesurée sur le conteneur : celle de la zone de texte
    // ne peut pas descendre sous ses marges actuelles (boîte « border-box »),
    // ce qui fausserait le calcul quand la fenêtre rétrécit.
    const scrollbar = this.ta.offsetWidth - this.ta.clientWidth;
    const avail = (this.ta.parentElement?.clientWidth ?? this.ta.clientWidth) - scrollbar;
    let pad = PAD_MIN;
    if (chars && avail > 0) pad = Math.max(PAD_MIN, Math.floor((avail - chars * this.avgCharWidth) / 2));
    if (pad === this.padX && this.root.style.getPropertyValue('--ed-pad-left')) return false;
    this.padX = pad;
    this.root.style.setProperty('--ed-pad-left', `${pad}px`);
    this.root.style.setProperty('--ed-pad-right', `${pad}px`);
    this.wrapVersion = -1;
    return true;
  }

  private updateGutterVisibility(): void {
    const show = this.opts.lineNumbers && this.canNumber();
    this.gutter.hidden = !show;
    this.root.classList.toggle('no-gutter', !show);
  }

  /** Numéros de ligne disponibles ? (en retour à la ligne : documents raisonnables). */
  canNumber(): boolean {
    if (!this.opts.wrap) return true;
    return !!this.state && !this.state.heavy && this.lineCount <= WRAP_MEASURE_MAX_LINES;
  }

  // --- document ----------------------------------------------------------

  attach(state: TextState): void {
    if (this.state) this.detach();
    this.state = state;
    this.ta.value = state.text;
    this.ta.readOnly = state.readOnly;
    this.lineCount = countNewlines(state.text) + 1;
    this.starts = null;
    this.wrapVersion = -1;
    this.ta.setSelectionRange(state.sel[0], state.sel[1]);
    this.ta.scrollTop = state.scrollTop;
    this.ta.scrollLeft = state.scrollLeft;
    this.updateGutterVisibility();
    this.render();
    if (this.opts.wrap) this.measureWrapLater();
    this.replayTypedWhileLoading();
    // La restauration du défilement doit attendre la mise en page.
    requestAnimationFrame(() => {
      if (this.state !== state) return;
      this.ta.scrollTop = state.scrollTop;
      this.ta.scrollLeft = state.scrollLeft;
      this.render();
    });
  }

  /** Frappe reçue pendant qu'aucun document n'est attaché (chargement). */
  bufferWhileLoading(e: KeyboardEvent): void {
    const altGr = e.getModifierState?.('AltGraph');
    const ctrl = (e.ctrlKey || e.metaKey) && !altGr;
    const q = this.typedWhileLoading;
    let op: (typeof q)[number] | null = null;
    if (ctrl && !e.altKey && !e.shiftKey && (e.key === 'End' || e.key === 'Home')) op = { t: e.key === 'End' ? 'end' : 'home' };
    else if (ctrl || (e.altKey && !altGr) || e.isComposing) return;
    else if ([...e.key].length === 1) op = { t: 'text', s: e.key };
    else if (e.key === 'Enter') op = { t: 'text', s: '\n' };
    else if (e.key === 'Backspace') op = { t: 'back' };
    if (!op) return;
    e.preventDefault();
    const last = q[q.length - 1];
    if (op.t === 'text' && last?.t === 'text') last.s += op.s;
    else if (q.length < 10_000) q.push(op);
    this.typedAt = Date.now();
  }

  bufferPaste(e: ClipboardEvent): void {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    this.typedWhileLoading.push({ t: 'text', s: text.replace(/\r\n?/g, '\n') });
    this.typedAt = Date.now();
  }

  private replayTypedWhileLoading(): void {
    const ops = this.typedWhileLoading;
    this.typedWhileLoading = [];
    const st = this.state;
    // Focus resté sur l'éditeur ou nulle part (zone masquée pendant le
    // chargement) ; parti ailleurs (explorateur, recherche…) : abandon.
    const focus = document.activeElement;
    const focusOk = focus === this.ta || focus === null || focus === document.body;
    if (!ops.length || !st || st.readOnly || !focusOk || Date.now() - this.typedAt > 10_000) return;
    for (const op of ops) {
      if (op.t === 'home') this.setSelection(0, 0);
      else if (op.t === 'end') this.setSelection(st.text.length, st.text.length);
      else if (op.t === 'text') this.insertText(op.s, 'type');
      else {
        const [a, b] = this.getSelection();
        if (a !== b) this.replaceRange(a, b, '', [a, a], 'delete-back');
        else if (a > 0) {
          const from = a >= 2 && /[\uDC00-\uDFFF]/.test(st.text[a - 1]) && /[\uD800-\uDBFF]/.test(st.text[a - 2]) ? a - 2 : a - 1;
          this.replaceRange(from, a, '', [from, from], 'delete-back');
        }
      }
    }
  }

  /** Mémorise l'état de la vue dans le document et libère la zone de texte. */
  detach(): void {
    const s = this.state;
    if (!s) return;
    s.sel = [this.ta.selectionStart, this.ta.selectionEnd];
    s.scrollTop = this.ta.scrollTop;
    s.scrollLeft = this.ta.scrollLeft;
    this.state = null;
    this.ta.value = '';
    // Sans document attaché, aucune saisie ne doit être acceptée (elle serait perdue).
    this.ta.readOnly = true;
    this.highlight = null;
    this.active = null;
    clear(this.overlayInner);
  }

  current(): TextState | null {
    return this.state;
  }

  setReadOnly(ro: boolean): void {
    if (!this.state) return;
    this.state.readOnly = ro;
    this.ta.readOnly = ro;
  }

  getText(): string {
    return this.state ? this.state.text : '';
  }

  getSelection(): Sel {
    return [this.ta.selectionStart, this.ta.selectionEnd];
  }

  getLineCount(): number {
    return this.lineCount;
  }

  focus(): void {
    this.ta.focus({ preventScroll: true });
  }

  /** Remplace tout le texte (rechargement) en vidant l'historique. */
  resetText(text: string, keepSel = true): void {
    if (!this.state) return;
    const sel = this.getSelection();
    this.state.text = text;
    this.state.version++;
    this.ta.value = text;
    this.lineCount = countNewlines(text) + 1;
    this.starts = null;
    this.state.history.clear(true);
    if (keepSel) this.ta.setSelectionRange(Math.min(sel[0], text.length), Math.min(sel[1], text.length));
    this.updateGutterVisibility();
    this.scheduleRender();
    if (this.opts.wrap) this.measureWrapLater();
    this.events.emit('change', null);
  }

  // --- liaison des événements ---------------------------------------------

  private bind(): void {
    const ta = this.ta;
    this.d.listen(ta, 'keydown', (e: KeyboardEvent) => this.onKeyDown(e));
    this.d.listen(ta, 'beforeinput', (e: InputEvent) => {
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
        e.preventDefault();
        if (e.inputType === 'historyUndo') this.undo();
        else this.redo();
        return;
      }
      if (!this.composing) this.pending = { s: ta.selectionStart, e: ta.selectionEnd };
    });
    this.d.listen(ta, 'input', (e: InputEvent) => this.onInput(e));
    this.d.listen(ta, 'paste', (e: ClipboardEvent) => {
      if (!this.state) this.bufferPaste(e);
    });
    this.d.listen(ta, 'compositionstart', () => {
      if (!this.state) return;
      this.composing = { text: this.state.text, s: ta.selectionStart, e: ta.selectionEnd };
    });
    this.d.listen(ta, 'compositionend', () => {
      const c = this.composing;
      this.composing = null;
      if (!c || !this.state) return;
      const neu = ta.value;
      if (neu === c.text) return;
      const edit = editFromSelections(c.text, neu, c.s, c.e, ta.selectionStart, ta.selectionEnd) ?? diffFull(c.text, neu);
      this.commitInput(c.text, neu, edit, 'ime', [c.s, c.e]);
    });
    const onScroll = () => {
      this.scheduleRender();
      this.events.emit('scroll', undefined);
    };
    this.d.listen(ta, 'scroll', onScroll, { passive: true });
    const sel = () => this.events.emit('selection', undefined);
    for (const t of ['keyup', 'mouseup', 'select', 'focus']) this.d.listen(ta, t, sel);
    this.d.listen(document, 'selectionchange', () => {
      if (document.activeElement === ta) sel();
    });
    this.d.listen(ta, 'wheel', (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        this.root.dispatchEvent(new CustomEvent('editor-zoom', { bubbles: true, detail: e.deltaY < 0 ? 1 : -1 }));
      }
    }, { passive: false });
    const ro = new ResizeObserver(() => {
      const moved = this.updateColumn();
      if (this.opts.wrap && (moved || this.ta.clientWidth !== this.wrapWidth)) this.measureWrapLater();
      this.scheduleRender();
    });
    ro.observe(this.root);
    this.d.add(() => ro.disconnect());
  }

  private onInput(e: InputEvent): void {
    const st = this.state;
    if (!st || this.applying) return;
    if (this.composing || e.isComposing) return; // enregistré en fin de composition
    const old = st.text;
    const neu = this.ta.value;
    const p = this.pending;
    this.pending = null;
    if (neu === old) return;
    let edit: Edit | null = null;
    if (p) edit = editFromSelections(old, neu, p.s, p.e, this.ta.selectionStart, this.ta.selectionEnd);
    // Vérification exhaustive sur les documents de taille courante.
    if (edit && old.length <= VERIFY_MAX && applyEdit(old, edit) !== neu) edit = null;
    if (!edit) edit = diffFull(old, neu);
    const kind = kindOf(e.inputType);
    this.commitInput(old, neu, edit, kind, p ? [p.s, p.e] : [edit.start, edit.start + edit.removed.length]);
  }

  private commitInput(_old: string, neu: string, edit: Edit, kind: string, selBefore: Sel): void {
    const st = this.state!;
    st.text = neu;
    st.version++;
    this.lineCount += countNewlines(edit.inserted) - countNewlines(edit.removed);
    st.history.record(edit, kind, selBefore, [this.ta.selectionStart, this.ta.selectionEnd]);
    this.afterChange(edit);
  }

  private afterChange(edit: Edit | null): void {
    const before = this.gutter.hidden;
    this.updateGutterVisibility();
    if (before !== this.gutter.hidden) this.wrapVersion = -1;
    this.scheduleRender();
    if (this.opts.wrap) this.measureWrapLater();
    this.events.emit('change', edit);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.state) {
      this.bufferWhileLoading(e);
      return;
    }
    if (e.isComposing) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (ctrl && !e.altKey && (k === 'z' || k === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (ctrl && !e.altKey && !e.shiftKey && (k === 'y' || k === 'Y')) {
      e.preventDefault();
      this.redo();
      return;
    }
    if (this.state.readOnly) return;
    if (k === 'Tab' && !ctrl && !e.altKey && !this.tabMovesFocus) {
      e.preventDefault();
      const [s, en] = this.getSelection();
      const text = this.state.text;
      const unit = this.opts.insertSpaces ? ' '.repeat(this.opts.tabSize) : '\t';
      if (e.shiftKey) this.apply(outdentLines(text, s, en, this.opts.tabSize), 'outdent');
      else if (text.slice(s, en).includes('\n')) this.apply(indentLines(text, s, en, unit), 'indent');
      else this.insertText(unit, 'type');
      return;
    }
    if (k === 'Enter' && !ctrl && !e.altKey && !e.shiftKey && this.opts.autoIndent) {
      const [s, en] = this.getSelection();
      const ls = lineStartOf(this.state.text, s);
      const lead = /^[ \t]*/.exec(this.state.text.slice(ls, Math.min(s, ls + 256)))?.[0] ?? '';
      if (lead.length > 0) {
        e.preventDefault();
        const insert = '\n' + lead;
        this.replaceRange(s, en, insert, [s + insert.length, s + insert.length], 'newline');
      }
    }
  }

  // --- modifications programmatiques ---------------------------------------

  /** Remplace une plage (annulable). Renvoie faux si le document est en lecture seule. */
  replaceRange(start: number, end: number, insert: string, sel: Sel, kind: string, reveal = true): boolean {
    const st = this.state;
    if (!st || st.readOnly) return false;
    const removed = st.text.slice(start, end);
    if (removed === insert) {
      this.setSelection(sel[0], sel[1], reveal);
      return true;
    }
    const before = this.getSelection();
    this.applying = true;
    try {
      this.ta.setRangeText(insert, start, end);
    } finally {
      this.applying = false;
    }
    st.text = this.ta.value;
    st.version++;
    const edit = { start, removed, inserted: insert };
    this.lineCount += countNewlines(insert) - countNewlines(removed);
    this.ta.setSelectionRange(sel[0], sel[1]);
    st.history.record(edit, kind, before, sel);
    this.afterChange(edit);
    if (reveal) this.reveal(sel[1]);
    return true;
  }

  apply(c: Change | null, kind: string): boolean {
    if (!c) return false;
    return this.replaceRange(c.start, c.end, c.insert, c.sel, kind);
  }

  insertText(text: string, kind = 'insert'): boolean {
    const [s, e] = this.getSelection();
    return this.replaceRange(s, e, text, [s + text.length, s + text.length], kind);
  }

  undo(): void {
    const st = this.state;
    if (!st || st.readOnly) return;
    const step = st.history.undo();
    if (!step) return;
    this.applyEdits(step.edits, true);
    this.setSelection(step.selBefore[0], step.selBefore[1], true);
    this.events.emit('undoRedo', undefined);
  }

  redo(): void {
    const st = this.state;
    if (!st || st.readOnly) return;
    const step = st.history.redo();
    if (!step) return;
    this.applyEdits(step.edits, false);
    this.setSelection(step.selAfter[0], step.selAfter[1], true);
    this.events.emit('undoRedo', undefined);
  }

  private applyEdits(edits: Edit[], reverse: boolean): void {
    const st = this.state!;
    this.applying = true;
    try {
      const list = reverse ? [...edits].reverse() : edits;
      for (const e of list) {
        if (reverse) this.ta.setRangeText(e.removed, e.start, e.start + e.inserted.length);
        else this.ta.setRangeText(e.inserted, e.start, e.start + e.removed.length);
        const delta = countNewlines(e.inserted) - countNewlines(e.removed);
        this.lineCount += reverse ? -delta : delta;
      }
    } finally {
      this.applying = false;
    }
    st.text = this.ta.value;
    st.version++;
    this.afterChange(null);
  }

  // --- sélection et défilement ----------------------------------------------

  setSelection(s: number, e: number, reveal = true): void {
    const len = this.ta.value.length;
    this.ta.setSelectionRange(Math.min(s, len), Math.min(e, len));
    if (reveal) this.reveal(e, s);
    this.events.emit('selection', undefined);
  }

  /** Index des débuts de ligne (recalculé paresseusement après modification). */
  lineStarts(): Uint32Array {
    const st = this.state;
    if (!st) return new Uint32Array([0]);
    if (!this.starts || this.startsVersion !== st.version) {
      this.starts = buildLineStarts(st.text);
      this.startsVersion = st.version;
    }
    return this.starts;
  }

  lineOf(pos: number): number {
    return lineOfOffset(this.lineStarts(), pos);
  }

  /** Ligne et colonne (base 1) du curseur. */
  caretLineCol(): { line: number; col: number; selLen: number } {
    const [s, e] = this.getSelection();
    const head = this.ta.selectionDirection === 'backward' ? s : e;
    const line = this.lineOf(head);
    return { line: line + 1, col: head - this.lineStarts()[line] + 1, selLen: Math.abs(e - s) };
  }

  /** Fait défiler pour rendre `pos` visible (et `anchor` si possible). */
  reveal(pos: number, anchor?: number): void {
    if (!this.state) return;
    const ta = this.ta;
    const line = this.lineOf(pos);
    const lh = this.lineHeight;
    let top: number | null = null;
    if (!this.opts.wrap) top = PAD_TOP + line * lh;
    else if (this.wrapTops && this.wrapVersion === this.state.version) top = this.wrapTops[line];
    if (top === null) {
      // Retour à la ligne sans mesure disponible : Chromium amène le
      // curseur à l'écran lorsque la zone de texte reprend le focus.
      const prev = document.activeElement as HTMLElement | null;
      ta.blur();
      ta.focus({ preventScroll: false });
      if (prev && prev !== ta) prev.focus({ preventScroll: true });
      return;
    }
    const view = ta.clientHeight;
    if (top < ta.scrollTop + lh || top + lh > ta.scrollTop + view - lh) {
      ta.scrollTop = Math.max(0, top - Math.round(view / 3));
    }
    if (!this.opts.wrap) {
      const starts = this.lineStarts();
      const ls = starts[line];
      const x = this.padX + this.textWidth(this.state.text.slice(ls, Math.min(pos, ls + 4000)));
      const width = ta.clientWidth;
      const margin = this.charWidth * 4;
      if (x < ta.scrollLeft + margin || x > ta.scrollLeft + width - margin) {
        ta.scrollLeft = Math.max(0, x - width / 2);
      }
      void anchor;
    }
    this.scheduleRender();
  }

  /** Largeur d'un fragment de ligne (tabulations comprises). */
  private textWidth(s: string): number {
    const size = Math.max(4, Math.round((this.opts.fontSize * this.opts.zoom) / 100));
    const font = `${size}px ${this.opts.fontFamily}`;
    if (!s.includes('\t')) return measureText(s, font);
    const tabW = measureText(' ', font) * this.opts.tabSize;
    let x = 0;
    for (const part of s.split(/(\t)/)) {
      if (part === '\t') x = (Math.floor(x / tabW) + 1) * tabW;
      else if (part) x += measureText(part, font);
    }
    return x;
  }

  /** Première ligne visible (base 0), pour la synchronisation de l'aperçu. */
  firstVisibleLine(): number {
    const y = this.ta.scrollTop;
    if (!this.opts.wrap) return Math.max(0, Math.floor((y - PAD_TOP) / this.lineHeight));
    if (this.wrapTops) return Math.max(0, upperBound(this.wrapTops, y) - 1);
    const total = this.ta.scrollHeight || 1;
    return Math.floor((y / total) * this.lineCount);
  }

  scrollToLine(line0: number): void {
    if (!this.opts.wrap) this.ta.scrollTop = PAD_TOP + line0 * this.lineHeight;
    else if (this.wrapTops) this.ta.scrollTop = this.wrapTops[Math.min(line0, this.wrapTops.length - 1)];
    this.scheduleRender();
  }

  setHighlight(re: RegExp | null): void {
    this.highlight = re;
    this.scheduleRender();
  }

  /** Occurrence active de la recherche (visible même sans le focus). */
  setActiveMatch(r: [number, number] | null): void {
    this.active = r;
    this.scheduleRender();
  }

  // --- rendu de la gouttière et du calque -------------------------------------

  private measureWrap(): void {
    const st = this.state;
    this.wrapTops = null;
    if (!st || !this.opts.wrap || !this.canNumber()) {
      clear(this.mirror);
      return;
    }
    const width = this.ta.clientWidth;
    if (width <= 0) return;
    const m = this.mirror;
    m.style.width = `${width}px`;
    const frag = document.createDocumentFragment();
    const text = st.text;
    let i = 0;
    while (i <= text.length) {
      const j = text.indexOf('\n', i);
      const end = j === -1 ? text.length : j;
      const div = document.createElement('div');
      div.textContent = end > i ? text.slice(i, end) : '​';
      frag.append(div);
      if (j === -1) break;
      i = j + 1;
    }
    clear(m);
    m.append(frag);
    const n = m.childElementCount;
    const tops = new Float64Array(n + 1);
    let k = 0;
    for (let c = m.firstElementChild as HTMLElement | null; c; c = c.nextElementSibling as HTMLElement | null) tops[k++] = c.offsetTop;
    tops[n] = m.scrollHeight;
    clear(m);
    this.wrapTops = tops;
    this.wrapVersion = st.version;
    this.wrapWidth = width;
  }

  private visibleRange(): { first: number; last: number; topOf: (i: number) => number } | null {
    const st = this.state;
    if (!st) return null;
    const y = this.ta.scrollTop;
    const view = this.ta.clientHeight;
    const lh = this.lineHeight;
    if (!this.opts.wrap) {
      const first = Math.max(0, Math.floor((y - PAD_TOP) / lh));
      const last = Math.min(this.lineCount - 1, Math.ceil((y + view - PAD_TOP) / lh));
      return { first, last, topOf: (i) => PAD_TOP + i * lh };
    }
    const tops = this.wrapTops;
    if (!tops || tops.length - 1 !== this.lineCount) return null;
    const first = Math.max(0, upperBound(tops, y) - 1);
    let last = first;
    while (last + 1 < this.lineCount && tops[last + 1] < y + view) last++;
    return { first, last, topOf: (i) => tops[i] };
  }

  private render(): void {
    const st = this.state;
    if (!st) return;
    const vr = this.visibleRange();
    // Gouttière.
    if (!this.gutter.hidden) {
      const digits = Math.max(3, String(this.lineCount).length);
      const gw = Math.ceil(digits * this.charWidth + 22);
      this.root.style.setProperty('--gutter-w', `${gw}px`);
      clear(this.gutterInner);
      if (vr) {
        const caret = this.lineOf(this.ta.selectionEnd);
        const frag = document.createDocumentFragment();
        for (let i = vr.first; i <= vr.last; i++) {
          const top = vr.topOf(i) - this.ta.scrollTop;
          const row = document.createElement('div');
          row.className = i === caret ? 'gl cur' : 'gl';
          row.style.transform = `translateY(${top}px)`;
          row.textContent = String(i + 1);
          frag.append(row);
        }
        this.gutterInner.append(frag);
      }
    }
    // Calque (invisibles, espaces de fin, occurrences).
    const wantOverlay = !st.heavy && (this.opts.showInvisibles || this.opts.highlightTrailing || !!this.highlight || !!this.active);
    this.overlay.hidden = !wantOverlay || !vr;
    if (!wantOverlay || !vr) {
      if (this.overlayInner.firstChild) clear(this.overlayInner);
      return;
    }
    const starts = this.lineStarts();
    const text = st.text;
    if (this.opts.wrap) this.root.style.setProperty('--ed-content-w', `${Math.max(0, this.ta.clientWidth - 2 * this.padX)}px`);
    clear(this.overlayInner);
    this.overlayInner.style.transform = `translate(${-this.ta.scrollLeft}px, ${-this.ta.scrollTop}px)`;
    const frag = document.createDocumentFragment();
    const max = Math.min(vr.last, vr.first + 400);
    for (let i = vr.first; i <= max; i++) {
      const ls = starts[i];
      const le = i + 1 < starts.length ? starts[i + 1] - 1 : text.length;
      const line = text.slice(ls, Math.min(le, ls + 20_000));
      const row = document.createElement('div');
      row.className = 'ol';
      row.style.top = `${vr.topOf(i)}px`;
      this.renderOverlayLine(row, line, ls);
      frag.append(row);
    }
    this.overlayInner.append(frag);
  }

  private renderOverlayLine(row: HTMLElement, line: string, ls: number): void {
    // Repères : [début, fin, classe] ; un caractère peut cumuler plusieurs classes.
    const marks: [number, number, string][] = [];
    if (this.active) {
      const a = Math.max(this.active[0], ls) - ls;
      const b = Math.min(this.active[1], ls + line.length) - ls;
      if (b > a) marks.push([a, b, 'oa']);
    }
    if (this.highlight) {
      const re = this.highlight;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = re.exec(line)) && guard++ < 1000) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        marks.push([m.index, m.index + m[0].length, 'om']);
      }
    }
    const trailing = /[ \t]+$/.exec(line);
    const trailStart = trailing ? trailing.index : line.length;
    if (this.opts.highlightTrailing && trailing && trailing.index < line.length) {
      marks.push([trailStart, line.length, 'ot']);
    }
    if (this.opts.showInvisibles) {
      for (let i = 0; i < line.length; i++) {
        const c = line.charCodeAt(i);
        if (c === 32) marks.push([i, i + 1, 'os']);
        else if (c === 9) marks.push([i, i + 1, 'otab']);
        else if (c === 0xa0 || c === 0x200b || c === 0xfeff || c === 0x3000) marks.push([i, i + 1, 'ou']);
      }
    }
    if (!marks.length) {
      row.textContent = line;
      return;
    }
    // Découpe en segments : chaque caractère prend la classe la plus spécifique.
    const cls: (string | null)[] = new Array(line.length).fill(null);
    for (const [a, b, c] of marks) {
      for (let i = a; i < b && i < line.length; i++) cls[i] = cls[i] ? `${cls[i]} ${c}` : c;
    }
    let i = 0;
    while (i < line.length) {
      let j = i + 1;
      while (j < line.length && cls[j] === cls[i]) j++;
      const part = line.slice(i, j);
      if (cls[i]) row.append(h('span', { class: cls[i]!, text: part }));
      else row.append(part);
      i = j;
    }
    if (this.opts.showInvisibles) row.append(h('span', { class: 'oeol', text: '¶' }));
  }

  destroy(): void {
    this.d.dispose();
    this.measureWrapLater.cancel();
    this.root.remove();
  }
}

function upperBound(arr: Float64Array, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function kindOf(inputType: string): string {
  switch (inputType) {
    case 'insertText':
      return 'type';
    case 'deleteContentBackward':
      return 'delete-back';
    case 'deleteContentForward':
      return 'delete-fwd';
    case 'insertLineBreak':
    case 'insertParagraph':
      return 'newline';
    default:
      return inputType || 'edit';
  }
}

export { lineStartOf, lineEndOf };
