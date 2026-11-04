"use client";

// The workspace island: owns the store, the terminal manager, the keyboard and the layout
// measurement, and renders the switcher bar, the tile cluster and the settings popover.
//
// Focus discipline: every action that changes the focused terminal is run through `run`, which
// computes the next state with the pure reducer first so the right xterm can be focused without
// waiting for a re-render (and without an effect that would steal focus from the settings UI).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "denext";
import { makeWindowDraggable } from "denext/desktop/window";
import { computeLayout, type Rect } from "../lib/layout/mod.ts";
import { getPtyBackend, isDesktop } from "../lib/pty-client.ts";
import { TerminalManager } from "../lib/terminal-manager.ts";
import { installE2eHooks, isTestMode, withKillSpy } from "../lib/test-hooks.ts";
import { makeTitle } from "../lib/workspace/format.ts";
import {
  commandForKey,
  detectPlatform,
  isModifierRelease,
  type KeyCommand,
  type KeyPlatform,
} from "../lib/workspace/keys.ts";
import { visibleIdSet } from "../lib/workspace/bar.ts";
import { terminalFontOptions } from "../lib/workspace/fonts.ts";
import {
  initialState,
  loadSettings,
  reduce,
  saveSettings,
  type WorkspaceAction,
} from "../lib/workspace/store.ts";
import { TileCluster } from "./tile-cluster.tsx";
import { SwitcherBar } from "./switcher-bar.tsx";
import { SettingsPanel } from "./settings-panel.tsx";

const TITLE_POLL_MS = 2000;
const AGE_TICK_MS = 10_000;

export function Workspace() {
  const [state, dispatch] = useReducer(reduce, undefined, () => initialState());
  const stateRef = useRef(state);
  stateRef.current = state;

  const managerRef = useRef<TerminalManager | null>(null);
  const seqRef = useRef(0);
  const clusterRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  const [bounds, setBounds] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  const [ready, setReady] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [platform, setPlatform] = useState<KeyPlatform>("mac");
  const [reducedMotion, setReducedMotion] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  /** Read a terminal's foreground process + cwd into its title (no-op once it is gone). */
  const pollTitle = useCallback(async (id: string) => {
    const r = await managerRef.current?.info(id);
    if (!r || !managerRef.current) return;
    dispatch({ type: "title", id, title: makeTitle(r.info, r.home) });
  }, []);

  /** Dispatch, and move keyboard focus to the terminal that becomes focused (if it changes). */
  const run = useCallback((action: WorkspaceAction) => {
    const before = stateRef.current;
    const after = reduce(before, action);
    dispatch(action);
    if (after.focusedId && after.focusedId !== before.focusedId) {
      managerRef.current?.focus(after.focusedId);
    }
  }, []);

  const newTerminal = useCallback(() => {
    const manager = managerRef.current;
    if (!manager) return;
    const id = `t${++seqRef.current}`;
    manager.create(id);
    run({ type: "add", id, now: Date.now() });
  }, [run]);

  const closeTerminal = useCallback((id: string) => {
    managerRef.current?.dispose(id);
    run({ type: "remove", id });
  }, [run]);

  const focusTerminal = useCallback((id: string) => {
    run({ type: "focus", id, now: Date.now() });
    managerRef.current?.focus(id);
  }, [run]);

  const runCommand = useCallback((cmd: KeyCommand) => {
    const now = Date.now();
    switch (cmd.kind) {
      case "newTerminal":
        return newTerminal();
      case "closeFocused": {
        const id = stateRef.current.focusedId;
        if (id) closeTerminal(id);
        return;
      }
      case "focusOrdinal":
        return run({ type: "focusOrdinal", ordinal: cmd.ordinal, now });
      case "cycle":
        return run({ type: "cycle", dir: cmd.dir, now });
      case "focusPrevious":
        return run({ type: "focusPrevious", now });
      case "cyclePattern":
        return run({ type: "cyclePattern" });
      case "cycleBarPosition":
        return run({ type: "cycleBarPosition" });
      case "toggleMonocle":
        return run({ type: "toggleMonocle" });
      case "fontSize":
        return run({ type: "stepFontSize", dir: cmd.dir });
      case "fontSizeReset":
        return run({ type: "resetFontSize" });
    }
  }, [newTerminal, closeTerminal, run]);

  // Boot: environment, persisted settings, the terminal manager, the first terminal.
  useEffect(() => {
    const plat = detectPlatform();
    setPlatform(plat);
    setDesktop(isDesktop());
    const mq = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    setReducedMotion(!!mq?.matches);
    const onMq = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq?.addEventListener?.("change", onMq);

    const saved = loadSettings();
    if (saved) dispatch({ type: "hydrateSettings", settings: saved });

    // `?test=1` (the e2e suite): record PTY kills and expose terminal state on `window.__e2e`.
    const testMode = isTestMode();
    const kills: string[] = [];
    const backend = testMode
      ? withKillSpy(getPtyBackend(), kills)
      : getPtyBackend();
    const manager = new TerminalManager(backend, {
      onExit: (id, exit) =>
        dispatch({ type: "exited", id, exitCode: exit.exitCode }),
      onRestart: (id) => dispatch({ type: "restarted", id, now: Date.now() }),
      onActivity: (id) => dispatch({ type: "activity", id }),
      // The shell needs a moment to start its foreground process before `info` is meaningful.
      onSpawned: (id) => setTimeout(() => void pollTitle(id), 400),
      isWorkspaceShortcut: (e) => commandForKey(e, plat) !== null,
    });
    managerRef.current = manager;
    if (testMode) installE2eHooks(manager, kills);
    setReady(true);
    return () => {
      mq?.removeEventListener?.("change", onMq);
      manager.disposeAll();
      managerRef.current = null;
    };
  }, [pollTitle]);

  // The terminal font: applied to every terminal (and to new ones) whenever it changes. Declared
  // before the first-terminal effect so the hydrated font is in place when that one is created.
  const { fontFamily, fontFamilyCustom, fontSize, lineHeight, fontWeight } =
    state.settings;
  useEffect(() => {
    if (!ready) return;
    managerRef.current?.setFont(
      terminalFontOptions({
        fontFamily,
        fontFamilyCustom,
        fontSize,
        lineHeight,
        fontWeight,
      }),
    );
  }, [ready, fontFamily, fontFamilyCustom, fontSize, lineHeight, fontWeight]);

  // The first terminal, once the manager exists.
  useEffect(() => {
    if (
      ready && stateRef.current.terminals.length === 0 && seqRef.current === 0
    ) newTerminal();
  }, [ready, newTerminal]);

  // Measure the cluster area (also fires when the bar moves to another edge).
  useLayoutEffect(() => {
    const el = clusterRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      setBounds((b) => (b.w === w && b.h === h ? b : { x: 0, y: 0, w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keyboard: shortcuts are intercepted at the window (capture) before xterm sees them; xterm's
  // own handler declines the same keys so they bubble here.
  useEffect(() => {
    if (!ready) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && settingsOpen) {
        // Swallow it: the Escape that closes the panel must not also reach the shell.
        e.preventDefault();
        e.stopPropagation();
        setSettingsOpen(false);
        return;
      }
      const cmd = commandForKey(e, platform);
      if (!cmd) return;
      e.preventDefault();
      e.stopPropagation();
      runCommand(cmd);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isModifierRelease(e, platform) && stateRef.current.cycle) {
        dispatch({ type: "endCycle" });
      }
    };
    const onBlur = () => {
      if (stateRef.current.cycle) dispatch({ type: "endCycle" });
    };
    globalThis.addEventListener("keydown", onKeyDown, true);
    globalThis.addEventListener("keyup", onKeyUp, true);
    globalThis.addEventListener("blur", onBlur);
    return () => {
      globalThis.removeEventListener("keydown", onKeyDown, true);
      globalThis.removeEventListener("keyup", onKeyUp, true);
      globalThis.removeEventListener("blur", onBlur);
    };
  }, [ready, platform, runCommand, settingsOpen]);

  // Title polling: the focused terminal, right away on focus and every couple of seconds.
  const focusedId = state.focusedId;
  useEffect(() => {
    if (!ready || !focusedId) return;
    const poll = () => void pollTitle(focusedId);
    // The PTY may still be spawning on the first focus; `onSpawned` covers that case.
    const first = setTimeout(poll, 150);
    const timer = setInterval(poll, TITLE_POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [ready, focusedId, pollTitle]);

  // Ages ("2m ago") tick slowly.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(t);
  }, []);

  // Persist settings.
  const settings = state.settings;
  useEffect(() => {
    if (ready) saveSettings(settings);
  }, [ready, settings]);

  // The thin drag strip above the cluster when the bar is not on top (desktop only).
  const barPosition = settings.barPosition;
  useEffect(() => {
    const el = stripRef.current;
    if (!desktop || !el) return;
    return makeWindowDraggable(el);
  }, [desktop, barPosition]);

  const layout = useMemo(
    () =>
      bounds.w > 0 && bounds.h > 0
        ? computeLayout(state.mru, bounds, settings.layout)
        : { tiles: [], overflow: state.mru },
    [state.mru, bounds, settings.layout],
  );
  const visibleIds = useMemo(() => visibleIdSet(layout), [layout]);

  const manager = managerRef.current;
  const showStrip = desktop && barPosition !== "top";

  return (
    <div
      class={`app bar-${barPosition}${desktop ? " is-desktop" : ""}${
        reducedMotion ? " reduced-motion" : ""
      }`}
      data-platform={platform}
      data-testid="app"
      data-pattern={settings.layout.pattern}
      data-focused={focusedId ?? ""}
    >
      {showStrip && (
        <div
          class="drag-strip"
          ref={stripRef}
          aria-hidden="true"
        />
      )}
      <SwitcherBar
        state={state}
        visibleIds={visibleIds}
        position={barPosition}
        pattern={settings.layout.pattern}
        platform={platform}
        desktop={desktop}
        settingsOpen={settingsOpen}
        onFocus={focusTerminal}
        onClose={closeTerminal}
        onNew={newTerminal}
        onPattern={(pattern) => run({ type: "setLayout", patch: { pattern } })}
        onToggleSettings={() => setSettingsOpen((o) => !o)}
      />
      <div class="cluster" ref={clusterRef} data-testid="cluster">
        {manager && (
          <TileCluster
            manager={manager}
            terminals={state.terminals}
            tiles={layout.tiles}
            focusedId={focusedId}
            decay={settings.layout.decay}
            now={now}
            reducedMotion={reducedMotion}
            onFocus={focusTerminal}
            onClose={closeTerminal}
          />
        )}
        {ready && state.terminals.length === 0 && (
          <div class="empty" data-testid="empty">
            <p>No terminals open.</p>
            <button
              type="button"
              class="btn-primary"
              data-testid="empty-new"
              onClick={newTerminal}
            >
              New terminal <kbd>{platform === "mac" ? "⌘T" : "Ctrl+T"}</kbd>
            </button>
          </div>
        )}
      </div>
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          platform={platform}
          onLayout={(patch) => run({ type: "setLayout", patch })}
          onBarPosition={(position) =>
            run({ type: "setBarPosition", position })}
          onBarOrder={(order) => run({ type: "setBarOrder", order })}
          onFont={(patch) => run({ type: "setFont", patch })}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
