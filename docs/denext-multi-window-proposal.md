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

---

## After 4.13: what Qutty uses, and what is still missing

Denext 4.13.0 shipped gaps 1 to 6 almost as proposed: the window lifecycle hooks
(`onWindowOpened`, `onWindowClosed` with `appQuitting`, `onAppQuit`), the
runtime-side quit guard (`host.onBeforeQuit`, `DesktopRuntime.onBeforeQuit`),
window keys with remembered frames and `desktop.app.restoreWindows`,
`desktop.app.maxWindows`, `desktop.menu.window` (New Window, Reopen Closed
Window, the window list) and `createOwnedResources`. Qutty's detach and New
Window are built on them (`desktop/terminal-sessions.ts`,
`desktop/workspace-host.ts`, `desktop.ts`). What follows is what Qutty had to
work around, smallest first. Each is generic, not terminal-specific.

### 7. A Dock click after the main window closed does nothing

`onDockReopen` (app-windows.ts) shows the main window, but with
`desktop.app.keepAlive` the main window is gone for good once the user closes it
(`mainClosed` drops it), so a Dock click with no window open does nothing. Qutty
listens to `Deno.dock`'s `reopen` event itself in desktop.ts (an untyped runtime
global) and opens the workspace detached last.

**Proposal:** a reopen handler next to `newWindow`, used when no app window is
open:

```ts
runDesktop({
  // Called on a Dock click (macOS `applicationShouldHandleReopen`) with no window showing.
  // Default when absent: reopen the most recently closed keyed window (the reopenClosed stack),
  // else the main window's page with `desktop.window.key`.
  onDockReopen: (ctx: { closed: readonly { key: string; url: string }[] }) =>
    DesktopOpenWindowOptions | undefined,
});
```

and a typed `DesktopRuntime.onDockReopen(fn)` for apps that only want to know.

### 8. Opened windows do not get `desktop.titleBar`

`windows.open()` / `openWindow()` have no title bar option, and a window opened
from `desktop.ts` or a page gets the default title bar even when the main window
is `titleBar: "hiddenInset"`. Qutty's page calls
`setTitleBarStyle("hiddenInset")` once it loads, so a new window shows the
default title bar for a moment first.

**Proposal:** opened windows inherit `desktop.titleBar` (and the traffic-light
position), and `DesktopOpenWindowOptions` takes `titleBar?: TitleBarStyle` to
override it.

### 9. A default size for a key seen for the first time

`restoredGeometry` fills only the bounds a call leaves out from the saved frame,
so a call that passes `width` / `height` (to give a brand-new window a sensible
size) never gets its saved size back. Qutty passes a size only for a workspace
it just created. The same applies to the main window: `desktop.window.width` /
`height` always win over its saved size.

**Proposal:** `defaultWidth` / `defaultHeight` on `open()` (and
`desktop.window`), used only when the key has no saved frame.

### 10. "Reopen ▸" as a list, and forgetting a closed key

`desktop.menu.window.reopenClosed` is one item that pops the stack. A
multi-document app wants the list (Safari's History → Recently Closed, Qutty's
"Reopen workspace"): every closed keyed window with its title. And when the app
ends what a key stood for (Qutty ends a workspace and kills its terminals), the
key should leave that stack and `lastSession`.

**Proposal:** `reopenClosed: "list"` makes it a submenu (titles from the closed
windows), served by the backend so it works with no window open, plus
`windows.forget(key)`.

### 11. The replay drops an oversized object chunk without a trace

`createOwnedResources` keeps the tail of an oversized string or byte chunk, but
drops any other chunk bigger than `maxBytes` outright, and `attach` does not say
anything was dropped. Qutty emits `{ seq, data }` objects, so it detects a gap
by its own `seq` and replays only the unbroken tail (`lib/workspace/replay.ts`).

**Proposal:** `attach()` reports `dropped: number` (chunks dropped since the
resource was added), or `truncated: boolean`; optionally a
`replay.measure(data)` / `replay.cut(data, maxBytes)` pair so an app with
structured chunks can keep a tail too.

### 12. Asking the user with no window open

The quit guard can refuse, but asking "agents are busy, quit anyway?" needs a
page. With every window closed Qutty opens the busy workspace's window to ask
there. A small native confirm in the backend
(`host.confirm({ message, buttons })`, over `NSAlert` / a GTK / Win32 message
box) would let a guard ask directly. Also handy: `host.openWindow()` for
extensions (today only `desktop.ts` can open a window, so Qutty's quit guard and
Dock handling live there rather than in its extension).

### Not a gap, but worth a line in the docs

- `denext export` (static) does not rewrite `.deno-desktop/config.json`; only
  `desktop run` / `dev`, the SPA build and packaging do. A project that commits
  the file and changes `denext.config.ts` must run one of those (Qutty's
  CONTRIBUTING said `export` was enough).
- Detach that outlives the app process is still a separate design (a PTY daemon
  the app reconnects to). Qutty's terminals survive a closed window, not a quit.

## After 4.15: what Qutty adopted, and what is still missing

Denext 4.15.0 (runtime 3.0.0-denext.16) shipped gaps 7 to 12. Qutty uses:

- **7, the Dock.** `runDesktop({ onDockReopen })` in desktop.ts
  (`dockReopenWindow` in `desktop/windows.ts`) reopens the workspace detached
  last, else a fresh one. The `Deno.dock` `reopen` listener is gone.
- **8, the title bar.** Opened windows inherit `desktop.titleBar`, so the page
  no longer calls `setTitleBarStyle("hiddenInset")` after it loads. Qutty never
  moved the traffic lights, so `windowButtonPosition` deletes nothing and is not
  used.
- **10, the reopen list.** `desktop.menu.window.reopenClosed: "list"`, with the
  window titles the page sets (`document.title` and `setWindowTitle`: "Qutty —
  Workspace 2"). An ended workspace's key goes through `windows.forget`
  (`forgetEndedWorkspaces` in `desktop/windows.ts`). A window whose workspace is
  ended (the Window menu's "Close Window and End Its Shells", the Workspaces
  menu's "End workspace") is closed first and its workspace ended after that
  (`WorkspaceRegistry.endOnClose`), because Denext remembers a closed key as it
  closes: forgetting before the close would not stick.
- **12, asking with no window open.** The quit guard moved into the `session`
  extension: `host.onBeforeQuit` plus `host.confirm`, the OS's message box. The
  page's quit dialog, the `quit` event and the "open the busy workspace's window
  to ask there" path are gone. "Close Window and End Its Shells" asks the same
  way.
- **App-wide menu clicks.** With runtime denext.16 Denext takes the application
  menu's clicks from `Deno.desktop`'s `menuclick`, so New Window, Reopen Closed
  Window and the window list answer with no window open. Qutty has no menu
  handling of its own in the app's process.

Not adopted yet: gap 9 (`defaultWidth` / `defaultHeight`, which would replace
the `fresh` size in `lib/workspace/windows.ts`) and gap 11 (the replay's
`dropped` / `truncated`, which `lib/workspace/replay.ts` detects by `seq`).

### 13. No custom item in the backend's Window menu (resolved in 4.16)

`desktop.menu.window` takes only Denext's own items. Qutty adds "Close Window
and End Its Shells" with the page's `setAppMenu` (a "Window" submenu, which
Denext's items join after a separator). A page menu click is queued for every
window, though, not for the key window, so every page hears it and the `session`
extension lets only the window used last act (and ignores the other copies for a
second). The item does nothing with no window open, which is fine for this item.

**Proposal:** `desktop.menu.window.items: [{ id, label, accelerator? }]` whose
clicks reach the backend
(`runDesktop({ onWindowMenuItem: (id, { keyWindow })
=> … })`) with the key
window's id, or a page click carrying the key window.

### 14. A quit guard cannot wait for the user (resolved in 4.16)

Every `onBeforeQuit` guard gets 5 seconds together, and then the quit goes on. A
guard that awaits `host.confirm` would quit under a box the user has not
answered yet. Qutty's guard cancels the quit at once, asks, and on "Quit Anyway"
confirms and issues the quit again (`Deno.desktop.quit()`, an untyped runtime
call).

**Proposal:** pause the guards' deadline while a `host.confirm` box is up, or
give the host a typed `quit()` that runs the guards again.

## After 4.16: what Qutty replaced

Denext 4.16.0 (runtime 3.0.0-denext.17) shipped both proposals, and a
`runDesktop({ onSecondInstance })`. Qutty dropped three workarounds:

- **13, the Window menu item.** "Close Window and End Its Shells" is one of the
  app's own items, `desktop.menu.window.items` in `denext.config.ts`. Its click
  reaches the `session` extension once, with the key window
  (`host.onWindowMenuItem`, `closeAndEndFromMenu` in `desktop/session.ts`): it
  asks about busy agents there with `host.confirm`, marks the window's workspace
  to end on close, and closes that window through `DesktopRuntime.windows` (no
  close guard; desktop.ts shares the runtime's windows with
  `shareRuntimeWindows`). With no window open it does nothing. The page's
  `setAppMenu` "Window" submenu, its `onAppMenuItem` handler and the extension's
  "window used last, ignore copies for a second" de-duplication are gone; the
  page sets no application menu at all now.
- **14, the quit guard.** `guardQuit` awaits `host.confirm` inside the guard and
  returns the answer, since Denext stops the guards' 5 seconds while the box is
  up. The untyped `Deno.desktop.quit()` is gone: the tray's "Quit Qutty" and the
  quit once nothing runs in the tray go through the typed
  `DesktopRuntime.quit()`, whose caller (desktop.ts) has no guards of its own,
  so the `session` extension's guard still asks about busy agents.
  (`host.quit()` from the `session` extension would skip that extension's own
  guard, so it is not used there.)
- **The second launch.** desktop.ts no longer listens to `Deno.desktop`'s raw
  `secondinstance`. `runDesktop({ onSecondInstance })` answers the same window
  as the Dock (`dockReopenWindow`): Denext's default reopens the last closed
  key, which may be a workspace with no terminal left, so Qutty keeps its own
  choice. The window's opening takes tray mode back to a regular app through
  `followWindows`. On macOS a Finder or Spotlight relaunch is still the Dock's
  reopen (`onDockReopen`).

Still not adopted: gaps 9 and 11, as above.
