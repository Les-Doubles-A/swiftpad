// Historique d'annulation propre à chaque document.
//
// Chromium partage une seule pile d'annulation pour toute la page : avec
// plusieurs onglets, Ctrl+Z pouvait annuler une modification d'un autre
// document (vérifié, voir docs/decisions.md). SwiftPad bloque donc
// l'annulation native et gère sa propre pile, par document.

import type { Edit } from './text';

export type Sel = [number, number];

export interface Step {
  id: number;
  edits: Edit[];
  selBefore: Sel;
  selAfter: Sel;
  kind: string;
  time: number;
}

const MERGE_MS = 1000;
const MERGE_MAX = 64;

function size(e: Edit): number {
  return e.removed.length + e.inserted.length;
}

export class History {
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private nextId = 1;
  private chars = 0;
  private savedId = 0;
  maxSteps = 2000;
  maxChars = 48 * 1024 * 1024;

  currentId(): number {
    return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].id : 0;
  }

  isDirty(): boolean {
    return this.currentId() !== this.savedId;
  }

  markSaved(): void {
    this.savedId = this.currentId();
  }

  /** État enregistré inconnu (document jamais enregistré, rechargé…). */
  markUnsaved(): void {
    this.savedId = -1;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(saved = true): void {
    this.undoStack = [];
    this.redoStack = [];
    this.chars = 0;
    this.savedId = saved ? 0 : -1;
  }

  record(edit: Edit, kind: string, selBefore: Sel, selAfter: Sel, now = Date.now()): void {
    if (edit.removed.length === 0 && edit.inserted.length === 0) return;
    for (const s of this.redoStack) for (const e of s.edits) this.chars -= size(e);
    this.redoStack = [];
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && top.id !== this.savedId && this.canMerge(top, edit, kind, now)) {
      const last = top.edits[top.edits.length - 1];
      this.chars -= size(last);
      if (kind === 'type') {
        last.inserted += edit.inserted;
      } else if (kind === 'delete-back') {
        last.start = edit.start;
        last.removed = edit.removed + last.removed;
      } else {
        last.removed += edit.removed;
      }
      this.chars += size(last);
      top.selAfter = selAfter;
      top.time = now;
      top.id = this.nextId++;
      return;
    }
    this.undoStack.push({ id: this.nextId++, edits: [{ ...edit }], selBefore, selAfter, kind, time: now });
    this.chars += size(edit);
    this.enforceLimits();
  }

  /** Enregistre un groupe de modifications (déjà appliquées dans l'ordre). */
  recordGroup(edits: Edit[], kind: string, selBefore: Sel, selAfter: Sel): void {
    const list = edits.filter((e) => e.removed.length || e.inserted.length);
    if (!list.length) return;
    for (const s of this.redoStack) for (const e of s.edits) this.chars -= size(e);
    this.redoStack = [];
    this.undoStack.push({ id: this.nextId++, edits: list.map((e) => ({ ...e })), selBefore, selAfter, kind, time: Date.now() });
    for (const e of list) this.chars += size(e);
    this.enforceLimits();
  }

  private canMerge(top: Step, edit: Edit, kind: string, now: number): boolean {
    if (top.kind !== kind || now - top.time > MERGE_MS || top.edits.length !== 1) return false;
    const last = top.edits[0];
    if (kind === 'type') {
      return (
        edit.removed === '' &&
        last.removed === '' &&
        edit.start === last.start + last.inserted.length &&
        !edit.inserted.includes('\n') &&
        last.inserted.length + edit.inserted.length <= MERGE_MAX
      );
    }
    if (kind === 'delete-back') {
      return edit.inserted === '' && last.inserted === '' && edit.start + edit.removed.length === last.start && last.removed.length < MERGE_MAX;
    }
    if (kind === 'delete-fwd') {
      return edit.inserted === '' && last.inserted === '' && edit.start === last.start && last.removed.length < MERGE_MAX;
    }
    return false;
  }

  private enforceLimits(): void {
    while (this.undoStack.length > 1 && (this.undoStack.length > this.maxSteps || this.chars > this.maxChars)) {
      const dropped = this.undoStack.shift()!;
      for (const e of dropped.edits) this.chars -= size(e);
      if (dropped.id === this.savedId) this.savedId = -1;
    }
  }

  /** Retire la dernière étape (pour l'appliquer à l'envers). */
  undo(): Step | null {
    const s = this.undoStack.pop();
    if (!s) return null;
    this.redoStack.push(s);
    return s;
  }

  redo(): Step | null {
    const s = this.redoStack.pop();
    if (!s) return null;
    this.undoStack.push(s);
    return s;
  }

  stats(): { steps: number; redo: number; chars: number } {
    return { steps: this.undoStack.length, redo: this.redoStack.length, chars: this.chars };
  }
}
