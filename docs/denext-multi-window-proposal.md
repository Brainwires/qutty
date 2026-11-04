# Proposal: first-class multi-window and detach support in Denext desktop

**From:** the Qutty project (`Brainwires/qutty`, a tiling terminal built on
Denext 4.12.0) **For:** the agent working in `Brainwires/denext` **Status:**
proposal; please validate it against the code before building. Push back where
Denext already covers something or a different shape fits better.

## Why

Qutty wants two features that every serious multi-window desktop app also needs:

1. **New Window.** Cmd+N opens another window, and each window holds its own set
   of terminals.
2. **Detach / reattach.** Closing a window must not kill its terminals: the
   shells keep running with the app alive and windowless, and reopening the app
   (or "Reopen Closed Window") brings the window back with its terminals and
   their recent output.

Most of this is generic: window lifecycle, ownership of backend resources by a
window, restoring windows, and replaying what a window missed. Only the
terminal-specific parts belong in Qutty. If Denext provides the generic layer,
Qutty's code shrinks to "a workspace store on top of Denext's window APIs", and
every other Denext desktop app gets the same capabilities.

## What Denext already has (what we build on)

- **Window registry**, `src/desktop/window-registry.ts`: `createWindowRegistry`
  with `adopt`, `open`, `get`, `list`, `close` and `closed`, plus the `window`
  and `windows` capabilities. The limit is `MAX_OPEN_WINDOWS = 8`, and every
  window carries a per-window token.
- **App windows API**, `src/desktop/app-windows.ts`:
  - `DesktopWindows.open()`, and `DesktopWindowRef` with `onClosed`,
    `getBounds`, `navigate`, `show`, `hide` and `focus`.
  - `keepAlive()` and `interceptMainClose()`.
  - `DesktopAppSettings.keepAlive` (`desktop.app.keepAlive`).
- **Extensions**, `src/desktop/extension.ts`:
  - `DesktopCapCtx.windowId`, and `perWindow` + `onPageLoad(windowId)`.
  - `emit(event, data, { window })` targets a single window.
  - `setup(host)` gives a process-level `DesktopExtensionHost.emit`.
- **Event replay**, `src/desktop/bridge-events.ts`: a bounded, drop-oldest log
  replayed by `Last-Event-ID`.

## Gaps

### 1. Extensions can't tell a closed window from a reloaded one

`onPageLoad(windowId)` fires on reload and navigation. Nothing tells an
extension that a window has closed for good, or that the app is quitting. A
`perWindow` extension that owns processes (Qutty's PTYs) therefore can't:

- kill a closed window's resources, or deliberately keep them (detach);
- clean up on quit.

Today a closed secondary window's resources just leak until the process exits.

**Proposal:** add these optional `DesktopCapability` hooks:

```ts
/** A window was opened (adopted main, panel, or openWindow). */
onWindowOpened?: (windowId: string, info: { kind: "main" | "panel" | "window" }) => void;
/**
 * A window closed for good (user, close(), or its page). `appQuitting` is true when the close is
 * part of the app quitting. Not called for reloads (that is onPageLoad).
 */
onWindowClosed?: (windowId: string, info: { appQuitting: boolean }) => void | Promise<void>;
/** The app is about to quit (after the last window closes without keepAlive, or Cmd+Q). Awaited with a bounded timeout. */
onAppQuit?: () => void | Promise<void>;
```

The registry's `closed(id)` and `onClosed` already know about closes, so this
means forwarding them to extensions, with a reason. The bridge decides
`appQuitting` (Cmd+Q, or the last window closing without `keepAlive`).

### 2. Distinguishing "close window" from "quit app" on macOS

On macOS, closing the last window should leave a `keepAlive` app running (Dock
icon, menu bar), while Cmd+Q quits. Apps need a reliable quit signal (gap 1's
`onAppQuit`) and a way to answer "is anything still running?" before quitting.
For Qutty: "3 terminals are still running, quit anyway?".

**Proposal:** add a quit guard, the app-level counterpart of
`interceptMainClose`:

```ts
// desktop.ts (DesktopRuntime) or an extension's setup(host):
onBeforeQuit(handler: () => boolean | Promise<boolean>): () => void; // false cancels the quit
```

### 3. Stable window identity and restore across launches

Window ids today are `"main"`, `"panel"`, `"window-1"` and so on, allocated per
run. To reopen "the same" windows after a relaunch (or after a detach with the
app quit), an app needs:

- an **app-chosen stable key** per window (Qutty's workspace id), passed to
  `open()` and reported back (`DesktopWindowRef.key`), unique among open
  windows;
- **frame persistence**: bounds, and screen/space where the runtime allows,
  saved per key in `appSupportDir` and restored on `open({ key })` unless
  explicit bounds are given;
- optionally, a declarative **session restore**:
  `desktop.app.restoreWindows: true` reopens the last session's keyed windows
  (url + key) at launch. Apps that want control can do it themselves from the
  saved list (`windows.lastSession()`).

```ts
open({ url: "/", key: "ws-3f2a", restoreBounds: true }): DesktopWindowRef; // ref.key === "ws-3f2a"
windows.byKey("ws-3f2a"): DesktopWindowRef | undefined;
windows.lastSession(): Array<{ key: string; url: string; bounds?: Bounds }>;
```

### 4. Window-scoped resources with ownership transfer (the detach primitive)

Many extensions own long-lived backend resources on behalf of a window: Qutty's
PTYs, file watchers, subprocesses, network sessions. The pattern needs:

- an owner (window key or id), set on creation from `ctx.windowId`;
- events routed **only** to the owner (`emit(..., { window })` already exists;
  it should be the default for owned resources);
- **detach** (owner = none) instead of disposal when the window closes, if the
  app opts in;
- **attach** of a detached resource (or a move between windows) by a new window,
  after which its events go to the new owner;
- a **per-resource replay buffer**, so the attaching window can redraw state it
  never saw. The global `bridge-events` log is shared and bounded, so it can't
  hold, say, one terminal's last 2 MB of output while another terminal is
  chatty.

**Proposal:** a small helper in `denext/desktop`, rather than new runtime
machinery:

```ts
const sessions = createOwnedResources<PtySession>({
  /** What happens to a closed window's resources: "dispose" (default) or "detach" (needs keepAlive). */
  onOwnerClosed: "detach",
  dispose: (s) => s.kill(),
  replay: { maxBytes: 2 * 1024 * 1024 }, // optional per-resource replay ring buffer
});
sessions.add(id, session, { owner: ctx.windowId });
sessions.emit(id, "data", payload); // to the owner only; appended to that resource's replay
sessions.attach(id, ctx.windowId); // returns the replay chunks for the new owner
sessions.detached(); // ids with no owner (for a "Reopen" menu)
sessions.ownedBy(windowIdOrKey); // for restore
```

It wires itself to gap 1's hooks (`onWindowClosed`, `onAppQuit`), so extensions
don't each reimplement ownership bookkeeping.

### 5. Standard window menu items

Multi-window apps expect **New Window** (Cmd+N), **Reopen Closed Window**
(Cmd+Shift+T or the macOS convention), and the **Window** menu listing open
windows.

**Proposal:** add opt-in config, e.g.
`desktop.menu.window: { newWindow: "/", reopenClosed: true }`. Its actions use
gaps 3 and 4: the reopen stack holds the keys of recently closed windows.

### 6. Limits

`MAX_OPEN_WINDOWS = 8` is fine as a default, but it should be configurable
(`desktop.app.maxWindows`).

## Acceptance criteria (tests in Denext)

- Unit tests for each hook (`onWindowOpened`, `onWindowClosed` with and without
  `appQuitting`, `onAppQuit`, `onBeforeQuit` cancel and allow), using the
  existing registry fakes.
- `createOwnedResources`:
  - events reach only the owner;
  - with `"detach"`, closing the owner leaves the resource alive and ownerless,
    and `attach` returns its replay;
  - with `"dispose"`, closing the owner disposes it;
  - `onAppQuit` disposes everything;
  - the replay buffer is bounded per resource and drops the oldest bytes.
- Window keys: unique among open windows, restored bounds come from
  `appSupportDir`, and a corrupt store falls back to defaults.
- An example app (or an addition to an existing one) with two windows, a
  per-window background resource, close-to-detach and reopen.

## Not in scope

- Terminal-specific state: Qutty keeps its workspace model (terminals per
  window, layouts, MRU order) and xterm redraw.
- Moving a live web view between windows. Only backend resources move; the new
  window renders its own UI from the replay.
- Detach that survives the app process exiting. A separate daemon is a later,
  separate design. This proposal covers detach within one running app
  (`keepAlive`).

## How Qutty would use it

1. `desktop/pty.ts` keeps its PTYs in
   `createOwnedResources({ onOwnerClosed: "detach", replay })` instead of its
   own map with `killOwnedBy`, and emits `data` to the owner only (today it
   broadcasts to every window).
2. Cmd+N calls `windows.open({ url: "/", key: newWorkspaceId() })`. Each window
   loads its workspace by key, and terminals spawned there are owned by it.
3. Closing a window detaches its PTYs. "Reopen Closed Window" reopens it by key:
   the page asks the extension for `ownedBy(key)` plus replays, and recreates
   its tiles.
4. Launching with `restoreWindows` reopens every keyed window, and its terminals
   reattach.
5. On Cmd+Q, an `onBeforeQuit` guard asks whether to kill running terminals.

## Open questions for the Denext agent

- Should the hooks live on `DesktopCapability` (per extension) or on
  `DesktopExtensionHost` (from `setup`)? The host fits better if extensions
  subscribe dynamically.
- Is the `bridge-events` replay the right base for per-resource replay (filtered
  by resource), or should it be a separate store?
- Can the runtime report the space or screen for restore on all three OSes, or
  only bounds?
