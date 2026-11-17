/**
 * A value kept on its own localStorage key and followed across the app's windows, as the
 * workspace settings are (lib/workspace/store.ts `saveSettings` / `loadSettings`, and the
 * window's `storage` event in app/workspace.tsx): the bookmarks, the visited pages, the per-site
 * zoom (lib/web/bookmarks.ts, visits.ts, zoom.ts).
 *
 * Every window shares the page's origin, so they share localStorage: a `set` in one window
 * writes the key, and the others hear the `storage` event and read it back (checked by
 * `sanitize`, like anything stored). Read lazily on first use; a failing storage (private mode,
 * quota) keeps the value in memory for this window.
 *
 * Client-safe: storage and the event target are injected, so tests run without a DOM.
 *
 * @module
 */

/** The storage it uses (localStorage, or a stub). */
export interface SyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Where the other windows' writes are heard (the window). */
export interface SyncEvents {
  addEventListener(
    type: "storage",
    fn: (e: { key: string | null }) => void,
  ): void;
  removeEventListener(
    type: "storage",
    fn: (e: { key: string | null }) => void,
  ): void;
}

export interface SyncedStore<T> {
  get(): T;
  /** Replace the value: saved, and every listener here hears it. */
  set(next: T): void;
  /** Follow the value (this window's sets and the other windows'); returns the unsubscribe. */
  subscribe(fn: (value: T) => void): () => void;
}

function defaults(): { storage?: SyncStorage; events?: SyncEvents } {
  try {
    const g = globalThis as {
      localStorage?: SyncStorage;
      addEventListener?: unknown;
    };
    return {
      storage: g.localStorage,
      events: typeof g.addEventListener === "function"
        ? (globalThis as unknown as SyncEvents)
        : undefined,
    };
  } catch {
    return {};
  }
}

/** A value on `key`, read through `sanitize` (which gets `undefined` for nothing stored). */
export function syncedStore<T>(
  key: string,
  sanitize: (raw: unknown) => T,
  env: { storage?: SyncStorage | null; events?: SyncEvents | null } =
    defaults(),
): SyncedStore<T> {
  let value: T | undefined;
  /** The stored text `value` came from (or was saved as): a read of the same text keeps it. */
  let seen: string | null | undefined;
  const listeners = new Set<(value: T) => void>();
  const read = (): T => {
    let text: string | null | undefined = null;
    try {
      text = env.storage?.getItem(key);
    } catch { /* unreadable: the default */ }
    if (value !== undefined && text === seen) return value;
    seen = text;
    let raw: unknown = undefined;
    try {
      if (text) raw = JSON.parse(text);
    } catch { /* unreadable: the default */ }
    return value = sanitize(raw);
  };
  const emit = () => {
    for (const fn of [...listeners]) fn(value!);
  };
  const onStorage = (e: { key: string | null }) => {
    // `null`: the whole storage was cleared.
    if (e.key !== key && e.key !== null) return;
    const was = value;
    if (read() !== was) emit();
  };
  return {
    // Unfollowed, another window's write is unheard: the stored text is looked at again (the
    // same text keeps the same value, so a render that reads it sees one object).
    get: () => listeners.size > 0 && value !== undefined ? value : read(),
    set(next) {
      if (next === value) return;
      value = next;
      if (seen === undefined) {
        // What is stored now: a failed write leaves it, and a read then keeps `next`.
        try {
          seen = env.storage?.getItem(key) ?? null;
        } catch {
          seen = null;
        }
      }
      try {
        const text = JSON.stringify(next);
        env.storage?.setItem(key, text);
        seen = text;
      } catch { /* kept in memory: the stored text is still the old one */ }
      emit();
    },
    subscribe(fn) {
      if (listeners.size === 0) {
        env.events?.addEventListener("storage", onStorage);
      }
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0) {
          env.events?.removeEventListener("storage", onStorage);
        }
      };
    },
  };
}
