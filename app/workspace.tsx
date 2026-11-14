"use client";

// The workspace island: owns the store, the terminal manager, the keyboard and the layout
// measurement, and renders the switcher bar, the tile cluster and the settings popover. The
// SSH half (connection manager, download picker, transfers, drops) lives in `useSsh`; the agent
// hub's tiles (the agent badges) in `useHub`; the companion (Loopy, in a corner of the tile area:
// `ask_user` questions, `qutty-hook say`, the chat with its brain) in `CompanionOverlay`, its
// settings and commands in `useCompanion`. With the companion Off, `AskDialog` asks instead.
// Broadcast input (cluster ssh) is `useBroadcast` plus its banner and the tiles' checkboxes; an
// SSH tile's port forwards open in `ForwardsDialog`.
//
// Detachable sessions: the window shows a workspace (`useSession`): on boot it is rebuilt from the
// terminals that kept running while no window showed it, or started with its first shell, and the
// page saves its snapshot as it changes. Unmounting (the page going away) leaves the PTYs running.
//
// The view: each workspace is tiled (the layout engine) or free-form (MDI: tiles as windows the
// user moves and resizes), picked in the bar's View menu, Settings → Layout or the Window menu
// (`useFreeformView`, lib/workspace/freeform.ts, lib/workspace/mdi-menu.ts).
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
import {
  getTitleBarPreferences,
  makeWindowDraggable,
} from "denext/desktop/window";
import { computeLayout, type Rect } from "../lib/layout/mod.ts";
import { getPtyBackend, isDesktop } from "../lib/pty-client.ts";
import { TerminalManager } from "../lib/terminal-manager.ts";
import {
  installE2eHooks,
  isTestMode,
  newBackendSpy,
  withBackendSpy,
} from "../lib/test-hooks.ts";
import { makeTitle } from "../lib/workspace/format.ts";
import {
  commandForKey,
  detectPlatform,
  isModifierRelease,
  isPushToTalk,
  type KeyCommand,
  type KeyPlatform,
  pttAvailable,
  shortcutLabel,
} from "../lib/workspace/keys.ts";
import { visibleIdSet } from "../lib/workspace/bar.ts";
import {
  type ActivityState,
  nextDecay,
  tileActivity,
} from "../lib/workspace/activity.ts";
import { terminalFontOptions } from "../lib/workspace/fonts.ts";
import { applyChromeTheme, themeById } from "../lib/workspace/themes.ts";
import {
  initialState,
  isMaximized,
  loadSettings,
  maximizedId,
  reduce,
  saveSettings,
  SETTINGS_STORAGE_KEY,
  shownMru,
  type WorkspaceAction,
} from "../lib/workspace/store.ts";
import {
  headDoubleClickControl,
  type TileControl,
  tileMenuControl,
} from "../lib/workspace/tile-controls.ts";
import { useSession } from "./use-session.ts";
import { useWindowClose } from "./use-window-close.ts";
import { CloseWindowDialog } from "./close-window-dialog.tsx";
import { isTileMenuItem, type WindowClose } from "../lib/workspace/windows.ts";
import { useFreeformView } from "./use-freeform-view.ts";
import { WorkspacesMenu } from "./workspaces-menu.tsx";
import { TileCluster } from "./tile-cluster.tsx";
import { SwitcherBar } from "./switcher-bar.tsx";
import { SettingsPanel } from "./settings-panel.tsx";
import {
  baseName,
  SHELL_PROFILE,
  type TerminalProfile,
} from "../lib/ssh-ui.ts";
import { ConnectionsDialog } from "./connections-dialog.tsx";
import { RemoteBrowser } from "./remote-browser.tsx";
import { SshHeadActions, SshTileOverlay } from "./ssh-overlays.tsx";
import { ForwardsDialog } from "./forwards-panel.tsx";
import { useBroadcast } from "./use-broadcast.ts";
import { BroadcastBanner, BroadcastCheck } from "./broadcast-banner.tsx";
import { useSsh } from "./use-ssh.ts";
import { useLinks } from "./use-links.ts";
import { LinkMenu } from "./link-menu.tsx";
import { useLauncher } from "./use-launcher.ts";
import { useHub } from "./use-hub.ts";
import { AskDialog } from "./ask-dialog.tsx";
import { CompanionOverlay } from "./companion/companion-overlay.tsx";
import { useCompanion } from "./use-companion.ts";
import { useVoice } from "./use-voice.ts";
import { useSysStats } from "./use-sysstats.ts";
import { useReactions } from "./use-reactions.ts";
import { HOT_LINE, maySayHot, thresholds } from "../lib/sysstats.ts";
import { anyAlertOn } from "../lib/voice/alerts.ts";
import { flatEntries, plusLabel } from "../lib/launcher.ts";
import { effectiveMode } from "../lib/companion/settings.ts";
import { opensInSandbox } from "../lib/sandbox/settings.ts";
import { useSandboxSettings } from "./sandbox-settings.tsx";
import { useOllama } from "./use-ollama.ts";
import { OllamaDialog } from "./ollama-dialog.tsx";
import { focusWebTile, type WebTileHooks } from "./web-tile.tsx";
import { webEngine } from "../lib/web/engine.ts";
import { ollamaProfile, pullProfile } from "../lib/ollama/harnesses.ts";
import {
  type OllamaPair,
  pairEntryId,
  pairTitle,
} from "../lib/ollama/settings.ts";

const TITLE_POLL_MS = 2000;
const AGE_TICK_MS = 10_000;

/**
 * The workspace island. In test mode (`?test=1`) `window.__e2eRemount()` mounts it afresh: the
 * e2e suite's stand-in for closing the window and opening it again (the PTYs stay up).
 */
export function Workspace() {
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!isTestMode()) return;
    const g = globalThis as { __e2eRemount?: () => void };
    g.__e2eRemount = () => setGeneration((n) => n + 1);
    return () => void delete g.__e2eRemount;
  }, []);
  return <WorkspaceView key={generation} />;
}

function WorkspaceView() {
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
  /** The SSH tile whose port forwards are open. */
  const [forwardsFor, setForwardsFor] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /** Read a terminal's foreground process + cwd into its title (no-op once it is gone). */
  const pollTitle = useCallback(async (id: string) => {
    const r = await managerRef.current?.info(id);
    if (!r || !managerRef.current) return;
    // An agent tool's tile names the tool ("claude — ~/proj"), whatever its process is called.
    const entry = stateRef.current.terminals.find((t) => t.id === id);
    dispatch({
      type: "title",
      id,
      title: makeTitle(
        r.info,
        r.home,
        entry?.agent?.name ?? (entry?.sandbox ? "sandbox" : undefined),
      ),
    });
  }, []);

  /** Dispatch, and move keyboard focus to the terminal that becomes focused (if it changes). */
  const run = useCallback((action: WorkspaceAction) => {
    const before = stateRef.current;
    const after = reduce(before, action);
    dispatch(action);
    // A web tile takes the keyboard itself once it renders (app/web-tile.tsx).
    const id = after.focusedId;
    if (id && id !== before.focusedId && !isWebTile(after.terminals, id)) {
      managerRef.current?.focus(id);
    }
  }, []);

  /** Give tile `id` the keyboard: its terminal, or a web tile's body. */
  const focusKeyboard = useCallback((id: string) => {
    if (isWebTile(stateRef.current.terminals, id)) focusWebTile(id);
    else managerRef.current?.focus(id);
  }, []);

  /** A web tile showing `url`, beside the focused tile (it becomes the focused one). */
  const openWebTile = useCallback((url: string) => {
    const id = `t${++seqRef.current}`;
    run({ type: "add", id, now: Date.now(), web: { url } });
    return id;
  }, [run]);

  /** A new tile running `profile` (the login shell by default); returns its id. */
  const openTile = useCallback((asked: TerminalProfile = SHELL_PROFILE) => {
    const manager = managerRef.current;
    if (!manager) return null;
    const id = `t${++seqRef.current}`;
    // A shell or agent opens in the sandbox per the picker's choice, else the default.
    const sandboxSettings = stateRef.current.settings.sandbox;
    const profile: TerminalProfile = asked.kind === "ssh" ? asked : {
      ...asked,
      sandbox: opensInSandbox(sandboxSettings, asked.sandbox),
    };
    manager.setSandbox(sandboxSettings);
    manager.create(id, profile);
    run({
      type: "add",
      id,
      now: Date.now(),
      ...(profile.kind === "ssh" ? { ssh: profile } : {}),
      ...(profile.kind === "agent"
        ? {
          agent: {
            // An Ollama tile says which model: "claude · qwen3.8:27b-mlx — ~/proj".
            name: profile.ollamaModel
              ? pairTitle({ harness: profile.name, model: profile.ollamaModel })
              : profile.name,
            label: profile.label,
          },
        }
        : {}),
      ...(profile.kind === "shell" && profile.shell
        ? { title: baseName(profile.shell) }
        : {}),
      ...(profile.kind !== "ssh" && profile.sandbox ? { sandbox: true } : {}),
    });
    return id;
  }, [run]);

  const ssh = useSsh({
    manager: managerRef.current,
    terminals: () => stateRef.current.terminals,
    openTile,
    refocus: () => {
      const id = stateRef.current.focusedId;
      if (id) focusKeyboard(id);
    },
    cluster: clusterRef,
  });
  const sshRef = useRef(ssh);
  sshRef.current = ssh;

  const links = useLinks({
    manager: managerRef.current,
    settings: state.settings.links,
    platform,
    openTile,
    openWebTile,
    download: (id, remotePath) => void sshRef.current.download(id, remotePath),
    refocus: () => {
      const id = stateRef.current.focusedId;
      if (id) focusKeyboard(id);
    },
  });
  const linksRef = useRef(links);
  linksRef.current = links;

  const [ollamaOpen, setOllamaOpen] = useState(false);
  const ollama = useOllama(ready ? managerRef.current?.backend ?? null : null, {
    active: ollamaOpen || settingsOpen,
    lookedAt: state.settings.ollama.libraryLookedAt,
  });
  const launcher = useLauncher({
    manager: managerRef.current,
    plusOpens: state.settings.plusOpens,
    lastLaunch: state.settings.lastLaunch,
    sandboxDefault: state.settings.sandbox.mode === "off"
      ? null
      : state.settings.sandbox.newTilesInSandbox,
    openTile,
    connect: (req) => sshRef.current.connect(req),
    remember: (entryId) => dispatch({ type: "launched", entryId }),
    ...(ollama.status.installed
      ? { ollama: { status: ollama.status, settings: state.settings.ollama } }
      : {}),
  });
  /** The Ollama dialog's launches and pulls (on the host: the sandbox has no Ollama). */
  const launchOllama = useCallback((pair: OllamaPair, pullFirst: boolean) => {
    setOllamaOpen(false);
    openTile({
      ...ollamaProfile(ollama.status.path ?? "ollama", pair, pullFirst),
      sandbox: false,
    });
    dispatch({ type: "launched", entryId: pairEntryId(pair) });
  }, [openTile, ollama.status.path]);
  const pullOllama = useCallback((model: string) => {
    setOllamaOpen(false);
    openTile({
      ...pullProfile(ollama.status.path ?? "ollama", model),
      sandbox: false,
    });
  }, [openTile, ollama.status.path]);
  /** Plain `+`, ⌘T and the empty state's button: what Settings says plain `+` opens. */
  const newTerminal = launcher.openPlus;
  const hubTileOf = useHub(
    managerRef.current,
    state.terminals,
    state.settings.tileTitle,
  );

  const closeTerminal = useCallback((id: string) => {
    managerRef.current?.dispose(id);
    sshRef.current.forget(id);
    run({ type: "remove", id });
  }, [run]);
  const closeRef = useRef(closeTerminal);
  closeRef.current = closeTerminal;

  const focusTerminal = useCallback((id: string) => {
    run({ type: "focus", id, now: Date.now() });
    focusKeyboard(id);
  }, [run, focusKeyboard]);

  /**
   * A tile's Minimize, Maximize or Restore (its header buttons, a header double click, the Window
   * menu). Maximize and Restore give it the keyboard; Minimize hands it to the next tile (`run`).
   */
  const tileControl = useCallback((control: TileControl, id: string) => {
    run({ type: control, id, now: Date.now() });
    if (control !== "minimize") focusKeyboard(id);
  }, [run, focusKeyboard]);

  /** A double click on a tile's header: what the OS title-bar double click does, for the tile. */
  const headDoubleClick = useCallback((id: string) => {
    void titleBarDoubleClick().then((action) => {
      const control = headDoubleClickControl(
        action,
        isMaximized(stateRef.current, id),
      );
      if (control) tileControl(control, id);
    });
  }, [tileControl]);

  // What web tiles drive their page through.
  const webHooks = useMemo<WebTileHooks>(() => ({
    engine: webEngine(),
    onPage: (id, page) => dispatch({ type: "webPage", id, page }),
    openExternal: (url) => linksRef.current.openInBrowser(url),
  }), []);

  const session = useSession({
    manager: ready ? managerRef.current : null,
    state,
    seqRef,
    dispatch,
    focus: (id) => focusKeyboard(id),
    // A new workspace starts with the default shell on the host, whatever plain `+` opens.
    fresh: () => {
      if (stateRef.current.terminals.length === 0) {
        openTile({ kind: "shell", sandbox: false });
      }
    },
  });

  useCompanion({
    manager: managerRef.current,
    settings: state.settings.companion,
    terminals: () => stateRef.current.terminals,
    sections: launcher.sections,
    openTile,
    launchSsh: (entryId) => {
      const entry = flatEntries(launcher.sections).find((e) =>
        e.id === entryId
      );
      if (!entry) return false;
      launcher.launch(entry, false);
      return true;
    },
    closeTile: closeTerminal,
    focusTile: focusTerminal,
  });
  const refocus = useCallback(() => {
    const id = stateRef.current.focusedId;
    if (id) focusKeyboard(id);
  }, []);
  // The close button (Settings → Windows). A remembered choice is saved at once: Keep Running
  // closes the window before the settings effect would run.
  const rememberClose = useCallback((windowClose: WindowClose) => {
    const action: WorkspaceAction = { type: "setWindowClose", windowClose };
    saveSettings(reduce(stateRef.current, action).settings);
    dispatch(action);
  }, []);
  const windowClose = useWindowClose({
    session: ready ? managerRef.current?.backend.session : undefined,
    setting: state.settings.windowClose,
    onRemember: rememberClose,
    onCancel: refocus,
  });
  const modalOpen = ssh.dialog !== null || ssh.browseFor !== null ||
    ollamaOpen || forwardsFor !== null || windowClose.asking;
  // The close question takes Escape: the settings popover (which would swallow it) goes.
  useEffect(() => {
    if (windowClose.asking) setSettingsOpen(false);
  }, [windowClose.asking]);
  const broadcast = useBroadcast({
    manager: managerRef.current,
    terminals: state.terminals,
    refocus,
  });
  const broadcastRef = useRef(broadcast);
  broadcastRef.current = broadcast;
  const voice = useVoice({
    backend: managerRef.current?.backend,
    settings: state.settings.voice,
    platform,
    enabled: effectiveMode(state.settings.companion.mode) === "window",
    typeIntoFocused: (text) => {
      const manager = managerRef.current;
      const id = stateRef.current.focusedId;
      const pty = id ? manager?.ptyId(id) : undefined;
      if (!manager || !pty) return false;
      void manager.backend.write(pty, text).catch(() => {});
      manager.focus(id!);
      return true;
    },
  });
  // The lite system monitor: the bar meter, and Loopy's hot face (with Lively on).
  const monitor = state.settings.monitor;
  const hotWanted = monitor.hotLoopy && state.settings.companion.lively &&
    effectiveMode(state.settings.companion.mode) === "window";
  const sys = useSysStats({
    backend: managerRef.current?.backend ?? null,
    active: monitor.meter || hotWanted,
    thresholds: thresholds(monitor),
  });
  const hotSaidAt = useRef<number | null>(null);
  const onHotShown = () => {
    const now = Date.now();
    if (
      !maySayHot({
        alertsOn: anyAlertOn(stateRef.current.settings.voice),
        speaking: voice.speaking,
        lastSaidAt: hotSaidAt.current,
        now,
      })
    ) return;
    hotSaidAt.current = now;
    voice.test(HOT_LINE);
  };
  // Loopy's reactions: a long shell command or an agent's job that finished well or failed.
  const reactions = useReactions({
    backend: managerRef.current?.backend ?? null,
    companion: state.settings.companion,
    voice: state.settings.voice,
    speaking: voice.speaking,
    say: voice.alert,
    nameOf: (id) =>
      hubTileOf(id)?.name ??
        stateRef.current.terminals.find((t) => t.id === id)?.title ?? "a tile",
  });
  const commandDoneRef = useRef(reactions.onCommandDone);
  commandDoneRef.current = reactions.onCommandDone;
  const pttKeyRef = useRef(state.settings.voice.pttKey);
  pttKeyRef.current = state.settings.voice.pttKey;

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
      case "openConnections":
        setSettingsOpen(false);
        return sshRef.current.toggleDialog();
      case "toggleBroadcast":
        return broadcastRef.current.toggle();
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
    // Another window changed the settings: follow (each window keeps its own layout).
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SETTINGS_STORAGE_KEY) return;
      const next = loadSettings();
      if (!next) return;
      const { layout: _layout, ...rest } = next;
      dispatch({ type: "hydrateSettings", settings: rest });
    };
    globalThis.addEventListener("storage", onStorage);

    // `?test=1` (the e2e suite): record PTY kills and resizes and expose terminal state on
    // `window.__e2e`.
    const testMode = isTestMode();
    const spy = newBackendSpy();
    const backend = testMode
      ? withBackendSpy(getPtyBackend(), spy)
      : getPtyBackend();
    const manager = new TerminalManager(backend, {
      onExit: (id, exit) => {
        // An agent tool that ends cleanly takes its tile with it (no shell is left behind); one
        // that fails keeps it, so its error and the exit banner can be read.
        const agent = managerRef.current?.profile(id)?.kind === "agent";
        if (agent && (exit.exitCode === 0 || exit.signal)) {
          setTimeout(() => closeRef.current(id), 0);
          return;
        }
        dispatch({
          type: "exited",
          id,
          exitCode: exit.exitCode,
          signal: exit.signal,
        });
      },
      // A shell retries on Enter; an SSH tile shows why on its Disconnected card, and an agent
      // tool's tile is marked exited (it never restarts).
      onSpawnError: (id, error) => {
        if (managerRef.current?.profile(id)?.kind === "shell") return;
        const message = error instanceof Error ? error.message : String(error);
        dispatch({ type: "exited", id, exitCode: null, message });
      },
      onRestart: (id) => dispatch({ type: "restarted", id, now: Date.now() }),
      onActivity: (id) => dispatch({ type: "activity", id }),
      // The shell needs a moment to start its foreground process before `info` is meaningful.
      onSpawned: (id) => setTimeout(() => void pollTitle(id), 400),
      onLink: (id, hit, e, how) =>
        void linksRef.current.onLink(id, hit, e, how),
      onBroadcastPaste: (id, data, tiles) =>
        broadcastRef.current.hold(id, data, tiles),
      onCommandDone: (id, done) => {
        dispatch({
          type: "commandDone",
          id,
          exitCode: done.exitCode,
          now: Date.now(),
        });
        commandDoneRef.current(id, done);
      },
      onCommandRunning: (id, running) =>
        dispatch({ type: "commandRunning", id, running }),
      onBell: (id) => dispatch({ type: "bell", id }),
      onTitle: (id, title) => dispatch({ type: "programTitle", id, title }),
      platform: plat,
      isWorkspaceShortcut: (e) =>
        commandForKey(e, plat) !== null ||
        isPushToTalk(e, pttKeyRef.current, plat),
    });
    managerRef.current = manager;
    if (testMode) installE2eHooks(manager, spy);
    setReady(true);
    return () => {
      mq?.removeEventListener?.("change", onMq);
      globalThis.removeEventListener("storage", onStorage);
      // The xterms go; the PTYs keep running for the next page that shows this workspace.
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

  // The colour theme: the chrome's CSS variables on <html> and every terminal's colours (new ones
  // too). A layout effect, so a hydrated theme is in place before the first paint after it and
  // before the first terminal is created.
  const themeId = state.settings.theme;
  useLayoutEffect(() => {
    const theme = themeById(themeId);
    applyChromeTheme(document.documentElement, theme);
    if (ready) managerRef.current?.setTheme(theme.terminal);
  }, [ready, themeId]);

  useSandboxSettings(
    ready ? managerRef.current?.backend ?? null : null,
    state.settings.sandbox,
  );

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
      // A modal dialog has the keyboard: only its own shortcut (which closes it) still works.
      if (modalOpen && cmd.kind !== "openConnections") return;
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
  }, [ready, platform, runCommand, settingsOpen, modalOpen]);

  // The Window menu's "Minimize Tile" / "Zoom Tile", chosen with this window key: the focused tile.
  useEffect(() => {
    const session = ready ? managerRef.current?.backend.session : undefined;
    if (!session) return;
    return session.onTileMenu((item) => {
      if (!isTileMenuItem(item)) return void viewRef.current.menuItem(item);
      const id = stateRef.current.focusedId;
      if (!id) return;
      tileControl(tileMenuControl(item, isMaximized(stateRef.current, id)), id);
    });
  }, [ready, tileControl]);

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

  // A tile's `done` shows for a few seconds: tick once more when the next one decays.
  const decayAt = nextDecay(state.terminals, now);
  useEffect(() => {
    if (decayAt === null) return;
    const t = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, decayAt - Date.now()) + 20,
    );
    return () => clearTimeout(t);
  }, [decayAt]);

  // An agent that starts waiting for the user while its tile is not focused latches attention,
  // as a bell does (the hub's status alone shows it only while it waits).
  const hubStatusRef = useRef(new Map<string, string>());
  useEffect(() => {
    const seen = hubStatusRef.current;
    for (const t of state.terminals) {
      const status = hubTileOf(t.id)?.status;
      if (status === "waiting" && seen.get(t.id) !== "waiting") {
        dispatch({ type: "bell", id: t.id });
      }
      if (status) seen.set(t.id, status);
      else seen.delete(t.id);
    }
  }, [hubTileOf, state.terminals]);

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

  // Minimized tiles are not laid out (keyed on which are minimized, not on every title change).
  const minimizedKey = state.terminals.filter((t) => t.minimized).map((t) =>
    t.id
  ).join(" ");
  const shown = useMemo(
    () => shownMru(stateRef.current),
    [state.mru, minimizedKey],
  );
  const layout = useMemo(
    () =>
      bounds.w > 0 && bounds.h > 0
        ? computeLayout(shown, bounds, settings.layout)
        : { tiles: [], overflow: shown },
    [shown, bounds, settings.layout],
  );
  const view = useFreeformView({
    state,
    shown,
    bounds,
    layout,
    run,
    focus: focusTerminal,
  });
  const viewRef = useRef(view);
  viewRef.current = view;
  const visibleIds = useMemo(
    () => visibleIdSet({ tiles: view.tiles }),
    [view.tiles],
  );

  // Each tile's one activity state (its header, border and chip; lib/workspace/activity.ts).
  const activity = useMemo(() => {
    const out = new Map<string, ActivityState>();
    for (const t of state.terminals) {
      out.set(
        t.id,
        tileActivity(
          {
            ...t,
            focused: t.id === focusedId,
            agentStatus: hubTileOf(t.id)?.status,
          },
          settings.activity,
          now,
        ),
      );
    }
    return out;
  }, [state.terminals, focusedId, hubTileOf, settings.activity, now]);

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
      data-view={state.view}
      data-focused={focusedId ?? ""}
      data-activity-mode={settings.activity.indicators}
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
        activity={activity}
        visibleIds={visibleIds}
        position={barPosition}
        pattern={settings.layout.pattern}
        platform={platform}
        desktop={desktop}
        settingsOpen={settingsOpen}
        onFocus={focusTerminal}
        onClose={closeTerminal}
        onNew={newTerminal}
        launch={{
          sections: launcher.sections,
          plusTitle: plusLabel(launcher.plus),
          plusEntryId: launcher.plus?.id,
          onLaunch: launcher.launchFromMenu,
          ...(launcher.sandboxChoice
            ? { sandbox: launcher.sandboxChoice }
            : {}),
          ...(ollama.status.installed
            ? {
              ollama: {
                newCount: ollama.newCount,
                onOpen: () => setOllamaOpen(true),
              },
            }
            : {}),
        }}
        onLaunchOpen={() => {
          launcher.refresh();
          ollama.refresh();
        }}
        onRefocus={() => {
          const id = stateRef.current.focusedId;
          if (id) focusKeyboard(id);
        }}
        connectionsOpen={ssh.dialog !== null}
        onConnections={ssh.toggleDialog}
        broadcast={{ on: broadcast.on, count: broadcast.state.members.length }}
        onBroadcast={broadcast.toggle}
        onPattern={(pattern) => run({ type: "setLayout", patch: { pattern } })}
        onMenuItem={view.menuItem}
        onToggleSettings={() => setSettingsOpen((o) => !o)}
        {...(monitor.meter ? { stats: sys.stats } : {})}
        workspaces={
          <WorkspacesMenu
            session={session}
            now={now}
            newWindowLabel={platform === "mac" ? "⌘N" : "Ctrl+N"}
          />
        }
      />
      <div class="cluster" ref={clusterRef} data-testid="cluster">
        {manager && (
          <TileCluster
            manager={manager}
            terminals={state.terminals}
            activity={activity}
            tileTitle={settings.tileTitle}
            tiles={view.tiles}
            freeform={view.freeform}
            focusedId={focusedId}
            decay={settings.layout.decay}
            now={now}
            reducedMotion={reducedMotion}
            scaleInactive={settings.inactiveTiles === "scale" &&
              !view.freeform}
            onFocus={focusTerminal}
            onClose={closeTerminal}
            maximizedId={maximizedId(state)}
            onMinimize={(id) => tileControl("minimize", id)}
            onMaximize={(id) => tileControl("maximize", id)}
            onRestore={(id) => tileControl("restoreTile", id)}
            onHeadDoubleClick={headDoubleClick}
            dropTargetId={ssh.dropTarget}
            agentOf={hubTileOf}
            web={webHooks}
            renderHeadActions={(entry) =>
              entry.ssh && (
                <SshHeadActions
                  entry={entry}
                  onDownload={() => ssh.browse(entry.id)}
                  onForwards={() => setForwardsFor(entry.id)}
                />
              )}
            renderHeadLead={(entry) =>
              broadcast.on && !entry.web && (
                <BroadcastCheck
                  checked={broadcast.members.has(entry.id)}
                  ssh={entry.ssh !== undefined}
                  onChange={(on) => broadcast.setChecked(entry.id, on)}
                />
              )}
            broadcastIds={broadcast.on ? broadcast.members : undefined}
            renderOverlay={(entry, focused) =>
              entry.ssh && (
                <SshTileOverlay
                  entry={entry}
                  focused={focused}
                  onReconnect={() => void manager.restart(entry.id)}
                  onClose={() => closeTerminal(entry.id)}
                  {...ssh.tile(entry.id)}
                />
              )}
          />
        )}
        {manager && effectiveMode(settings.companion.mode) === "window" && (
          <CompanionOverlay
            backend={manager.backend}
            corner={settings.companion.corner}
            brain={settings.companion.brain}
            lively={settings.companion.lively}
            reducedMotion={reducedMotion}
            onRefocus={refocus}
            onCorner={(corner) =>
              run({ type: "setCompanion", patch: { corner } })}
            voice={voice}
            pttLabel={pttAvailable(settings.voice.pttKey, platform)
              ? shortcutLabel(settings.voice.pttKey, platform)
              : ""}
            hot={hotWanted && sys.hot}
            onHotShown={onHotShown}
            reactions={{
              nightSleepy: settings.companion.nightSleepy,
              nightFrom: settings.companion.nightFrom,
              nightTo: settings.companion.nightTo,
              bubble: settings.companion.reactBubble,
            }}
            {...(reactions.reaction ? { reaction: reactions.reaction } : {})}
            onReactionShown={reactions.onShown}
          />
        )}
        {broadcast.on && (
          <BroadcastBanner
            state={broadcast.state}
            nonSsh={broadcast.nonSsh}
            held={broadcast.held}
            shortcut={shortcutLabel("Mod+Shift+I", platform)}
            onStop={broadcast.toggle}
            onPaste={broadcast.resolvePaste}
          />
        )}
        {ready && session.booted && state.terminals.length > 0 &&
          focusedId === null && (
            // Every tile is minimized: their chips in the bar restore them.
            <div class="empty is-minimized" data-testid="all-minimized">
              <p>All tiles minimized</p>
            </div>
          )}
        {ready && session.booted && state.terminals.length === 0 && (
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
          view={state.view}
          onView={view.setView}
          onDefaultView={(v) => run({ type: "setDefaultView", view: v })}
          onBarPosition={(position) =>
            run({ type: "setBarPosition", position })}
          onBarOrder={(order) => run({ type: "setBarOrder", order })}
          onInactiveTiles={(mode) => run({ type: "setInactiveTiles", mode })}
          onActivity={(patch) => run({ type: "setActivity", patch })}
          onTileTitle={(tileTitle) => run({ type: "setTileTitle", tileTitle })}
          onFont={(patch) => run({ type: "setFont", patch })}
          onTheme={(theme) => run({ type: "setTheme", theme })}
          onToggleSection={(section) => run({ type: "toggleSection", section })}
          launchSections={launcher.sections}
          onPlusOpens={(plusOpens) => run({ type: "setPlusOpens", plusOpens })}
          onCompanion={(patch) => run({ type: "setCompanion", patch })}
          onVoice={(patch) => run({ type: "setVoice", patch })}
          voice={manager ? voice : null}
          onSandbox={(patch) => run({ type: "setSandbox", patch })}
          {...(ollama.loaded ? { ollama } : {})}
          onOllama={(patch) => run({ type: "setOllama", patch })}
          onLinks={(patch) => run({ type: "setLinks", patch })}
          onMonitor={(patch) => run({ type: "setMonitor", patch })}
          {...(windowClose.guarded
            ? {
              onWindowClose: (choice: WindowClose) =>
                run({ type: "setWindowClose", windowClose: choice }),
            }
            : {})}
          backend={manager?.backend ?? null}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {manager && ollamaOpen && (
        <OllamaDialog
          backend={manager.backend}
          status={ollama.status}
          settings={settings.ollama}
          newCount={ollama.newCount}
          onLaunch={launchOllama}
          onPull={pullOllama}
          onLooked={() =>
            run({ type: "setOllama", patch: { libraryLookedAt: Date.now() } })}
          onClose={() => {
            setOllamaOpen(false);
            refocus();
          }}
        />
      )}
      {windowClose.asking && (
        <CloseWindowDialog
          terminals={state.terminals.filter((t) => !t.web).length}
          onAnswer={windowClose.answer}
        />
      )}
      {manager && effectiveMode(settings.companion.mode) === "off" && (
        <AskDialog backend={manager.backend} onDone={refocus} />
      )}
      {manager && ssh.dialog && (
        <ConnectionsDialog
          backend={manager.backend}
          platform={platform}
          initialForm={ssh.dialog.form}
          onConnect={ssh.connect}
          onClose={ssh.closeDialog}
        />
      )}
      {links.menu && (
        <LinkMenu
          x={links.menu.x}
          y={links.menu.y}
          title={links.menu.title}
          items={links.menu.items}
          onClose={links.closeMenu}
        />
      )}
      {manager && forwardsFor && (
        <ForwardsFor
          id={forwardsFor}
          manager={manager}
          onClose={() => {
            setForwardsFor(null);
            refocus();
          }}
        />
      )}
      {manager && ssh.browseFor && (
        <BrowserFor
          id={ssh.browseFor}
          manager={manager}
          onPick={(path) => void ssh.download(ssh.browseFor!, path)}
          onClose={ssh.closeBrowser}
        />
      )}
    </div>
  );
}

/** The port forwards of SSH tile `id`'s connection (nothing when `id` is not an SSH tile). */
function ForwardsFor(props: {
  id: string;
  manager: TerminalManager;
  onClose(): void;
}) {
  const profile = props.manager.profile(props.id);
  if (profile?.kind !== "ssh") return null;
  return (
    <ForwardsDialog
      backend={props.manager.backend}
      target={profile.target}
      label={profile.label}
      onClose={props.onClose}
    />
  );
}

/** The download picker for SSH tile `id` (nothing when `id` is not an SSH tile). */
function BrowserFor(props: {
  id: string;
  manager: TerminalManager;
  onPick(path: string): void;
  onClose(): void;
}) {
  const profile = props.manager.profile(props.id);
  if (profile?.kind !== "ssh") return null;
  return (
    <RemoteBrowser
      backend={props.manager.backend}
      target={profile.target}
      label={profile.label}
      onPick={props.onPick}
      onClose={props.onClose}
    />
  );
}

/**
 * The user's title-bar double-click action (`maximize`, `minimize`, `none`, …), read at each
 * double click as Denext's `makeWindowDraggable` does (the user may have changed it); `maximize`
 * outside the desktop app, or when the runtime cannot say.
 */
function titleBarDoubleClick(): Promise<string> {
  if (!isDesktop()) return Promise.resolve("maximize");
  return getTitleBarPreferences().then((p) => p.doubleClick, () => "maximize");
}

/** Whether tile `id` is a web tile (it has no terminal). */
function isWebTile(
  terminals: readonly { id: string; web?: unknown }[],
  id: string,
): boolean {
  return terminals.some((t) => t.id === id && t.web !== undefined);
}
