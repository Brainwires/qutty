// The skin in use (lib/skins/): the built-ins, the user's skins as the backend lists them, and the
// one Settings picked, applied to the document: `data-skin`, the frame options
// (`data-frame-buttons`, `data-frame-title`, the buttons' order) and, for a user skin, its
// stylesheet.
//
// A built-in skin's stylesheet is always linked (app/layout.tsx) and only waits for `data-skin`.
// A user skin's arrives from the backend already sanitized with its assets inlined; it is checked
// again here (`checkSkin`) and applied as a constructed stylesheet in `document.adoptedStyleSheets`:
// that comes after every linked stylesheet, so a skin's rules win ties with the base ones, and it
// needs no inline `<style>` (which the app's content security policy refuses).
//
// A skin that is missing or fails its checks is not applied: Qutty's own look shows, the setting is
// kept (fixing the skin and "Reload skins" brings it back) and `error` says why.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "denext";
import type { PtyBackend } from "../lib/pty-client.ts";
import {
  checkSkin,
  type Skin,
  type SkinList,
  type SkinManifest,
  type SkinProblem,
  validateManifest,
} from "../lib/skins/skin.ts";
import {
  BUILTIN_SKINS,
  CLASSIC_MANIFEST,
  CLASSIC_PACKAGE,
} from "../lib/skins/builtin.ts";
import {
  applySkin,
  type ResolvedFrame,
  resolveFrame,
  type SkinSettings,
} from "../lib/skins/settings.ts";

/** One skin the picker offers. */
export interface SkinChoice {
  manifest: SkinManifest;
  source: Skin["source"];
}

export interface SkinsApi {
  /** The built-ins, then the user's skins. */
  choices: readonly SkinChoice[];
  /** The user's skin folders that are not usable skins. */
  problems: readonly SkinProblem[];
  /** The skin drawn now: the chosen one, or Qutty's own while that one cannot be used. */
  active: SkinManifest;
  /** The tile frames as drawn (the user's options over the skin's). */
  frame: ResolvedFrame;
  /** Why the chosen skin is not the one drawn (`null`: it is, or it is still loading). */
  error: string | null;
  /** The user's skins folder ("" until the backend said). */
  dir: string;
  /** Whether there is a skins folder here (false until a backend is there). */
  available: boolean;
  /** Read the folder again. */
  reload(): void;
  /** Show the folder in the file manager. */
  openFolder(): Promise<void>;
  /** Copy the Classic skin into the folder as a template; resolves to the copy's id. */
  startFromClassic(): Promise<string>;
}

const QUTTY = BUILTIN_SKINS[0].manifest;

/** The one stylesheet user skins are applied through. */
let sheet: CSSStyleSheet | null = null;

/**
 * Show `css` as the user skin's stylesheet ("" for none), after every linked stylesheet. False
 * when the web view has no constructed stylesheets (an old WebKitGTK): nothing is applied.
 */
function setSkinStylesheet(css: string): boolean {
  try {
    if (!sheet) {
      if (css === "") return true;
      sheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }
    sheet.replaceSync(css);
    return true;
  } catch {
    return false;
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not read ${url}`);
  return await res.text();
}

/** The backend's list with every manifest checked again (one that fails becomes a problem). */
function checkList(l: SkinList): SkinList {
  const out: SkinList = { dir: l.dir, skins: [], problems: [...l.problems] };
  for (const raw of l.skins) {
    const m = validateManifest(raw);
    if (m.ok && !BUILTIN_SKINS.some((b) => b.manifest.id === m.value.id)) {
      out.skins.push(m.value);
    } else {
      out.problems.push({
        folder: String((raw as { id?: unknown })?.id ?? "?").slice(0, 40),
        error: m.ok ? "a built-in skin has this id" : m.error,
      });
    }
  }
  return out;
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export function useSkins(
  backend: PtyBackend | null,
  settings: SkinSettings,
): SkinsApi {
  const client = backend?.skins ?? null;
  const [list, setList] = useState<SkinList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  /** The user skin fetched last, or why it could not be. */
  const [loaded, setLoaded] = useState<
    { id: string; skin?: Skin; error?: string } | null
  >(null);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (!client) return;
    let stale = false;
    client.list().then(
      (l) => {
        if (stale) return;
        setList(checkList(l));
        setListError(null);
      },
      (err) => {
        if (stale) return;
        setList({ dir: "", skins: [], problems: [] });
        setListError(message(err));
      },
    );
    return () => {
      stale = true;
    };
  }, [client, epoch]);

  const builtin = BUILTIN_SKINS.find((s) => s.manifest.id === settings.id);
  const listed = !builtin && !!list?.skins.some((m) => m.id === settings.id);

  // The chosen user skin's stylesheet (again after each reload of the folder).
  useEffect(() => {
    if (!client || !listed) return;
    const id = settings.id;
    let stale = false;
    client.get(id).then(
      (raw) => {
        if (stale) return;
        const r = checkSkin(raw);
        setLoaded(
          r.ok && r.value.manifest.id === id
            ? { id, skin: r.value }
            : { id, error: r.ok ? "the skin's id changed" : r.error },
        );
      },
      (err) => {
        if (!stale) setLoaded({ id, error: message(err) });
      },
    );
    return () => {
      stale = true;
    };
  }, [client, listed, settings.id, list]);

  const user = listed && loaded?.id === settings.id ? loaded : null;
  const active = builtin?.manifest ?? user?.skin?.manifest ?? QUTTY;
  const css = user?.skin?.css ?? "";

  let error: string | null = null;
  if (!builtin && list) {
    const problem = list.problems.find((p) => p.folder === settings.id);
    if (problem) error = problem.error;
    else if (!listed) {
      error = listError ?? `The skin "${settings.id}" was not found.`;
    } else if (user?.error) error = user.error;
  }

  const frame = useMemo(
    () =>
      resolveFrame(active.frame, {
        frameButtons: settings.frameButtons,
        frameTitle: settings.frameTitle,
      }),
    [active, settings.frameButtons, settings.frameTitle],
  );

  // Before the paint, like the theme: the attributes and the stylesheet change together.
  const [unsupported, setUnsupported] = useState(false);
  useLayoutEffect(() => {
    applySkin(document.documentElement, active.id, frame);
    setUnsupported(!setSkinStylesheet(css));
  }, [active.id, frame, css]);
  if (unsupported && !error && css !== "") {
    error = "This system's web view cannot apply a skin's stylesheet.";
  }

  const reload = useCallback(() => setEpoch((n) => n + 1), []);
  const openFolder = useCallback(async () => {
    if (!client) throw new Error("There is no skins folder here.");
    await client.openFolder();
  }, [client]);
  const startFromClassic = useCallback(async () => {
    if (!client) throw new Error("There is no skins folder here.");
    const [manifest, sheetText] = await Promise.all([
      fetchText(`${CLASSIC_PACKAGE}/skin.json`),
      fetchText(`${CLASSIC_PACKAGE}/skin.css`),
    ]);
    const { id } = await client.template({
      id: `my-${CLASSIC_MANIFEST.id}`,
      name: `My ${CLASSIC_MANIFEST.name}`,
      from: CLASSIC_MANIFEST.id,
      manifest,
      css: sheetText,
    });
    setEpoch((n) => n + 1);
    return id;
  }, [client]);

  const choices = useMemo<SkinChoice[]>(
    () => [
      ...BUILTIN_SKINS.map((s) => ({ manifest: s.manifest, source: s.source })),
      ...(list?.skins ?? []).map((manifest) => ({
        manifest,
        source: "user" as const,
      })),
    ],
    [list],
  );

  return {
    choices,
    problems: list?.problems ?? [],
    active,
    frame,
    error,
    dir: list?.dir ?? "",
    available: !!client,
    reload,
    openFolder,
    startFromClassic,
  };
}
