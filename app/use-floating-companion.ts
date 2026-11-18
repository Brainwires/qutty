// A workspace window's half of the floating companion (Settings → Companion → Floating): whether
// this system can float it (`floatingSupport` over the runtime's window capabilities: a
// transparent window that lets clicks through; on Wayland a layer-shell surface), the floating
// window asked open while Floating is chosen and supported (or closed otherwise), and whether it
// shows the companion now (`showing`), in which case this window draws none of its own.
//
// The window is one for the app (desktop/companion-window.ts): every workspace window asks, and
// asking again is a no-op. Nothing is asked before the window's settings are loaded (`active`) and
// the support is known, so a new window never closes the floating companion on its way up. The
// position it opens at is where it was last dragged to (the floating page keeps it in storage),
// else the bottom-right corner of the main display. It opens shown, never shown later: showing a
// hidden non-activating window takes the keyboard on macOS (Denext's `show()` makes it key).

import { useEffect, useState } from "denext";
import { getScreens, windowCapabilities } from "denext/desktop/window";
import type { PtyBackend } from "../lib/pty-client.ts";
import type { CompanionMode } from "../lib/companion/protocol.ts";
import {
  cornerPosition,
  FLOAT_POSITION_KEY,
  type FloatingSupport,
  floatingSupport,
  type FloatPosition,
  parseFloatPosition,
} from "../lib/companion/floating.ts";
import { wantsFloatingWindow } from "../lib/companion/settings.ts";

export interface UseFloatingCompanionOptions {
  backend: PtyBackend | null;
  /** The window's settings are loaded: until then nothing is asked. */
  active: boolean;
  /** Running in the desktop app (a browser page cannot float the companion). */
  desktop: boolean;
  mode: CompanionMode;
  /** Settings → Companion → On every Space. */
  allSpaces: boolean;
}

export interface FloatingCompanion {
  /** Whether Floating works here (`null`: not known yet), and why not. */
  support: FloatingSupport | null;
  /** The floating window shows the companion: this window draws none. */
  showing: boolean;
}

/** Where the floating window was last dragged to (none: it starts in a corner). */
function savedPosition(): FloatPosition | null {
  try {
    return parseFloatPosition(
      globalThis.localStorage?.getItem(FLOAT_POSITION_KEY) ?? null,
    );
  } catch {
    return null;
  }
}

/** Where it opens: where it was dragged to, else the main display's bottom-right corner. */
async function openPosition(): Promise<FloatPosition | null> {
  const saved = savedPosition();
  if (saved) return saved;
  const screens = await getScreens().catch(() => []);
  const main = screens.find((s) => s.isPrimary) ?? screens[0];
  return main ? cornerPosition(main.workArea) : null;
}

export function useFloatingCompanion(
  opts: UseFloatingCompanionOptions,
): FloatingCompanion {
  const { backend, active, desktop, mode, allSpaces } = opts;
  const [support, setSupport] = useState<FloatingSupport | null>(null);
  const [showing, setShowing] = useState(false);

  // What this system can do (asked once).
  useEffect(() => {
    if (!active) return;
    if (!desktop) {
      setSupport(floatingSupport(null));
      return;
    }
    let live = true;
    windowCapabilities().then(
      (caps) => live && setSupport(floatingSupport(caps)),
      () => live && setSupport(floatingSupport(null)),
    );
    return () => {
      live = false;
    };
  }, [active, desktop]);

  // Whether the floating window shows the companion: asked on load and again on each change (a
  // replayed event is only a nudge to ask).
  useEffect(() => {
    if (!backend) return;
    let live = true;
    const refresh = () =>
      backend.companionWindowState().then(
        (s) => live && setShowing(s.ready),
        () => {},
      );
    void refresh();
    const off = backend.onCompanionWindow(() => void refresh());
    return () => {
      live = false;
      off();
    };
  }, [backend]);

  // Ask for it open (Floating, where it works) or closed (In window, Off).
  // Closing when it is not open is a no-op too, and the settings every window loads are the same.
  const wants = support !== null && wantsFloatingWindow(mode, support.ok);
  useEffect(() => {
    if (!backend || !active || support === null) return;
    (wants ? openPosition() : Promise.resolve(null)).then((position) =>
      backend.companionWindow({
        open: wants,
        allSpaces,
        ...(position ? { position } : {}),
      })
    ).catch((e) =>
      console.warn("companion: could not open or close its window", e)
    );
  }, [backend, active, support, wants]);

  return { support, showing: wants && showing };
}
