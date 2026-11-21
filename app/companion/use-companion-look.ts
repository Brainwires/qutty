// The look the companion wears (Settings → Companion → Look): the built-in face, or a look from
// the looks folder fetched whole from the backend (desktop/companion-looks.ts) and kept for the
// page's life. "Reload looks" (`reloadLooks`) forgets the kept ones in every window: this one by
// an event, the others (the floating companion's) by a `storage` event, as they follow the
// settings.

import { useEffect, useState } from "denext";
import {
  BUILTIN_LOOK_ID,
  type Look,
  type LooksBackend,
} from "../../lib/companion/looks.ts";

/** The `storage` key "Reload looks" bumps, so every window reads the looks again. */
const RELOAD_KEY = "qutty.companion.looks-reloaded";
/** This window's own reload (a `storage` event only reaches the other windows). */
const RELOAD_EVENT = "qutty:looks-reloaded";

type Fetched = { look: Look } | { error: string };

/** The looks fetched, by id (forgotten on reload). */
const kept = new Map<string, Promise<Fetched>>();

function fetchLook(looks: LooksBackend, id: string): Promise<Fetched> {
  let p = kept.get(id);
  if (!p) {
    p = looks.get(id).catch((e) => ({
      error: e instanceof Error ? e.message : String(e),
    }));
    kept.set(id, p);
  }
  return p;
}

/** Read the looks again, here and in every other window. */
export function reloadLooks(): void {
  kept.clear();
  try {
    localStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch { /* no storage: this window still reloads */ }
  globalThis.dispatchEvent?.(new Event(RELOAD_EVENT));
}

/** A counter that moves whenever the looks are reloaded (here or in another window). */
export function useLooksVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== RELOAD_KEY) return;
      kept.clear();
      bump();
    };
    globalThis.addEventListener(RELOAD_EVENT, bump);
    globalThis.addEventListener("storage", onStorage);
    return () => {
      globalThis.removeEventListener(RELOAD_EVENT, bump);
      globalThis.removeEventListener("storage", onStorage);
    };
  }, []);
  return version;
}

/**
 * Look `id`: `look` once fetched (`null` for the built-in face, while fetching, or when it could
 * not be had), and `error` saying why not.
 */
export function useCompanionLook(
  looks: LooksBackend | undefined,
  id: string | undefined,
): { look: Look | null; error: string | null } {
  const [state, setState] = useState<
    { id: string; look: Look | null; error: string | null }
  >({ id: BUILTIN_LOOK_ID, look: null, error: null });
  const version = useLooksVersion();
  const wanted = id && id !== BUILTIN_LOOK_ID ? id : null;
  useEffect(() => {
    if (!wanted || !looks) {
      setState({ id: BUILTIN_LOOK_ID, look: null, error: null });
      return;
    }
    let live = true;
    void fetchLook(looks, wanted).then((r) => {
      if (!live) return;
      setState(
        "look" in r
          ? { id: wanted, look: r.look, error: null }
          : { id: wanted, look: null, error: r.error },
      );
    });
    return () => {
      live = false;
    };
  }, [looks, wanted, version]);
  return state.id === wanted
    ? { look: state.look, error: state.error }
    : { look: null, error: null };
}
