// Émetteur d'événements minimal, avec désabonnement explicite (pas de fuite).

export type Unsubscribe = () => void;

export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<(payload: any) => void>>();

  on<K extends keyof Events>(name: K, fn: (payload: Events[K]) => void): Unsubscribe {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof Events>(name: K, payload: Events[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`Erreur dans un abonné à « ${String(name)} »`, e);
      }
    }
  }
}

/** Regroupe des désabonnements pour les libérer d'un coup. */
export class Disposer {
  private items: Unsubscribe[] = [];
  add(fn: Unsubscribe): void {
    this.items.push(fn);
  }
  listen<K extends keyof HTMLElementEventMap>(
    target: EventTarget,
    type: K | string,
    fn: (e: any) => void,
    opts?: AddEventListenerOptions | boolean,
  ): void {
    target.addEventListener(type, fn, opts);
    this.items.push(() => target.removeEventListener(type, fn, opts));
  }
  dispose(): void {
    for (const f of this.items.splice(0)) f();
  }
}

/** Appel différé regroupant les appels successifs. */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { cancel(): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: A | null = null;
  const wrapped = (...a: A) => {
    last = a;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const args = last!;
      last = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    last = null;
  };
  wrapped.flush = () => {
    if (timer && last) {
      clearTimeout(timer);
      timer = null;
      const args = last;
      last = null;
      fn(...args);
    }
  };
  return wrapped;
}

/** Exécute au plus une fois par image. */
export function rafThrottle(fn: () => void): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn();
    });
  };
}
