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
// Windows are views of workspaces (desktop/workspace-host.ts): a window's key is its workspace's
// id. Here: New Window (Cmd+N) opens a fresh workspace, a Dock click with no window showing
// reopens the workspace detached last (or a fresh one), and an ended workspace's key is
// forgotten, so Reopen Closed Window, the Dock and the next launch's restored session never offer
// it again (desktop/windows.ts). The quit guard (Cmd+Q asks first when an agent is busy) is the
// `session` extension's (desktop/session.ts).
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";
import { workspaces } from "./desktop/workspace-host.ts";
import { dockReopenWindow, forgetEndedWorkspaces } from "./desktop/windows.ts";
import { newWorkspaceId, workspaceWindow } from "./lib/workspace/windows.ts";
import { detachSelfTest } from "./desktop/selftest.ts";

const app = await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
  newWindow: () => workspaceWindow(newWorkspaceId(), true),
  onDockReopen: () => dockReopenWindow(workspaces, app.windows),
});

if (!app.sidecarChild) {
  forgetEndedWorkspaces(workspaces, app.windows);

  if (Deno.env.get("QUTTY_PTY_SELFTEST") === "detach") {
    detachSelfTest(app).then(() => Deno.exit(0), (e) => {
      console.error(`detach self-test: FAILED: ${e?.message ?? e}`);
      Deno.exit(1);
    });
  }
}
