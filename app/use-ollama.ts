// The Ollama helper's tracking (desktop/ollama.ts through the backend): the status (installed,
// server, pulled and loaded models, installed harnesses), read every few seconds while the `+`
// menu, the Ollama dialog or Settings → Ollama is open and every 30 s otherwise; what changed
// between readings (models added, removed or pulled again); and the library's "new" count:
// models updated on ollama.com since the user last looked, checked at most every few hours
// (the backend caches the page for as long).

import { useCallback, useEffect, useRef, useState } from "denext";
import type { PtyBackend } from "../lib/pty-client.ts";
import {
  diffModels,
  emptyStatus,
  hasChanges,
  type ModelChanges,
  type OllamaStatus,
} from "../lib/ollama/cli.ts";
import { LIBRARY_TTL_MS, newSince } from "../lib/ollama/library.ts";

/** How often the status is read while something shows it, and in the background. */
const ACTIVE_MS = 5_000;
const BACKGROUND_MS = 30_000;

export interface OllamaTracking {
  status: OllamaStatus;
  /** The status has been read at least once. */
  loaded: boolean;
  /** The last change seen between two readings (and when), until the next one. */
  changes: (ModelChanges & { at: number }) | null;
  /** Library models updated since the user last looked (0 before the first look). */
  newCount: number;
  /** Read the status now. */
  refresh(): void;
}

export function useOllama(
  backend: PtyBackend | null,
  opts: { active: boolean; lookedAt: number | null },
): OllamaTracking {
  const [status, setStatus] = useState<OllamaStatus>(() => emptyStatus());
  const [loaded, setLoaded] = useState(false);
  const [changes, setChanges] = useState<OllamaTracking["changes"]>(null);
  const [newCount, setNewCount] = useState(0);
  const lastRef = useRef<OllamaStatus | null>(null);

  const refresh = useCallback(() => {
    if (!backend) return;
    void backend.ollamaStatus().then((s) => {
      const before = lastRef.current;
      lastRef.current = s;
      if (before?.serverUp && s.serverUp) {
        const c = diffModels(before.models, s.models);
        if (hasChanges(c)) setChanges({ ...c, at: Date.now() });
      }
      setStatus(s);
      setLoaded(true);
    }, () => {});
  }, [backend]);

  useEffect(() => {
    if (!backend) return;
    refresh();
    const t = setInterval(refresh, opts.active ? ACTIVE_MS : BACKGROUND_MS);
    return () => clearInterval(t);
  }, [backend, opts.active, refresh]);

  // The library's newest models, against the last look (only once Ollama is known installed).
  const installed = status.installed;
  const lookedAt = opts.lookedAt;
  useEffect(() => {
    if (!backend || !installed) return;
    let live = true;
    const check = () =>
      void backend.ollamaLibrary("", { order: "newest" }).then((r) => {
        if (live) setNewCount(newSince(r.models, lookedAt).length);
      }, () => {});
    check();
    const t = setInterval(check, LIBRARY_TTL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [backend, installed, lookedAt]);

  return { status, loaded, changes, newCount, refresh };
}
