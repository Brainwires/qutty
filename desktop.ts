// Entry for `deno desktop` — serves the static export in `out/` inside a native window (run
// `deno task export` first, or `deno task desktop`, which exports then launches the window). The
// serve + window plumbing lives in denext's desktop runtime; pass `import.meta.url` so `out/`
// resolves relative to this entry (works from the packaged app too).
//
// Native capabilities (`denext desktop add <cap>`) are read from `desktop.capabilities` in the
// config and served through the gated bridge — default deny when `desktop` is absent; a backend
// reverse proxy is `spa.proxy`. Both arrive through `.deno-desktop/config.json`, the runtime part
// of `denext.config.ts` that every export, build and `denext desktop` command rewrites: the config
// module itself (and any plugin it imports) is never compiled into the app.
//
// The window is a view of a workspace (desktop/workspace-host.ts): its key is the workspace's id.
// Here: a Dock click with no window open reopens the workspace detached last, and Cmd+Q asks first
// when an agent is busy.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";
import { workspaces } from "./desktop/workspace-host.ts";
import { MAIN_WORKSPACE, workspaceWindow } from "./lib/workspace/windows.ts";
import { detachSelfTest } from "./desktop/selftest.ts";

const app = await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
});

if (!app.sidecarChild) {
  // The Dock icon clicked with every window closed: show the last detached workspace again.
  const dock = (Deno as unknown as { dock?: EventTarget }).dock;
  dock?.addEventListener?.("reopen", (event) => {
    const visible = (event as CustomEvent<{ hasVisibleWindows?: boolean }>)
      .detail?.hasVisibleWindows;
    if (
      visible === true || app.windows.list().some((w) => w.kind !== "panel")
    ) {
      return;
    }
    const last = workspaces.lastDetached();
    app.windows.open(
      workspaceWindow(last ?? MAIN_WORKSPACE),
    );
  });

  // Cmd+Q kills every terminal: ask first when an agent is working.
  app.onBeforeQuit(() => {
    const decision = workspaces.beforeQuit();
    if (decision.allow) return true;
    if (decision.window !== undefined) {
      app.windows.get(decision.window)?.focus();
      app.emit("session", "quit", decision.request, {
        window: decision.window,
      });
    } else if (decision.open !== undefined) {
      // No window is open: show the busy agent's workspace, whose page asks (from `join`).
      app.windows.open(workspaceWindow(decision.open));
    }
    return false;
  });

  if (Deno.env.get("QUTTY_PTY_SELFTEST") === "detach") {
    detachSelfTest(app).then(() => Deno.exit(0), (e) => {
      console.error(`detach self-test: FAILED: ${e?.message ?? e}`);
      Deno.exit(1);
    });
  }
}
