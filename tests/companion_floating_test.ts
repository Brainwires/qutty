// The floating companion (Settings → Companion → Floating): whether a system can float it, where
// clicks go through its window, the position it keeps, where a workspace window draws its
// companion, the request a page sends, the app's one window for it (desktop/companion-window.ts),
// the hub's events routed to it (desktop/workspace-host.ts `hubEventTarget`), and the rest of the
// app not counting it as a window of its own (the Dock's reopen, tray mode).

import { assert, assertEquals } from "@std/assert";
import {
  clickThroughPlan,
  cornerPosition,
  FLOATING_SIZE,
  floatingSupport,
  hitRects,
  insideAny,
  parseFloatPosition,
  windowRequestFrom,
} from "../lib/companion/floating.ts";
import {
  companionOn,
  companionPlace,
  DEFAULT_COMPANION,
  sanitizeCompanion,
  wantsFloatingWindow,
} from "../lib/companion/settings.ts";
import {
  CompanionWindow,
  companionWindow,
  companionWindowOptions,
  isCompanionWindow,
  type OpenedWindow,
} from "../desktop/companion-window.ts";
import {
  hubEventTarget,
  WorkspaceRegistry,
} from "../desktop/workspace-host.ts";
import { dockReopenWindow } from "../desktop/windows.ts";
import { followWindows } from "../desktop/session.ts";
import { workspaceWindow } from "../lib/workspace/windows.ts";
import { fakeExtensionHost, fakeRuntimeWindows } from "./session_helpers.ts";

/** macOS's system WebView on denext's runtime. */
const MAC = {
  transparent: true,
  hitRegion: true,
  clickThrough: true,
  clickThroughForward: true,
  sessionType: null,
  layerShell: false,
};

Deno.test("floating: where the companion can float, and why not", () => {
  assertEquals(floatingSupport(MAC), { ok: true });
  // Off desktop (the browser demo).
  assertEquals(floatingSupport(null), {
    ok: false,
    reason: "Floating needs the desktop app.",
  });
  // CEF / an older runtime: no transparent window.
  const opaque = floatingSupport({ ...MAC, transparent: false });
  assert(!opaque.ok && opaque.reason.includes("transparent"));
  // No way to let clicks through.
  const solid = floatingSupport({
    ...MAC,
    hitRegion: false,
    clickThroughForward: false,
  });
  assert(!solid.ok && solid.reason.includes("clicks through"));
  // Click-through with forwarded moves is enough.
  assertEquals(
    floatingSupport({ ...MAC, hitRegion: false }),
    { ok: true },
  );
  // Linux: X11 floats; Wayland only with layer-shell (KDE Plasma, wlroots), not GNOME.
  assertEquals(floatingSupport({ ...MAC, sessionType: "x11" }), { ok: true });
  const gnome = floatingSupport({ ...MAC, sessionType: "wayland" });
  assert(!gnome.ok && gnome.reason.includes("layer-shell"));
  assertEquals(
    floatingSupport({ ...MAC, sessionType: "wayland", layerShell: true }),
    { ok: true },
  );
});

Deno.test("floating: clicks go through outside the companion's rectangles", () => {
  assertEquals(clickThroughPlan(MAC), "region");
  assertEquals(clickThroughPlan({ ...MAC, hitRegion: false }), "forward");
  assertEquals(
    clickThroughPlan({ ...MAC, hitRegion: false, clickThroughForward: false }),
    "none",
  );
  const rects = hitRects([
    { left: 10.4, top: 20.6, right: 50.2, bottom: 60.1 },
    { left: 5, top: 5, right: 5, bottom: 9 }, // empty: a closed bubble
  ]);
  assertEquals(rects, [{ x: 10, y: 20, width: 41, height: 41 }]);
  assert(insideAny(rects, 10, 20));
  assert(insideAny(rects, 50, 60));
  assert(!insideAny(rects, 51, 30));
  assert(!insideAny(rects, 9, 30));
});

Deno.test("floating: its position is kept, and it starts in the main display's corner", () => {
  assertEquals(parseFloatPosition('{"x":120.4,"y":-30}'), { x: 120, y: -30 });
  assertEquals(parseFloatPosition(null), null);
  assertEquals(parseFloatPosition("nope"), null);
  assertEquals(parseFloatPosition('{"x":"1","y":2}'), null);
  assertEquals(parseFloatPosition('{"x":1e9,"y":2}'), null);
  // The work area of a 1440 x 900 display with a 25 px menu bar.
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  assertEquals(cornerPosition(area), {
    x: 1440 - FLOATING_SIZE.width - 24,
    y: 25 + 875 - FLOATING_SIZE.height - 24,
  });
  // A second display left of the main one; a display smaller than the window.
  assertEquals(
    cornerPosition({ x: -1920, y: 0, width: 1920, height: 1080 }).x,
    -FLOATING_SIZE.width - 24,
  );
  assertEquals(cornerPosition({ x: 0, y: 0, width: 200, height: 200 }), {
    x: 0,
    y: 0,
  });
});

Deno.test("floating: the settings, and where a workspace window draws its companion", () => {
  assertEquals(DEFAULT_COMPANION.floatAllSpaces, true);
  assertEquals(
    sanitizeCompanion({ floatAllSpaces: false }).floatAllSpaces,
    false,
  );
  assertEquals(
    sanitizeCompanion({ floatAllSpaces: "no" }).floatAllSpaces,
    true,
  );
  assertEquals(sanitizeCompanion({ mode: "floating" }).mode, "floating");
  assertEquals(companionOn("floating"), true);
  assertEquals(companionOn("off"), false);

  assertEquals(wantsFloatingWindow("floating", true), true);
  assertEquals(wantsFloatingWindow("floating", false), false);
  assertEquals(wantsFloatingWindow("window", true), false);

  const place = companionPlace;
  const yes = { supported: true, showing: true };
  // Floating, and its window shows it: none in this window.
  assertEquals(place("floating", yes), "floating");
  // While it opens (or if it failed), and where it cannot float: in the window.
  assertEquals(
    place("floating", { supported: true, showing: false }),
    "window",
  );
  assertEquals(
    place("floating", { supported: false, showing: true }),
    "window",
  );
  assertEquals(place("window", yes), "window");
  assertEquals(place("off", yes), "off");
});

Deno.test("floating: a page's request is checked", () => {
  assertEquals(windowRequestFrom({ open: true }), { open: true });
  assertEquals(
    windowRequestFrom({
      open: true,
      allSpaces: false,
      position: { x: 10.2, y: 20 },
    }),
    { open: true, allSpaces: false, position: { x: 10, y: 20 } },
  );
  assertEquals(windowRequestFrom({ open: "yes" }), "open must be a boolean");
  assertEquals(
    windowRequestFrom({ open: true, allSpaces: 1 }),
    "allSpaces must be a boolean",
  );
  assertEquals(
    windowRequestFrom({ open: true, position: { x: "a", y: 1 } }),
    "position must be { x, y } on screen",
  );
});

/** A {@linkcode CompanionWindow} over a fake host: the windows it opened, the states it sent. */
function fakeHost(opts: { fail?: string } = {}) {
  const opened: { options: Record<string, unknown>; win: FakeWindow }[] = [];
  const states: unknown[] = [];
  const cw = new CompanionWindow();
  let n = 0;
  cw.install({
    open: (options) => {
      if (opts.fail) throw new Error(opts.fail);
      const win = fakeWindow(`window-${++n}`);
      opened.push({ options, win });
      return win;
    },
    emit: (state) => void states.push(state),
  });
  return { cw, opened, states };
}

interface FakeWindow extends OpenedWindow {
  closes: number;
  /** The user (or the OS) closed it. */
  closedByUser(): void;
}

function fakeWindow(id: string): FakeWindow {
  const handlers = new Set<() => void>();
  const win: FakeWindow = {
    id,
    closes: 0,
    close: () => {
      win.closes++;
      for (const h of [...handlers]) h();
    },
    onClosed: (h) => {
      handlers.add(h);
      return () => void handlers.delete(h);
    },
    closedByUser: () => {
      for (const h of [...handlers]) h();
    },
  };
  return win;
}

Deno.test("companion window: one for the app; ready routes to it; closed by request or by the OS", () => {
  const { cw, opened, states } = fakeHost();
  assertEquals(cw.state(), { open: false, ready: false });
  // Two workspace windows ask: one window.
  assertEquals(cw.request({ open: true, position: { x: 5, y: 6 } }), {
    open: true,
    ready: false,
  });
  assertEquals(cw.request({ open: true }), { open: true, ready: false });
  assertEquals(opened.length, 1);
  const win = opened[0].win;
  assertEquals(opened[0].options.x, 5);
  assertEquals(opened[0].options.y, 6);
  // Not routed to until its page says it is ready, and only from that window.
  assertEquals(cw.target(), undefined);
  assert(cw.is("window-1"));
  assert(!cw.is("main"));
  assertEquals(cw.ready("main"), false);
  assertEquals(cw.ready("window-1"), true);
  assertEquals(cw.target(), "window-1");
  assertEquals(cw.state(), { open: true, ready: true });
  // A reload of its page: still ready, no new state sent.
  const sent = states.length;
  cw.ready("window-1");
  assertEquals(states.length, sent);
  // In window / Off: closed, and the windows are told.
  assertEquals(cw.request({ open: false }), { open: false, ready: false });
  assertEquals(win.closes, 1);
  assertEquals(cw.target(), undefined);
  assert(!cw.is("window-1"));
  assertEquals(states.at(-1), { open: false, ready: false });
  // Closing again is a no-op.
  cw.request({ open: false });
  assertEquals(win.closes, 1);
  // Opened again, then closed by the OS: forgotten, a new one opens on the next request.
  cw.request({ open: true });
  const again = opened[1].win;
  cw.ready(again.id);
  again.closedByUser();
  assertEquals(cw.state(), { open: false, ready: false });
  cw.request({ open: true });
  assertEquals(opened.length, 3);
});

Deno.test("companion window: a failed open says why; without the hub it cannot open", () => {
  const { cw, states } = fakeHost({ fail: "past desktop.app.maxWindows" });
  assertEquals(cw.request({ open: true }), {
    open: false,
    ready: false,
    error: "past desktop.app.maxWindows",
  });
  assertEquals(states.at(-1), cw.state());
  const bare = new CompanionWindow();
  assertEquals(bare.request({ open: true }), {
    open: false,
    ready: false,
    error: "the hub is not running",
  });
});

Deno.test("companion window: transparent, frameless, non-activating, on top, off the taskbar", () => {
  const o = companionWindowOptions({ open: true });
  assertEquals(o.url, "/companion");
  assertEquals(
    [
      o.frameless,
      o.transparent,
      o.focusable,
      o.alwaysOnTop,
      o.skipTaskbar,
      o.overlay,
      o.resizable,
      o.visibleOnAllWorkspaces,
    ],
    [true, true, false, "floating", true, true, false, true],
  );
  // No key: never in Reopen Closed Window, never restored at launch.
  assertEquals("key" in o, false);
  assertEquals("x" in o, false);
  assertEquals(
    companionWindowOptions({ open: true, allSpaces: false })
      .visibleOnAllWorkspaces,
    false,
  );
});

Deno.test("hub events: with the floating companion showing, every question and message goes to it", () => {
  const r = new WorkspaceRegistry();
  r.join("main", "main");
  r.addPty("main", "pty-1");
  r.join("w2", "ws-2");
  r.addPty("ws-2", "pty-2");
  r.focused("w2");
  const f = "window-9";
  // An agent's question in either window, the companion's own, a say: the floating window.
  assertEquals(hubEventTarget(r, "ask", { from: "pty-1" }, f), { window: f });
  assertEquals(hubEventTarget(r, "ask", { from: "companion" }, f), {
    window: f,
  });
  assertEquals(hubEventTarget(r, "say", {}, f), { window: f });
  // The brain's status and replies: every window (Settings shows the status).
  assertEquals(hubEventTarget(r, "companion", {}, f), {});
  // Commands still go to a window with tiles.
  assertEquals(hubEventTarget(r, "control", {}, f), { window: "w2" });
  assertEquals(hubEventTarget(r, "tiles", {}, f), {});
  assertEquals(hubEventTarget(r, "companionWindow", {}, f), {});
  // A detached workspace's question too (it used to wait for its window).
  r.windowClosed("main");
  assertEquals(hubEventTarget(r, "ask", { from: "pty-1" }, f), { window: f });
  assertEquals(hubEventTarget(r, "ask", { from: "pty-1" }), null);
  // Not showing (or In window): as before.
  assertEquals(hubEventTarget(r, "say", {}), { window: "w2" });
});

Deno.test("the floating companion's window is not one of the app's: the Dock opens a workspace, tray mode follows the workspace windows", async () => {
  const { cw } = fakeHost();
  // The app's shared one, as the extensions see it (installed over a fake host).
  let opened: FakeWindow | undefined;
  companionWindow.install({
    open: () => (opened = fakeWindow("window-7")),
    emit: () => {},
  });
  try {
    companionWindow.request({ open: true });
    assert(isCompanionWindow("window-7"));
    assert(!isCompanionWindow("main"));
    const r = new WorkspaceRegistry();
    r.join("w1", "ws-1");
    r.addPty("ws-1", "p1");
    r.windowClosed("w1");
    // Only the floating companion open: a Dock click brings the workspace back.
    const onlyCompanion = fakeRuntimeWindows([{
      id: "window-7",
      kind: "window",
    }]);
    assertEquals(dockReopenWindow(r, onlyCompanion), workspaceWindow("ws-1"));

    // Tray mode: the companion's window opening is no app window; the last workspace window's
    // close is the last one, with the companion still open.
    const fake = fakeExtensionHost([
      { id: "main", kind: "main", key: "main" },
    ]);
    const seen: string[] = [];
    const off = followWindows(fake.host, {
      windowOpened: () => void seen.push("opened"),
      lastWindowClosed: () => {
        seen.push("last");
        return "tray";
      },
    });
    try {
      seen.length = 0;
      fake.open({ id: "window-7", kind: "window" });
      assertEquals(seen, []);
      await fake.close("main");
      await new Promise((r) => setTimeout(r, 0));
      assertEquals(seen, ["last"]);
    } finally {
      off();
    }
  } finally {
    companionWindow.close();
    assertEquals(opened?.closes, 1);
    cw.close();
  }
});
