"use client";

// The workspace island: owns the store, the terminal manager, the keyboard and the layout
// measurement, and renders the switcher bar, the tile cluster and the settings popover. The
// SSH half (connection manager, download picker, transfers, drops) lives in `useSsh`; the agent
// hub's tiles (the agent badges) in `useHub`; the companion (Loopy, in a corner of the tile area:
// `ask_user` questions, `qutty-hook say`, the chat with its brain) in `CompanionOverlay`, its
// settings and commands in `useCompanion`. With the companion Off, `AskDialog` asks instead.
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
import {
  type BackendSpy,
  installE2eHooks,
  isTestMode,
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
import { terminalFontOptions } from "../lib/workspace/fonts.ts";
import { applyChromeTheme, themeById } from "../lib/workspace/themes.ts";
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
import {
  baseName,
  SHELL_PROFILE,
  type TerminalProfile,
} from "../lib/ssh-ui.ts";
import { ConnectionsDialog } from "./connections-dialog.tsx";
import { RemoteBrowser } from "./remote-browser.tsx";
import { SshHeadActions, SshTileOverlay } from "./ssh-overlays.tsx";
import { useSsh } from "./use-ssh.ts";
import { useLauncher } from "./use-launcher.ts";
import { useHub } from "./use-hub.ts";
import { AskDialog } from "./ask-dialog.tsx";
import { CompanionOverlay } from "./companion/companion-overlay.tsx";
import { useCompanion } from "./use-companion.ts";
import { useVoice } from "./use-voice.ts";
import { flatEntries, plusLabel } from "../lib/launcher.ts";
import { effectiveMode } from "../lib/companion/settings.ts";
import { opensInSandbox } from "../lib/sandbox/settings.ts";
import { useSandboxSettings } from "./sandbox-settings.tsx";
import { useOllama } from "./use-ollama.ts";
import { OllamaDialog } from "./ollama-dialog.tsx";
import { ollamaProfile, pullProfile } from "../lib/ollama/harnesses.ts";
import {
  type OllamaPair,
  pairEntryId,
  pairTitle,
} from "../lib/ollama/settings.ts";

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
    if (after.focusedId && after.focusedId !== before.focusedId) {
      managerRef.current?.focus(after.focusedId);
    }
  }, []);

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
      if (id) managerRef.current?.focus(id);
    },
    cluster: clusterRef,
  });
  const sshRef = useRef(ssh);
  sshRef.current = ssh;

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
  const modalOpen = ssh.dialog !== null || ssh.browseFor !== null ||
    ollamaOpen;
  const hubTileOf = useHub(managerRef.current, state.terminals);

  const closeTerminal = useCallback((id: string) => {
    managerRef.current?.dispose(id);
    sshRef.current.forget(id);
    run({ type: "remove", id });
  }, [run]);
  const closeRef = useRef(closeTerminal);
  closeRef.current = closeTerminal;

  const focusTerminal = useCallback((id: string) => {
    run({ type: "focus", id, now: Date.now() });
    managerRef.current?.focus(id);
  }, [run]);

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
    if (id) managerRef.current?.focus(id);
  }, []);
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

    // `?test=1` (the e2e suite): record PTY kills and resizes and expose terminal state on
    // `window.__e2e`.
    const testMode = isTestMode();
    const spy: BackendSpy = { kills: [], resizes: [] };
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
      isWorkspaceShortcut: (e) =>
        commandForKey(e, plat) !== null ||
        isPushToTalk(e, pttKeyRef.current, plat),
    });
    managerRef.current = manager;
    if (testMode) installE2eHooks(manager, spy);
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

  // The colour theme: the chrome's CSS variables on <html> and every terminal's colours (new ones
  // too). A layout effect, so a hydrated theme is in place before the first paint after it and
  // before the first terminal is created.
  const themeId = state.settings.theme;
  useLayoutEffect(() => {
    const theme = themeById(themeId);
    applyChromeTheme(document.documentElement, theme);
    if (ready) managerRef.current?.setTheme(theme.terminal);
  }, [ready, themeId]);

  // The first terminal, once the manager exists.
  useEffect(() => {
    // Always the default shell on the host, whatever plain `+` is set to open.
    if (
      ready && stateRef.current.terminals.length === 0 && seqRef.current === 0
    ) openTile({ kind: "shell", sandbox: false });
  }, [ready, openTile]);

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
          if (id) managerRef.current?.focus(id);
        }}
        connectionsOpen={ssh.dialog !== null}
        onConnections={ssh.toggleDialog}
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
            scaleInactive={settings.inactiveTiles === "scale"}
            onFocus={focusTerminal}
            onClose={closeTerminal}
            dropTargetId={ssh.dropTarget}
            agentOf={hubTileOf}
            renderHeadActions={(entry) =>
              entry.ssh && (
                <SshHeadActions
                  entry={entry}
                  onDownload={() => ssh.browse(entry.id)}
                />
              )}
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
            reducedMotion={reducedMotion}
            onRefocus={refocus}
            voice={voice}
            pttLabel={pttAvailable(settings.voice.pttKey, platform)
              ? shortcutLabel(settings.voice.pttKey, platform)
              : ""}
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
          onInactiveTiles={(mode) => run({ type: "setInactiveTiles", mode })}
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
