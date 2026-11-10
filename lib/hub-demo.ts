// The demo backend's agent hub (plain-browser development and the e2e suite), beside the demo SSH
// in lib/ssh-demo.ts. Every demo terminal is a hub tile, kept in the real registry
// (lib/hub/registry.ts: the same default names, `claude`, `claude-2`, `shell-3`); a demo agent tool
// registers with its harness, so the page draws its badge. What the demo agents can do with it
// (see `DemoShell.runAgent` in lib/pty-client.ts):
//
// - any line: the agent is busy for a moment, then idle again;
// - `/ask [question]`: an `ask_user` question with Yes / No. The page's answer is printed in the
//   asking terminal ("(demo) the user answered: Yes"), which proves it reached the caller;
// - `/msg <name> <text>`: a message for another tile. Its unread count goes up until that tile's
//   agent takes its next turn (any line typed into it), which prints the message and clears it.
//
// - `/msg companion <text>`: a message for the companion (Loopy), handled by the fake brain
//   (lib/companion/demo-brain.ts) under the real companion runtime;
// - `/say <text> [--mood m] [--action id:label] [--wait]`: `qutty-hook say` (the answer to a
//   `--wait` is printed).
//
// The companion's chat box talks to that same fake brain; its privileged actions go to the
// audit list in Settings like the desktop app's. The API key brain's key is kept in memory
// (the desktop app keeps it in the OS keychain), set, cleared and asked about, never read back.
//
// Settings → Agent integration runs the real installer (lib/hub/integration.ts) over an in-memory
// home folder (`/Users/demo`) that starts with small agent configs of its own, so Install and
// Uninstall show and do exactly what the desktop app would. With `codexUntrusted` (the page's
// `?codexTrust=untrusted`), the installed Codex integration reports Codex's hooks as untrusted
// (the warning and Re-trust), until it is installed again (Re-trust).
//
// Client-safe: only the hub modules without Deno or npm dependencies are imported.

import {
  type ConfigFs,
  installIntegration,
  integrationFiles,
  integrationStatus,
  uninstallIntegration,
} from "./hub/integration.ts";
import { hubPaths } from "./hub/launch.ts";
import { companionKeys } from "./companion/keys.ts";
import { memorySecretStore } from "./secrets/api-keys.ts";
import { codexTrustWarning } from "./hub/codex-trust.ts";
import { CODEX_HOOK_EVENTS } from "./hub/hooks.ts";
import type {
  AskRequest,
  HubSnapshot,
  IntegrationStatus,
  IntegrationTarget,
  TileStatus,
} from "./hub/protocol.ts";
import { Registry } from "./hub/registry.ts";
import { Mailboxes } from "./hub/mailbox.ts";
import { COMPANION } from "./hub/protocol.ts";
import type { ControlCommand, ControlResult } from "./hub/core.ts";
import { CompanionRuntime } from "./companion/runtime.ts";
import { DemoBrain } from "./companion/demo-brain.ts";
import { AuditLog } from "./companion/audit.ts";
import { parseSayRequest } from "./companion/messages.ts";
import { parseSayArgs } from "./companion/say-args.ts";
import type { CompanionUpdate, SayEvent } from "./companion/protocol.ts";

/** Where the demo hub's events go (the demo backend's fan-outs to the page). */
export interface DemoHubEmit {
  /** A full snapshot after every change (coalesced: one per burst, after the current task). */
  tiles(snapshot: HubSnapshot): void;
  ask(request: AskRequest): void;
  askClosed(id: string): void;
  companion(update: CompanionUpdate): void;
  say(say: SayEvent): void;
  control(request: { requestId: string; command: ControlCommand }): void;
}

/** A message one demo tile queued for another. */
interface DemoMessage {
  fromName: string;
  text: string;
}

const DEMO_HOME = "/Users/demo";

/** The demo home's agent configs before any Install (the user's own settings, to be kept). */
function demoConfigFiles(): Map<string, string> {
  return new Map([
    [
      `${DEMO_HOME}/.claude.json`,
      '{\n  "numStartups": 12,\n  "theme": "dark"\n}\n',
    ],
    [
      `${DEMO_HOME}/.claude/settings.json`,
      '{\n  "model": "opus",\n  "hooks": {}\n}\n',
    ],
    [`${DEMO_HOME}/.codex/config.toml`, 'model = "gpt-5-codex"\n'],
  ]);
}

/** {@linkcode ConfigFs} over a map of path → text (no symlinks; every file is 0644). */
function memoryFs(files: Map<string, string>): ConfigFs {
  return {
    read: (path) => Promise.resolve(files.get(path)),
    write(path, text) {
      files.set(path, text);
      return Promise.resolve();
    },
    remove(path) {
      files.delete(path);
      return Promise.resolve();
    },
    mode: (path) => Promise.resolve(files.has(path) ? 0o644 : undefined),
    realPath: (path) => Promise.resolve(path),
  };
}

/**
 * A new demo hub. `emit` delivers its events to the page; the demo backend's terminals call the
 * tile half (`add`, `remove`, `setStatus`, `ask`, `send`, `take`). `codexUntrusted`: fake a Codex
 * that does not trust Qutty's installed hooks, until Re-trust.
 */
export function createDemoHub(
  emit: DemoHubEmit,
  opts: { codexUntrusted?: boolean } = {},
) {
  let pendingTiles: ReturnType<typeof setTimeout> | undefined;
  const snapshot = (): HubSnapshot => ({
    running: true,
    tiles: registry.list(),
  });
  // Coalesced and a little late, like the desktop event: the page learns a terminal's PTY id
  // from `spawn` before it hears about the tile.
  const registry = new Registry(() => {
    pendingTiles ??= setTimeout(() => {
      pendingTiles = undefined;
      emit.tiles(snapshot());
    }, 0);
  });
  const asks = new Map<
    string,
    { request: AskRequest; reply(action: string | null): void }
  >();
  const inboxes = new Map<string, DemoMessage[]>();
  let nextAsk = 0;

  // The companion: the real runtime over the fake brain, the companion's real mailbox.
  const companionBox = new Mailboxes((owner) => {
    if (owner === COMPANION && companionBox.unread(COMPANION) > 0) {
      runtime.mailArrived();
    }
  });
  // The API key brain's key, in memory (the desktop app's hub keeps it in the OS keychain).
  const keyStore = memorySecretStore();
  const keys = companionKeys(() => keyStore);
  const audit = new AuditLog(
    undefined,
    (entry) => emit.companion({ kind: "activity", entry }),
  );
  const controls = new Map<string, (r: ControlResult) => void>();
  let nextControl = 0;
  const control = (command: ControlCommand): Promise<ControlResult> => {
    const requestId = `demo-ctl-${++nextControl}`;
    return new Promise<ControlResult>((resolve) => {
      controls.set(requestId, resolve);
      emit.control({ requestId, command });
    }).then((result) => {
      audit.record({
        tool: `${command.kind}_tile`,
        by: COMPANION,
        args: { ...command },
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error }),
      });
      return result;
    });
  };
  const runtime = new CompanionRuntime({
    mailbox: companionBox,
    adapter: "Demo brain",
    enabled: false, // until the page sends its settings
    emit: (update) => emit.companion(update),
    createBrain: () =>
      new DemoBrain({
        tiles: () => registry.list(),
        send: (to, text) => deliverTo(COMPANION, COMPANION, to, text),
        control,
      }),
  });
  const says = new Map<string, (action: string | null) => void>();

  /** Queue `text` from `fromName` for the tile `to` names; its name, or `undefined`. */
  const deliverTo = (
    from: string,
    fromName: string,
    to: string,
    text: string,
  ): string | undefined => {
    const recipient = registry.resolve(to);
    if (!recipient || recipient.id === from) return undefined;
    const inbox = inboxes.get(recipient.id) ?? [];
    inbox.push({ fromName, text });
    inboxes.set(recipient.id, inbox);
    registry.setUnread(recipient.id, inbox.length);
    return recipient.name;
  };

  const fs = memoryFs(demoConfigFiles());
  const paths = hubPaths(DEMO_HOME);
  const files = integrationFiles(DEMO_HOME, paths);
  let codexTrusted = !opts.codexUntrusted;
  const status = async () => {
    const rows = await integrationStatus(fs, files, paths);
    const codex = rows.find((r) => r.target === "codex");
    if (codex?.installed && !codexTrusted) {
      codex.trust = "untrusted";
      codex.warning = codexTrustWarning({
        trusted: false,
        untrusted: [...CODEX_HOOK_EVENTS],
        hashChanged: false,
      });
    }
    return rows;
  };

  /** Close question `id` (answered, or its tile went away) without replying. */
  const close = (id: string) => {
    const a = asks.get(id);
    if (!a) return undefined;
    asks.delete(id);
    emit.askClosed(id);
    return a;
  };

  return {
    // --- The page's half (what the `hub` desktop extension offers) -------------------------

    snapshot(): Promise<HubSnapshot & { asks: AskRequest[] }> {
      return Promise.resolve({
        ...snapshot(),
        asks: [...asks.values()].map((a) => ({ ...a.request })),
      });
    },
    /** The user's answer (`null`: dismissed); false when the question is already closed. */
    answer(id: string, action: string | null): Promise<boolean> {
      const a = close(id);
      a?.reply(action);
      return Promise.resolve(a !== undefined);
    },
    setLabel(id: string, label: string): Promise<void> {
      registry.setMeta(id, { label });
      return Promise.resolve();
    },
    integrationStatus: (): Promise<IntegrationStatus[]> => status(),
    async integrationInstall(
      target: IntegrationTarget,
    ): Promise<IntegrationStatus[]> {
      // Installing the installed Codex block again is Re-trust.
      const before = (await status()).find((r) => r.target === target);
      if (target === "codex" && before?.installed) codexTrusted = true;
      await installIntegration(fs, files, paths, target);
      return await status();
    },
    async integrationUninstall(
      target: IntegrationTarget,
    ): Promise<IntegrationStatus[]> {
      await uninstallIntegration(fs, files, paths, target);
      return await status();
    },

    // --- The demo terminals' half ----------------------------------------------------------

    /** Register terminal `id` (an agent tool with its `harness`); returns its hub name. */
    add(id: string, harness?: string, sandbox = false, model?: string): string {
      const name = registry.add({
        id,
        ...(harness ? { harness } : {}),
        ...(model ? { model } : {}),
        ...(sandbox ? { sandbox } : {}),
      }).name;
      // A demo agent's SessionStart hook would send its session id.
      if (harness) registry.setSession(id, `demo-session-${id}`);
      return name;
    },
    /** Terminal `id` ended: its tile, mailbox and open questions go. */
    remove(id: string): void {
      registry.remove(id);
      inboxes.delete(id);
      for (const [askId, a] of [...asks]) {
        if (a.request.from === id) close(askId);
      }
    },
    setStatus(id: string, status: TileStatus, note?: string): void {
      registry.setStatus(id, status, note);
    },
    /**
     * Ask the user from tile `from`: the tile waits until `reply` gets the answer (`null` when
     * dismissed). Returns the question's id.
     */
    ask(
      from: string,
      text: string,
      actions: string[],
      reply: (action: string | null) => void,
    ): string {
      const id = `demo-ask-${++nextAsk}`;
      const request: AskRequest = {
        id,
        from,
        fromName: registry.get(from)?.name ?? from,
        text,
        actions: [...actions],
      };
      registry.setStatus(from, "waiting");
      asks.set(id, {
        request,
        reply(action) {
          registry.setStatus(from, "idle");
          reply(action);
        },
      });
      emit.ask({ ...request, actions: [...actions] });
      return id;
    },
    /**
     * Queue a message from tile `from` for the tile named (or with id) `to`. Returns the
     * recipient's name, or `undefined` when there is no other tile by that name.
     */
    send(from: string, to: string, text: string): string | undefined {
      const fromName = registry.get(from)?.name ?? from;
      if (to.toLowerCase() === COMPANION) {
        companionBox.post({ from, fromName, to: COMPANION, text });
        return COMPANION;
      }
      return deliverTo(from, fromName, to, text);
    },
    /**
     * `qutty-hook say …` from tile `from`: the bubble shows it; `reply` gets the button pressed
     * when the args ask to `--wait`. Returns an error to print, if any.
     */
    say(
      from: string,
      args: string[],
      reply: (action: string | null) => void,
    ): string | undefined {
      try {
        const { message, wait } = parseSayRequest(parseSayArgs(args));
        if (wait) says.set(message.id, reply);
        emit.say({
          message: { ...message, from: registry.get(from)?.name ?? from },
          wait,
        });
        return undefined;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    /** The companion's page half (the `hub` extension's companion methods). */
    companion: {
      keyStatus: () => keys.presence(),
      keySet: (key: string) => keys.set("anthropic", key),
      keyClear: () => keys.clear("anthropic"),
      status: () =>
        Promise.resolve({
          status: runtime.status(),
          activity: audit.recent(),
        }),
      send: (text: string, via: "chat" | "voice" = "chat") =>
        Promise.resolve({ turn: runtime.userSays(text, via) }),
      configure(enabled: boolean, model: string, engine = "claude") {
        // The demo brain answers either way; the label says which one Settings picked.
        runtime.setAdapter(
          engine === "ollama"
            ? `Demo brain (Ollama ${model || "?"})`
            : engine === "anthropic"
            ? `Demo brain (Anthropic API ${model || "default"})`
            : "Demo brain",
        );
        runtime.setEnabled(enabled);
        return Promise.resolve(runtime.status());
      },
      sayDone(id: string, action: string | null): Promise<boolean> {
        const done = says.get(id);
        says.delete(id);
        done?.(action);
        return Promise.resolve(done !== undefined);
      },
      controlDone(requestId: string, result: ControlResult): Promise<boolean> {
        const done = controls.get(requestId);
        controls.delete(requestId);
        done?.(result);
        return Promise.resolve(done !== undefined);
      },
    },
    /** Hand tile `id` its queued messages (its unread count drops to 0). */
    take(id: string): DemoMessage[] {
      const inbox = inboxes.get(id) ?? [];
      inboxes.delete(id);
      if (inbox.length > 0) registry.setUnread(id, 0);
      return inbox;
    },
    /** Stop the pending snapshot timer (tests). */
    dispose(): void {
      clearTimeout(pendingTiles);
      pendingTiles = undefined;
      runtime.stop();
    },
  };
}

/** The demo hub (see {@linkcode createDemoHub}). */
export type DemoHub = ReturnType<typeof createDemoHub>;
