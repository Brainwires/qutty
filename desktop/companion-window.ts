// The floating companion's window (Settings → Companion → Floating): one for the app, opened and
// closed here, in the app's process, whatever workspace window asks. Its page
// (app/companion/floating-companion.tsx, the `/companion` route) is a transparent, frameless,
// non-activating window on top of the others that lets clicks through outside the companion; once
// it says it is ready (`ready`), the hub sends it the companion's bubbles and every question
// (desktop/workspace-host.ts `hubEventTarget`), and the workspace windows hide their own companion.
//
// - Every workspace window asks for it while Floating is chosen (and closes it for In window or
//   Off), so asking again is a no-op, and two windows asking at once open one.
// - It has no window key: it is never in Reopen Closed Window and the session restored at launch
//   does not reopen it (the first workspace window asks for it again). Its position is the page's
//   to keep (where it was dragged to, lib/companion/floating.ts).
// - It is not an app window for the rest of the app: tray mode, the Dock's reopen and tile moves
//   ignore it ({@linkcode isCompanionWindow}). With every workspace window closed it stays (the
//   app lives in the tray while terminals run, and the companion still answers questions); when
//   the app quits it goes with it.
//
// No runtime API is used here: the host's `openWindow` is handed in ({@linkcode
// CompanionWindow.install}), so the whole thing is tested without a window
// (tests/companion_floating_test.ts).

import {
  type CompanionWindowRequest,
  type CompanionWindowState,
  FLOATING_SIZE,
} from "../lib/companion/floating.ts";

/** The route the floating companion's page is. */
export const COMPANION_WINDOW_URL = "/companion";

/** The window `openWindow` gave back (a `DesktopWindowRef` slice). */
export interface OpenedWindow {
  readonly id: string;
  close(): void;
  onClosed(handler: () => void): () => void;
}

/** What {@linkcode CompanionWindow} acts through. */
export interface CompanionWindowDeps {
  /** Open a window (`host.openWindow`); throws when it cannot. */
  open(options: Record<string, unknown>): OpenedWindow;
  /** Tell every window the new state (the hub's `companionWindow` event). */
  emit(state: CompanionWindowState): void;
}

/** The options the floating window opens with. */
export function companionWindowOptions(
  request: CompanionWindowRequest,
): Record<string, unknown> {
  const all = request.allSpaces !== false;
  return {
    url: COMPANION_WINDOW_URL,
    title: "Companion",
    width: FLOATING_SIZE.width,
    height: FLOATING_SIZE.height,
    ...(request.position
      ? { x: request.position.x, y: request.position.y }
      : {}),
    resizable: false,
    frameless: true,
    transparent: true,
    // A non-activating panel: showing it or clicking its bubble never takes the keyboard from the
    // terminal; the page takes it only for its chat box (`focusWindow`).
    focusable: false,
    alwaysOnTop: "floating",
    skipTaskbar: true,
    visibleOnAllWorkspaces: all,
    // Linux Wayland: a layer-shell surface, the only window that stays on top there.
    overlay: true,
    // Its blinks and moves keep their pace while the window is covered.
    backgroundThrottling: false,
  };
}

/** The floating companion's window: see the module comment. */
export class CompanionWindow {
  #deps: CompanionWindowDeps | undefined;
  #window: OpenedWindow | undefined;
  #ready = false;
  #error: string | undefined;
  #offClosed: (() => void) | undefined;

  /** Act through `deps` (the hub extension's host). */
  install(deps: CompanionWindowDeps): void {
    this.#deps = deps;
  }

  /** What the workspace windows follow. */
  state(): CompanionWindowState {
    return {
      open: this.#window !== undefined,
      ready: this.#window !== undefined && this.#ready,
      ...(this.#error !== undefined ? { error: this.#error } : {}),
    };
  }

  /** Whether window `id` is the floating companion's. */
  is(id: string | undefined): boolean {
    return id !== undefined && this.#window?.id === id;
  }

  /** The window the companion's bubbles and questions go to: its id once its page is ready. */
  target(): string | undefined {
    return this.#ready ? this.#window?.id : undefined;
  }

  /** A workspace window asks for the window open (again: a no-op) or closed. */
  request(request: CompanionWindowRequest): CompanionWindowState {
    if (!request.open) {
      this.close();
      return this.state();
    }
    if (this.#window) return this.state();
    const deps = this.#deps;
    if (!deps) {
      this.#error = "the hub is not running";
      return this.#changed();
    }
    try {
      const win = deps.open(companionWindowOptions(request));
      this.#window = win;
      this.#ready = false;
      this.#error = undefined;
      this.#offClosed = win.onClosed(() => this.#gone(win));
    } catch (e) {
      this.#error = e instanceof Error ? e.message : String(e);
    }
    return this.#changed();
  }

  /** The page of window `windowId` loaded: when it is the companion's, it gets the bubbles now. */
  ready(windowId: string | undefined): boolean {
    if (!this.is(windowId)) return false;
    if (!this.#ready) {
      this.#ready = true;
      this.#changed();
    }
    return true;
  }

  /** Close the window (In window, Off). */
  close(): void {
    const win = this.#window;
    if (!win) return;
    this.#gone(win);
    try {
      win.close();
    } catch (e) {
      console.error("companion: could not close its window", e);
    }
  }

  /** Window `win` closed (or is being closed): forget it. */
  #gone(win: OpenedWindow): void {
    if (this.#window !== win) return;
    this.#offClosed?.();
    this.#offClosed = undefined;
    this.#window = undefined;
    this.#ready = false;
    this.#changed();
  }

  #changed(): CompanionWindowState {
    const state = this.state();
    this.#deps?.emit(state);
    return state;
  }
}

const KEY = Symbol.for("qutty.companionWindow");

/**
 * The app's floating companion window, shared by the `hub` extension (which opens it and routes
 * to it) and the `session` extension and desktop.ts (which leave it out of the app's windows).
 * Kept on `globalThis`, as desktop/workspace-host.ts's `workspaces` is, in case the loader gave
 * them two copies of this module.
 */
export const companionWindow: CompanionWindow =
  ((globalThis as Record<symbol, unknown>)[KEY] as
    | CompanionWindow
    | undefined) ??
    ((globalThis as Record<symbol, unknown>)[KEY] =
      new CompanionWindow()) as CompanionWindow;

/** Whether window `id` is the floating companion's (not a window of the app's own). */
export function isCompanionWindow(id: string): boolean {
  return companionWindow.is(id);
}
