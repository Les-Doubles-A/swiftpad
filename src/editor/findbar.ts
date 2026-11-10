// Barre de recherche et de remplacement du document actif.

import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { buildRegex, findNext, findPrev, countMatches, expandReplacement, replaceAllIn, type FindOptions } from './find';
import type { TextView } from './textview';
import { debounce } from '../core/events';

const COUNT_CAP = 100_000;

export class FindBar {
  readonly root: HTMLElement;
  private input: HTMLInputElement;
  private replaceInput: HTMLInputElement;
  private counter: HTMLElement;
  private error: HTMLElement;
  private replaceRow: HTMLElement;
  private toggles: Record<'caseSensitive' | 'wholeWord' | 'regex', HTMLButtonElement>;
  private opts: FindOptions = { query: '', caseSensitive: false, wholeWord: false, regex: false };
  private re: RegExp | null = null;
  private countToken = 0;
  private view: () => TextView | null;
  private onCloseCb: () => void;
  private recountLater = debounce(() => void this.recount(), 250);
  private searchLater = debounce(() => this.search(true), 150);

  constructor(getView: () => TextView | null, onClose: () => void) {
    this.view = getView;
    this.onCloseCb = onClose;
    const mkToggle = (key: 'caseSensitive' | 'wholeWord' | 'regex', ic: string, label: string, shortcut: string) => {
      const b = h('button', { class: 'tb-btn toggle', type: 'button', title: `${label} (${shortcut})`, attrs: { 'aria-pressed': 'false', 'aria-label': label } }, icon(ic));
      b.addEventListener('click', () => {
        this.opts[key] = !this.opts[key];
        b.setAttribute('aria-pressed', String(this.opts[key]));
        this.search(true);
        this.input.focus();
      });
      return b;
    };
    this.toggles = {
      caseSensitive: mkToggle('caseSensitive', 'caseSensitive', 'Respecter la casse', 'Alt+C'),
      wholeWord: mkToggle('wholeWord', 'wholeWord', 'Mot entier', 'Alt+W'),
      regex: mkToggle('regex', 'regex', 'Expression régulière', 'Alt+R'),
    };
    this.input = h('input', { class: 'input find-input', type: 'text', placeholder: 'Rechercher', attrs: { 'aria-label': 'Rechercher', spellcheck: 'false', autocomplete: 'off' } });
    this.replaceInput = h('input', { class: 'input find-input', type: 'text', placeholder: 'Remplacer par', attrs: { 'aria-label': 'Remplacer par', spellcheck: 'false', autocomplete: 'off' } });
    this.counter = h('span', { class: 'find-count', attrs: { 'aria-live': 'polite' } });
    this.error = h('div', { class: 'find-error', role: 'alert', hidden: true });
    const btn = (ic: string, label: string, fn: () => void) => {
      const b = h('button', { class: 'tb-btn', type: 'button', title: label, attrs: { 'aria-label': label } }, icon(ic));
      b.addEventListener('click', fn);
      return b;
    };
    const replaceBtn = h('button', { class: 'btn btn-small', type: 'button', text: 'Remplacer' });
    replaceBtn.addEventListener('click', () => this.replaceOne());
    const replaceAllBtn = h('button', { class: 'btn btn-small', type: 'button', text: 'Tout remplacer' });
    replaceAllBtn.addEventListener('click', () => this.replaceAll());
    this.replaceRow = h('div', { class: 'find-row' }, this.replaceInput, replaceBtn, replaceAllBtn);
    this.root = h(
      'div',
      { class: 'findbar', role: 'search', hidden: true, attrs: { 'aria-label': 'Rechercher dans le document' } },
      h(
        'div',
        { class: 'find-row' },
        this.input,
        this.toggles.caseSensitive,
        this.toggles.wholeWord,
        this.toggles.regex,
        this.counter,
        btn('arrowUp', 'Précédent (Maj+F3)', () => this.prev()),
        btn('arrowDown', 'Suivant (F3)', () => this.next()),
        btn('close', 'Fermer (Échap)', () => this.close()),
      ),
      this.replaceRow,
      this.error,
    );
    this.input.addEventListener('input', () => {
      this.opts.query = this.input.value;
      const v = this.view();
      if (v && v.getText().length > 1024 * 1024) this.searchLater();
      else this.search(true);
    });
    const keys = (e: KeyboardEvent, isReplace: boolean) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (isReplace) {
          if (e.ctrlKey && e.altKey) this.replaceAll();
          else this.replaceOne();
        } else if (e.shiftKey) this.prev();
        else this.next();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      } else if (e.altKey && !e.ctrlKey) {
        const map: Record<string, 'caseSensitive' | 'wholeWord' | 'regex'> = { c: 'caseSensitive', w: 'wholeWord', r: 'regex' };
        const k = map[e.key.toLowerCase()];
        if (k) {
          e.preventDefault();
          this.toggles[k].click();
        }
      }
    };
    this.input.addEventListener('keydown', (e) => keys(e, false));
    this.replaceInput.addEventListener('keydown', (e) => keys(e, true));
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  open(replace: boolean): void {
    const v = this.view();
    this.root.hidden = false;
    this.replaceRow.hidden = !replace;
    this.root.classList.toggle('with-replace', replace);
    if (v) {
      const [s, e] = v.getSelection();
      const sel = v.getText().slice(s, e);
      if (sel && !sel.includes('\n') && sel.length < 200) {
        this.input.value = this.opts.regex ? sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : sel;
        this.opts.query = this.input.value;
      }
    }
    (replace && this.input.value ? this.replaceInput : this.input).focus();
    this.input.select();
    this.search(false);
  }

  close(): void {
    this.root.hidden = true;
    this.countToken++;
    const v = this.view();
    v?.setHighlight(null);
    v?.setActiveMatch(null);
    this.onCloseCb();
    v?.focus();
  }

  /** Le document actif a changé (onglet, contenu). */
  refresh(): void {
    if (!this.isOpen()) return;
    this.rebuild();
    this.recountLater();
  }

  private rebuild(): boolean {
    const { re, error } = buildRegex(this.opts);
    this.re = re;
    this.error.hidden = !error;
    this.error.textContent = error ?? '';
    this.input.setAttribute('aria-invalid', error ? 'true' : 'false');
    const v = this.view();
    v?.setHighlight(re ? new RegExp(re.source, re.flags) : null);
    return !!re;
  }

  /** Nouvelle requête : sélectionne l'occurrence à partir du début de la sélection. */
  private search(incremental: boolean): void {
    const v = this.view();
    if (!this.rebuild() || !v) {
      this.counter.textContent = this.opts.query && !this.error.hidden ? '' : '';
      v?.setActiveMatch(null);
      return;
    }
    const [s] = v.getSelection();
    const m = findNext(v.getText(), this.re!, incremental ? s : v.getSelection()[1], true);
    if (m) this.select(m.start, m.end);
    else v.setActiveMatch(null);
    void this.recount();
  }

  private select(start: number, end: number): void {
    const v = this.view()!;
    v.setSelection(start, end, true);
    v.setActiveMatch([start, end]);
  }

  next(): void {
    const v = this.view();
    if (!v) return;
    if (!this.re && !this.rebuild()) {
      this.open(false);
      return;
    }
    const [, e] = v.getSelection();
    const m = findNext(v.getText(), this.re!, e, true);
    if (!m) {
      this.counter.textContent = 'Aucun résultat';
      return;
    }
    this.select(m.start, m.end);
    if (m.wrapped) this.flash('Reprise au début');
    void this.recount();
  }

  prev(): void {
    const v = this.view();
    if (!v) return;
    if (!this.re && !this.rebuild()) {
      this.open(false);
      return;
    }
    const [s] = v.getSelection();
    const m = findPrev(v.getText(), this.re!, s, true);
    if (!m) {
      this.counter.textContent = 'Aucun résultat';
      return;
    }
    this.select(m.start, m.end);
    if (m.wrapped) this.flash('Reprise à la fin');
    void this.recount();
  }

  private flash(msg: string): void {
    this.counter.dataset.flash = msg;
    setTimeout(() => {
      if (this.counter.dataset.flash === msg) delete this.counter.dataset.flash;
    }, 1500);
  }

  private async recount(): Promise<void> {
    const v = this.view();
    if (!v || !this.re) {
      this.counter.textContent = '';
      return;
    }
    const token = ++this.countToken;
    const [s] = v.getSelection();
    const re = new RegExp(this.re.source, this.re.flags);
    const r = await countMatches(v.getText(), re, COUNT_CAP, () => token !== this.countToken, s);
    if (!r || token !== this.countToken) return;
    if (r.total === 0) this.counter.textContent = 'Aucun résultat';
    else {
      const tot = r.capped ? `${COUNT_CAP.toLocaleString('fr-FR')}+` : r.total.toLocaleString('fr-FR');
      this.counter.textContent = r.activeIndex ? `${r.activeIndex.toLocaleString('fr-FR')} sur ${tot}` : `${tot} résultat${r.total > 1 ? 's' : ''}`;
    }
  }

  /** La sélection correspond-elle exactement à une occurrence ? */
  private selectedMatch(): RegExpExecArray | null {
    const v = this.view();
    if (!v || !this.re) return null;
    const [s, e] = v.getSelection();
    if (s === e) return null;
    const sticky = new RegExp(this.re.source, this.re.flags.replace('g', '') + 'y');
    sticky.lastIndex = s;
    const m = sticky.exec(v.getText());
    return m && m.index === s && m[0].length === e - s ? m : null;
  }

  replaceOne(): void {
    const v = this.view();
    if (!v || !this.rebuild()) return;
    const m = this.selectedMatch();
    if (!m) {
      this.next();
      return;
    }
    const [s, e] = v.getSelection();
    const rep = expandReplacement(this.replaceInput.value, m, this.opts.regex);
    if (!v.replaceRange(s, e, rep, [s + rep.length, s + rep.length], 'replace')) {
      this.counter.textContent = 'Document en lecture seule';
      return;
    }
    this.next();
  }

  replaceAll(): void {
    const v = this.view();
    if (!v || !this.rebuild()) return;
    const r = replaceAllIn(v.getText(), new RegExp(this.re!.source, this.re!.flags), this.replaceInput.value, this.opts.regex);
    if (!r) {
      this.counter.textContent = 'Aucun résultat';
      return;
    }
    if (!v.replaceRange(r.start, r.end, r.insert, [r.start, r.start + r.insert.length], 'replace-all')) {
      this.counter.textContent = 'Document en lecture seule';
      return;
    }
    this.counter.textContent = `${r.count.toLocaleString('fr-FR')} remplacement${r.count > 1 ? 's' : ''}`;
    this.countToken++;
  }

  getOptions(): FindOptions {
    return { ...this.opts };
  }
}
