// Entry for `deno desktop` — serves the static export in `out/` inside a native
// window (run `deno task export` first, or `deno task desktop`, which exports then
// launches the window). The serve + window plumbing lives in denext's desktop runtime;
// pass `import.meta.url` so `out/` resolves relative to this entry (works from the
// packaged app too).
//
// Native capabilities (`denext desktop add <cap>`) are read from `desktop.capabilities`
// in the config and served through the gated bridge — default deny when `desktop` is
// absent; a backend reverse proxy is `spa.proxy`. Both arrive through
// `.deno-desktop/config.json`, the runtime part of `denext.config.ts` that every export, build
// and `denext desktop` command rewrites: the config module itself (and any plugin it imports)
// is never compiled into the app.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";

await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
});
