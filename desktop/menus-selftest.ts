// `QUTTY_PTY_SELFTEST=menus`: a check of the native menu bar in the packaged app (desktop.ts runs
// it once the app is up). It sets the custom menus again (lib/workspace/menus.ts, as
// desktop/menus.ts did at launch) and waits for the main window's page to add its own part
// (app/use-native-menus.ts: the app menu with Settings…, the window's state and its tiles in the
// Window menu). It reads the main window's bar back from the OS (Denext 4.22's
// `getApplicationMenu("main")`, where the runtime has the read-back: `menuSnapshot`), and also
// the Dock menu (`getDockMenu()`, macOS). On a runtime without the read-back it reads what Denext
// hands the runtime instead, by wrapping the main window's `setApplicationMenu` (and the
// app-level one, macOS). Then it logs the bar, checks the parts that matter, and the app exits (1
// on failure).
//
// Run it headless under a temporary HOME, so no window shows and the user's app folder and saved
// windows are untouched:
//
//   HOME=$(mktemp -d) QUTTY_PTY_SELFTEST=menus DENEXT_DESKTOP_HEADLESS=1 LAUFEY_HEADLESS=1 \
//     LAUFEY_ACTIVATION_POLICY=accessory Qutty.app/Contents/MacOS/laufey_webview

import type { DesktopRuntime, MenuSnapshotItem } from "denext/desktop";
import { customMenus, ITEM } from "../lib/workspace/menus.ts";
import { MDI_ITEM_IDS } from "../lib/workspace/mdi-menu.ts";

const TIMEOUT_MS = 45_000;

/** A native menu entry as Denext hands it to the runtime. */
type NativeEntry =
  | "separator"
  | { role: { role: string } }
  | { submenu: { label: string; items: NativeEntry[] } }
  | {
    item: {
      id: string;
      label: string;
      enabled?: boolean;
      checked?: boolean;
      accelerator?: string;
    };
  };

type MenuSetter = { setApplicationMenu?: (menu: NativeEntry[]) => void };

/** Wrap `target.setApplicationMenu` so each menu it is given is kept in `into`. */
function capture(target: unknown, into: { bar?: NativeEntry[] }): boolean {
  const t = target as MenuSetter | undefined;
  const set = t?.setApplicationMenu;
  if (typeof set !== "function") return false;
  t!.setApplicationMenu = (menu) => {
    into.bar = menu;
    return set.call(t, menu);
  };
  return true;
}

/**
 * A menu read back from the OS (`getApplicationMenu`, `getDockMenu`: Denext's
 * `MenuSnapshotItem`s) in the shape the checks read. An accelerator comes back canonical
 * (`Super+T` for ⌘T on macOS, `Ctrl+T` elsewhere); hidden items are left out.
 */
export function snapshotEntries(
  snapshot: readonly MenuSnapshotItem[],
): NativeEntry[] {
  return snapshot.filter((s) => s.visible !== false).map((s): NativeEntry => {
    if (s.type === "separator") return "separator";
    if (s.type === "submenu") {
      return {
        submenu: { label: s.label, items: snapshotEntries(s.submenu ?? []) },
      };
    }
    if (s.role && !s.id) return { role: { role: s.role } };
    return {
      item: {
        id: s.id ?? "",
        label: s.label,
        enabled: s.enabled,
        checked: s.checked,
        ...(s.accelerator ? { accelerator: s.accelerator } : {}),
      },
    };
  });
}

/** Whether `accelerator` is ⌘T / Ctrl+T, as Denext is given it or as the OS reads it back. */
export function isNewTileKey(accelerator: string | undefined): boolean {
  return accelerator === "CmdOrCtrl+T" || accelerator === "Super+T" ||
    accelerator === "Ctrl+T";
}

/** The bar as text, one entry per line (custom ids without Denext's prefixes). */
export function renderMenu(
  entries: readonly NativeEntry[],
  depth = 0,
): string[] {
  const pad = "  ".repeat(depth);
  return entries.flatMap((e): string[] => {
    if (e === "separator") return [`${pad}----`];
    if ("role" in e) return [`${pad}<${e.role.role}>`];
    if ("submenu" in e) {
      return [
        `${pad}${e.submenu.label} >`,
        ...renderMenu(e.submenu.items, depth + 1),
      ];
    }
    const i = e.item;
    const id = i.id.replace(/^denext:menu:/, "").replace(
      /^denext:window:app:[^:]*:/,
      "",
    );
    return [
      `${pad}${i.checked ? "[x] " : ""}${i.label}${
        i.accelerator ? `  ${i.accelerator}` : ""
      }${i.enabled === false ? "  (disabled)" : ""}  {${id}}`,
    ];
  });
}

/** Every item of `entries` (all levels). */
function items(
  entries: readonly NativeEntry[],
): Extract<NativeEntry, { item: unknown }>["item"][] {
  return entries.flatMap((e) =>
    e === "separator" || "role" in e
      ? []
      : "submenu" in e
      ? items(e.submenu.items)
      : [e.item]
  );
}

/** What is missing from the bar (empty: the page has added its part and it all checks out). */
function problems(bar: readonly NativeEntry[], os: string): string[] {
  const all = items(bar);
  const find = (id: string) =>
    all.find((i) => i.id === `denext:menu:${id}` || i.id === id);
  const out: string[] = [];
  const top = bar.flatMap((e) =>
    typeof e === "object" && "submenu" in e ? [e.submenu.label] : []
  );
  for (const label of ["Shell", "View", "Window", "Help"]) {
    if (!top.includes(label)) out.push(`no ${label} menu`);
  }
  if (os === "darwin" && !top.includes("Edit")) out.push("no Edit menu");
  if (os === "darwin" && !all.some((i) => i.id === ITEM.settings)) {
    out.push("no Settings… in the app menu (the page's setAppMenu)");
  }
  if (!isNewTileKey(find(ITEM.newTile)?.accelerator)) {
    out.push("New Tile has no ⌘T");
  }
  const tiled = find(MDI_ITEM_IDS.viewTiled);
  const freeform = find(MDI_ITEM_IDS.viewFreeform);
  if (!tiled?.checked || freeform?.checked) {
    out.push("the view's radio check is not Tiled");
  }
  if (find(ITEM.restoreTile)?.enabled !== false) {
    out.push("Restore Tile is enabled with nothing maximized");
  }
  if (!all.some((i) => i.id.startsWith("denext:menu:qutty:launch:shell:"))) {
    out.push("no shell in New Tile With (the page's setMenu)");
  }
  if (!all.some((i) => i.id.startsWith("denext:window:app:") && i.checked)) {
    out.push(
      "no tile in the Window menu, checked as focused (the page's setWindowMenuAppItems)",
    );
  }
  return out;
}

export async function menusSelfTest(app: DesktopRuntime): Promise<void> {
  const log = (m: string) => console.error(`menus self-test: ${m}`);
  const deadline = Date.now() + TIMEOUT_MS;
  const sleep = () => new Promise((r) => setTimeout(r, 200));
  while (!app.windows.get("main")) {
    if (Date.now() > deadline) throw new Error("no main window");
    await sleep();
  }
  log("main window is up");
  const main: { bar?: NativeEntry[] } = {};
  const appLevel: { bar?: NativeEntry[] } = {};
  if (!capture(app.window, main)) {
    throw new Error("the main window has no setApplicationMenu");
  }
  const api = (Deno as unknown as { desktop?: unknown }).desktop;
  log(
    `app-level menu: ${
      capture(api, appLevel) ? "wrapped" : "none on this runtime"
    }`,
  );
  // The custom menus again (desktop/menus.ts set them at launch): the bars are built anew.
  const platform = Deno.build.os === "darwin" ? "mac" : "other";
  for (const { id, menu } of customMenus(platform)) app.setMenu(id, menu);
  // The bar as the OS holds it, where the runtime reads it back; else as Denext handed it over.
  const readBack = (): NativeEntry[] | undefined => {
    try {
      const snapshot = app.getApplicationMenu("main");
      return snapshot ? snapshotEntries(snapshot) : undefined;
    } catch {
      return undefined;
    }
  };
  let left = ["no menu bar yet"];
  let bar: NativeEntry[] | undefined;
  let source = "as handed to the runtime";
  while (Date.now() < deadline) {
    const read = readBack();
    if (read) source = "read back from the OS";
    bar = read ?? main.bar;
    left = bar ? problems(bar, Deno.build.os) : left;
    if (left.length === 0) break;
    await sleep();
  }
  log(
    `the main window's menu bar (${source}):\n${
      renderMenu(bar ?? []).join("\n")
    }`,
  );
  if (Deno.build.os === "darwin") {
    const dock = app.getDockMenu();
    log(
      dock
        ? `the Dock menu:\n${renderMenu(snapshotEntries(dock)).join("\n")}`
        : "the Dock menu: no read-back on this runtime",
    );
  }
  if (appLevel.bar) {
    const tops = appLevel.bar.flatMap((e) =>
      typeof e === "object" && "submenu" in e ? [e.submenu.label] : []
    );
    log(`the app-level bar (no window key): ${tops.join(" | ")}`);
  }
  if (left.length > 0) throw new Error(left.join("; "));
  log("OK");
}
