// Owns every xterm.js instance and its PTY session, outside React: a terminal is created once,
// opened into a host element the tile component hands over, and lives there across every
// layout change (tiles are never remounted — see TileCluster). The workspace store only hears
// about the facts it renders: exit, restart, output activity.
//
// Fitting: `scheduleFit` is debounced (the tile's ResizeObserver fires on every animation
// frame of a CSS size transition) and the tile also asks for one on `transitionend`. A hidden
// tile (overflow) is never fitted — xterm would measure a 0×0 box and shrink the PTY.
//
// Font: `setFont` applies the family/size/line height to every live terminal (parked ones too)
// and refits the visible ones; a parked one refits when it is shown again. A web font finishing
// loading (`document.fonts` `loadingdone`) re-measures the cell and refits, since xterm only
// measures when its font options change.
//
// Theme: `setTheme` swaps the colours of every live terminal (xterm repaints on an options
// change) and new terminals start with the current one. The palettes live in
// lib/workspace/themes.ts next to the matching chrome tokens.
//
// xterm.css is linked from app/layout.tsx as public/xterm.css (a copy of
// @xterm/xterm/css/xterm.css): denext's CSS pipeline does not accept an `npm:` stylesheet import.

import {
  FitAddon,
  type ITheme,
  Terminal,
  WebglAddon,
  WebLinksAddon,
} from "./xterm.ts";
import type { PtyBackend, PtyExit, PtyProcessInfo } from "./pty-client.ts";
import type { KeyLike } from "./workspace/keys.ts";
import {
  compileKeyBindings,
  keyBindingData,
  type KeyBindings,
  NO_KEY_BINDINGS,
} from "./key-bindings.ts";
import {
  DEFAULT_FONT_SETTINGS,
  type TerminalFontOptions,
  terminalFontOptions,
} from "./workspace/fonts.ts";
import { DEFAULT_THEME_ID, themeById } from "./workspace/themes.ts";

/** The font a manager starts with (the settings' defaults) until `setFont` is called. */
const DEFAULT_TERMINAL_FONT: TerminalFontOptions = terminalFontOptions(
  DEFAULT_FONT_SETTINGS,
);

/** What the manager tells the workspace. */
export interface TerminalManagerEvents {
  /** The PTY ended (the exit banner is already on screen). */
  onExit(id: string, exit: PtyExit): void;
  /** The user pressed Enter on an exited terminal and a new PTY was started. */
  onRestart(id: string): void;
  /** A PTY is running for `id` (after the first spawn and after every restart): titles can be read. */
  onSpawned?(id: string): void;
  /** Output arrived (throttled to one call per `ACTIVITY_THROTTLE_MS` per terminal). */
  onActivity(id: string): void;
  /** A shortcut the workspace owns was pressed while xterm had focus: decline it. */
  isWorkspaceShortcut(e: KeyLike): boolean;
  /** A spawn failed (the message is already on screen). */
  onSpawnError?(id: string, error: unknown): void;
}

const ACTIVITY_THROTTLE_MS = 300;
const FIT_DEBOUNCE_MS = 90;
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface Managed {
  id: string;
  term: Terminal;
  fit: FitAddon;
  webgl: WebglAddon | null;
  host: HTMLElement | null;
  ptyId: string | null;
  /** The shell's starting directory, used to shorten titles. */
  home: string | undefined;
  exited: boolean;
  spawning: boolean;
  hidden: boolean;
  unsubs: (() => void)[];
  fitTimer: ReturnType<typeof setTimeout> | undefined;
  lastActivity: number;
  disposed: boolean;
  /** The font changed while the terminal was not displayed: re-measure before the next fit. */
  fontStale: boolean;
}

/** A terminal's state as the e2e test hooks read it (see lib/test-hooks.ts). */
export interface TerminalDebugState {
  /** The active buffer, one line per row (scrollback included), right-trimmed. */
  text: string;
  cols: number;
  rows: number;
  ptyId: string | null;
  exited: boolean;
  /** xterm's current font options. */
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontWeight: string;
  /** xterm's current theme background. */
  background: string;
}

/** Creates, hosts and ends terminals. One instance per workspace. */
export class TerminalManager {
  #backend: PtyBackend;
  #keyBindings: KeyBindings = NO_KEY_BINDINGS;
  #events: TerminalManagerEvents;
  #terms = new Map<string, Managed>();
  #webglOk = true;
  /** A terminal asked to focus before it was opened (a new one): focused once attached. */
  #pendingFocus: string | null = null;
  #font: TerminalFontOptions = { ...DEFAULT_TERMINAL_FONT };
  #unwatchFonts: (() => void) | null = null;
  #theme: ITheme = { ...themeById(DEFAULT_THEME_ID).terminal };

  constructor(backend: PtyBackend, events: TerminalManagerEvents) {
    this.#backend = backend;
    this.#events = events;
    void backend.keyBindings().then(
      (text) => (this.#keyBindings = compileKeyBindings(text)),
      () => {},
    );
    this.#watchFontLoading();
  }

  /** The font new terminals get. */
  get font(): TerminalFontOptions {
    return { ...this.#font };
  }

  /**
   * Apply a font to every live terminal (parked ones included) and to new ones; the visible ones
   * refit (debounced) and their PTYs are resized. A no-op when nothing changed.
   */
  setFont(font: TerminalFontOptions): void {
    const prev = this.#font;
    if (
      prev.fontFamily === font.fontFamily && prev.fontSize === font.fontSize &&
      prev.lineHeight === font.lineHeight && prev.fontWeight === font.fontWeight
    ) return;
    this.#font = { ...font };
    for (const m of this.#terms.values()) {
      if (m.disposed) continue;
      const o = m.term.options;
      if (o.fontFamily !== font.fontFamily) o.fontFamily = font.fontFamily;
      if (o.fontSize !== font.fontSize) o.fontSize = font.fontSize;
      if (o.lineHeight !== font.lineHeight) o.lineHeight = font.lineHeight;
      if (o.fontWeight !== font.fontWeight) o.fontWeight = font.fontWeight;
      this.#clearAtlas(m);
      // A parked (display:none) terminal cannot measure its cell; it re-measures when shown.
      if (m.hidden) m.fontStale = true;
      else this.scheduleFit(m.id);
    }
  }

  /** Apply a colour theme to every live terminal (parked ones included) and to new ones. */
  setTheme(theme: ITheme): void {
    const prev = this.#theme;
    const keys = new Set([...Object.keys(prev), ...Object.keys(theme)]);
    if (
      [...keys].every((k) =>
        prev[k as keyof ITheme] === theme[k as keyof ITheme]
      )
    ) {
      return;
    }
    this.#theme = { ...theme };
    for (const m of this.#terms.values()) {
      if (!m.disposed) m.term.options.theme = { ...theme };
    }
  }

  /**
   * Make xterm measure its cell again: it only does so when a font option changes, so nudge the
   * family to an equivalent CSS value and put it back.
   */
  #remeasure(m: Managed): void {
    const o = m.term.options;
    const family = o.fontFamily ?? this.#font.fontFamily;
    o.fontFamily = `${family} `;
    o.fontFamily = family;
  }

  /** Drop the WebGL glyph cache (glyphs rasterised with the old face would linger). */
  #clearAtlas(m: Managed): void {
    try {
      m.webgl?.clearTextureAtlas();
    } catch { /* the DOM renderer has no atlas */ }
  }

  /** Re-measure every terminal's cell after a font finished loading, then refit. */
  #onFontsLoaded = (): void => {
    for (const m of this.#terms.values()) {
      if (m.disposed || !m.term.element) continue;
      if (m.hidden) {
        m.fontStale = true;
        continue;
      }
      this.#remeasure(m);
      this.#clearAtlas(m);
      this.scheduleFit(m.id);
    }
  };

  #watchFontLoading(): void {
    const fonts = globalThis.document?.fonts;
    if (!fonts) return;
    let live = true;
    const onDone = () => {
      if (live) this.#onFontsLoaded();
    };
    try {
      fonts.addEventListener("loadingdone", onDone);
      void fonts.ready.then(onDone, () => {});
    } catch {
      return;
    }
    this.#unwatchFonts = () => {
      live = false;
      fonts.removeEventListener("loadingdone", onDone);
    };
  }

  get backend(): PtyBackend {
    return this.#backend;
  }

  has(id: string): boolean {
    return this.#terms.has(id);
  }

  /** Create the xterm instance for `id` (idempotent). The PTY starts when a host is attached. */
  create(id: string): void {
    if (this.#terms.has(id)) return;
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: this.#font.fontFamily,
      fontSize: this.#font.fontSize,
      lineHeight: this.#font.lineHeight,
      fontWeight: this.#font.fontWeight,
      letterSpacing: 0,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: { ...this.#theme },
      allowTransparency: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    try {
      term.loadAddon(
        new WebLinksAddon((event, uri) => {
          // Open links in the OS browser only with the modifier held, like most terminals.
          if (event.metaKey || event.ctrlKey) {
            globalThis.open(uri, "_blank", "noopener");
          }
        }),
      );
    } catch { /* links are a nicety */ }
    const m: Managed = {
      id,
      term,
      fit,
      webgl: null,
      host: null,
      ptyId: null,
      home: undefined,
      exited: false,
      spawning: false,
      hidden: false,
      unsubs: [],
      fitTimer: undefined,
      lastActivity: 0,
      disposed: false,
      fontStale: false,
    };
    this.#terms.set(id, m);

    term.attachCustomKeyEventHandler((e) => {
      // Workspace shortcuts bubble to the window listener; xterm must not swallow them.
      if (this.#events.isWorkspaceShortcut(e)) return false;
      // Keys the user bound in macOS (DefaultKeyBinding.dict), e.g. ⌘⌫, which xterm.js would
      // otherwise drop: send what the binding means, like every native app does.
      const bound = keyBindingData(this.#keyBindings, e);
      if (bound !== null) {
        if (e.type === "keydown" && m.ptyId && !m.exited) {
          void this.#backend.write(m.ptyId, bound).catch(() => {});
        }
        e.preventDefault();
        return false;
      }
      return true;
    });
    term.onData((data) => {
      if (m.exited) {
        if (data === "\r" || data === "\n") void this.restart(id);
        return;
      }
      if (m.ptyId) void this.#backend.write(m.ptyId, data).catch(() => {});
    });
    term.onBinary((data) => {
      // Legacy mouse reports: one byte per char, so they must not be UTF-8 encoded.
      if (m.ptyId && !m.exited) {
        void this.#backend.write(m.ptyId, data, { binary: true }).catch(
          () => {},
        );
      }
    });
  }

  /** Open the terminal into `host` (once) and start its PTY. */
  attach(id: string, host: HTMLElement): void {
    const m = this.#terms.get(id);
    if (!m || m.disposed || m.host === host) return;
    m.host = host;
    if (!m.term.element) {
      m.term.open(host);
      this.#tryWebgl(m);
    }
    this.fitNow(id);
    this.focusPending(id);
    if (!m.ptyId && !m.spawning) void this.#spawn(m);
  }

  #tryWebgl(m: Managed): void {
    if (!this.#webglOk) return;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        // Fall back to the DOM renderer for this terminal; xterm re-renders on dispose.
        try {
          webgl.dispose();
        } catch { /* already gone */ }
        m.webgl = null;
      });
      m.term.loadAddon(webgl);
      m.webgl = webgl;
    } catch {
      // No WebGL here (or it failed to initialise): the DOM renderer is already active.
      this.#webglOk = false;
      m.webgl = null;
    }
  }

  async #spawn(m: Managed): Promise<void> {
    m.spawning = true;
    try {
      const { cols, rows } = m.term;
      const spawned = await this.#backend.spawn({ cols, rows });
      if (m.disposed) {
        void this.#backend.kill(spawned.id).catch(() => {});
        return;
      }
      m.ptyId = spawned.id;
      m.home ??= spawned.cwd;
      m.exited = false;
      m.unsubs.push(this.#backend.onData(spawned.id, (data) => {
        if (m.disposed) return;
        m.term.write(data);
        const now = Date.now();
        if (now - m.lastActivity >= ACTIVITY_THROTTLE_MS) {
          m.lastActivity = now;
          this.#events.onActivity(m.id);
        }
      }));
      m.unsubs.push(this.#backend.onExit(spawned.id, (exit) => {
        if (m.disposed || m.ptyId !== spawned.id) return;
        m.exited = true;
        const why = exit.signal !== null && exit.signal !== 0
          ? `signal ${exit.signal}`
          : `code ${exit.exitCode}`;
        m.term.write(
          `\r\n${DIM}[process exited (${why}) — press Enter to restart or ⌘W to close]${RESET}\r\n`,
        );
        this.#events.onExit(m.id, exit);
      }));
      // The size may have changed while spawning.
      if (m.term.cols !== cols || m.term.rows !== rows) {
        void this.#backend.resize(spawned.id, m.term.cols, m.term.rows).catch(
          () => {},
        );
      }
      this.#events.onSpawned?.(m.id);
    } catch (error) {
      m.exited = true;
      m.term.write(
        `\r\n${DIM}[could not start a shell: ${
          error instanceof Error ? error.message : String(error)
        } — press Enter to retry]${RESET}\r\n`,
      );
      this.#events.onSpawnError?.(m.id, error);
    } finally {
      m.spawning = false;
    }
  }

  /** Start a fresh PTY in an exited terminal (the screen is cleared first). */
  async restart(id: string): Promise<void> {
    const m = this.#terms.get(id);
    if (!m || m.disposed || m.spawning || !m.exited) return;
    for (const u of m.unsubs.splice(0)) u();
    m.ptyId = null;
    m.exited = false;
    m.term.reset();
    this.#events.onRestart(id);
    await this.#spawn(m);
  }

  /** Mark a terminal hidden (overflow): no fits until it is shown again. */
  setHidden(id: string, hidden: boolean): void {
    const m = this.#terms.get(id);
    if (!m || m.hidden === hidden) return;
    m.hidden = hidden;
    if (!hidden) this.scheduleFit(id);
  }

  /** Fit after a short quiet period (coalesces the frames of a size transition). */
  scheduleFit(id: string, delay = FIT_DEBOUNCE_MS): void {
    const m = this.#terms.get(id);
    if (!m || m.disposed) return;
    if (m.fitTimer !== undefined) clearTimeout(m.fitTimer);
    m.fitTimer = setTimeout(() => {
      m.fitTimer = undefined;
      this.fitNow(id);
    }, delay);
  }

  /** Fit now; resizes the PTY when the grid changed. */
  fitNow(id: string): void {
    const m = this.#terms.get(id);
    if (!m || m.disposed || m.hidden || !m.host || !m.term.element) return;
    if (m.host.clientWidth < 20 || m.host.clientHeight < 20) return;
    if (m.fontStale) {
      m.fontStale = false;
      this.#remeasure(m);
      this.#clearAtlas(m);
    }
    let dims: { cols: number; rows: number } | undefined;
    try {
      dims = m.fit.proposeDimensions();
    } catch {
      return;
    }
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) {
      return;
    }
    const cols = Math.max(2, dims.cols);
    const rows = Math.max(1, dims.rows);
    if (cols === m.term.cols && rows === m.term.rows) return;
    m.term.resize(cols, rows);
    if (m.ptyId && !m.exited) {
      void this.#backend.resize(m.ptyId, cols, rows).catch(() => {});
    }
  }

  focus(id: string): void {
    const m = this.#terms.get(id);
    this.#pendingFocus = null;
    if (!m || m.disposed) return;
    // Not opened yet (a terminal created this tick) or not displayed yet (a parked overflow tile,
    // `display: none`): keep the request; the tile calls `focusPending` once it is on screen.
    if (m.term.element) m.term.focus();
    if (!this.hasFocus(id)) this.#pendingFocus = id;
  }

  /** Fulfil a `focus(id)` that arrived before `id` could take keyboard focus. */
  focusPending(id: string): void {
    if (this.#pendingFocus !== id) return;
    const m = this.#terms.get(id);
    if (!m || m.disposed || !m.term.element) return;
    m.term.focus();
    if (this.hasFocus(id)) this.#pendingFocus = null;
  }

  /** Whether xterm's textarea for `id` currently has keyboard focus. */
  hasFocus(id: string): boolean {
    const m = this.#terms.get(id);
    const active = globalThis.document?.activeElement;
    return !!m && !!active && !!m.host && m.host.contains(active);
  }

  /** The foreground process info and the shell's home, for titles. */
  async info(
    id: string,
  ): Promise<{ info: PtyProcessInfo; home: string | undefined } | null> {
    const m = this.#terms.get(id);
    if (!m || m.disposed || !m.ptyId || m.exited) return null;
    try {
      return { info: await this.#backend.info(m.ptyId), home: m.home };
    } catch {
      return null;
    }
  }

  /** Test-only: the buffer text, grid size and PTY id of `id` (`null` when unknown). */
  debugState(id: string): TerminalDebugState | null {
    const m = this.#terms.get(id);
    if (!m) return null;
    const buf = m.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    return {
      text: lines.join("\n"),
      cols: m.term.cols,
      rows: m.term.rows,
      ptyId: m.ptyId,
      exited: m.exited,
      fontFamily: String(m.term.options.fontFamily ?? ""),
      fontSize: Number(m.term.options.fontSize),
      lineHeight: Number(m.term.options.lineHeight),
      fontWeight: String(m.term.options.fontWeight ?? ""),
      background: String(m.term.options.theme?.background ?? ""),
    };
  }

  /** Kill the PTY and dispose the xterm instance. */
  dispose(id: string): void {
    const m = this.#terms.get(id);
    if (!m) return;
    m.disposed = true;
    this.#terms.delete(id);
    if (m.fitTimer !== undefined) clearTimeout(m.fitTimer);
    for (const u of m.unsubs.splice(0)) u();
    if (m.ptyId && !m.exited) void this.#backend.kill(m.ptyId).catch(() => {});
    try {
      m.webgl?.dispose();
    } catch { /* ignore */ }
    try {
      m.term.dispose();
    } catch { /* ignore */ }
  }

  /** Dispose everything (page unload / unmount). */
  disposeAll(): void {
    this.#unwatchFonts?.();
    this.#unwatchFonts = null;
    for (const id of [...this.#terms.keys()]) this.dispose(id);
  }
}
