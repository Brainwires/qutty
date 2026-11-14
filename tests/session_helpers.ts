// Shared helpers for the detachable-session tests (not a test module itself): a stand-in for an
// extension's `setup(host)` host with windows that open, close and quit, and handler contexts.

import type {
  DesktopCapCtx,
  DesktopConfirmOptions,
  DesktopSecondInstanceEvent,
  DesktopSecureStore,
  DesktopWindowMenuItemHandler,
} from "denext/desktop";
import { memorySecretStore } from "../lib/secrets/api-keys.ts";

/** The extension secure store (Denext 4.15) for hosts and contexts whose tests never use it. */
const unusedSecureStore: DesktopSecureStore = {
  get: () => Promise.reject(new Error("unused")),
  set: () => Promise.reject(new Error("unused")),
  delete: () => Promise.reject(new Error("unused")),
};

/**
 * A working extension secure store in memory, for the tests of the keys an extension keeps
 * (`items`: what it holds). It never touches the OS keychain.
 */
export function memorySecureStore(
  seed: Record<string, string> = {},
): DesktopSecureStore & { items: Map<string, string> } {
  return memorySecretStore(seed);
}

/** One event the fake extension host was given: its name, data and target window. */
interface HostEvent {
  event: string;
  data: unknown;
  window?: string;
  /** `false` for a one-shot emit (`{ retain: false }`). */
  retain?: false;
}

/** A window as the host lists it. */
interface WindowInfo {
  id: string;
  kind: "main" | "panel" | "window";
  key?: string;
}

type ClosedFn = (info: WindowInfo & { appQuitting: boolean }) => unknown;

/**
 * A fake extension host: records every emit (with its target window), keeps the open windows,
 * fires the window lifecycle hooks on `close` / `quit`, runs the quit guards on `beforeQuit`,
 * records each `confirm` (the OS message box), answering it with `reply`, hands a Window-menu
 * click to its subscribers on `menuItem`, and counts the extension's own `quit()` calls.
 */
export function fakeExtensionHost(open: WindowInfo[] = []) {
  const events: HostEvent[] = [];
  const windows = [...open];
  const opened = new Set<(info: WindowInfo) => unknown>();
  const closed = new Set<ClosedFn>();
  const quits = new Set<() => unknown>();
  const guards = new Set<() => boolean | Promise<boolean>>();
  const menuItems = new Set<DesktopWindowMenuItemHandler>();
  const relaunches = new Set<
    (event: DesktopSecondInstanceEvent) => void | Promise<void>
  >();
  /** Every `host.confirm` call's options, in order. */
  const confirms: DesktopConfirmOptions[] = [];
  function on<T>(set: Set<T>) {
    return (fn: T) => {
      set.add(fn);
      return () => void set.delete(fn);
    };
  }
  const host = {
    emit: (
      event: string,
      data: unknown,
      o?: { window?: string; retain?: boolean },
    ) =>
      void events.push({
        event,
        data,
        ...(o?.window ? { window: o.window } : {}),
        ...(o?.retain === false ? { retain: false } : {}),
      }),
    pickedPath: (): string => {
      throw new Error("unused");
    },
    appSupportDir: "",
    os: Deno.build.os as "darwin" | "linux",
    // As Denext's: first for each window open now, then for each that opens.
    onWindowOpened: (fn: (info: WindowInfo) => unknown) => {
      for (const w of windows) fn(w);
      return on(opened)(fn);
    },
    onWindowClosed: on(closed),
    onAppQuit: on(quits),
    onBeforeQuit: on(guards),
    windows: () => windows,
    // Denext 4.15's host additions. `confirm` records the box and answers with `fake.reply`.
    secureStore: unusedSecureStore,
    confirm: (options: DesktopConfirmOptions): Promise<number | null> => {
      confirms.push(options);
      return fake.reply(options);
    },
    openWindow: (): never => {
      throw new Error("unused");
    },
    // Denext 4.16's: the extension's own quit, the app's Window-menu items, a second launch.
    quit: (): Promise<boolean> => {
      fake.quits++;
      return Promise.resolve(true);
    },
    onWindowMenuItem: on(menuItems),
    onSecondInstance: on(relaunches),
    // Denext 4.18's: the app's own menus, notification clicks, navigation (unused by these tests).
    setMenu: (): never => {
      throw new Error("unused");
    },
    setMenuItemState: (): never => {
      throw new Error("unused");
    },
    setWindowMenuAppItems: (): never => {
      throw new Error("unused");
    },
    onAppMenuItem: () => () => {},
    onNotificationClick: () => () => {},
    onWillNavigate: () => () => {},
  };
  const fake = {
    host,
    events,
    confirms,
    /**
     * What the next message box answers: the pressed button's index, `null` (dismissed), or a
     * rejection (an older runtime's `unsupported`). By default no button is pressed yet.
     */
    reply: (_options: DesktopConfirmOptions): Promise<number | null> =>
      new Promise<number | null>(() => {}),
    /** How many times the extension called `host.quit()`. */
    quits: 0,
    /**
     * A click on the app's Window-menu item `id` with `keyWindow` (`null`: no window open), as
     * Denext hands it over: once to each subscriber. Resolves once they all have.
     */
    async menuItem(
      id: string,
      keyWindow: { id: string; key?: string } | null,
    ): Promise<void> {
      for (const fn of [...menuItems]) await fn(id, { keyWindow });
    },
    /** A quit: the `onBeforeQuit` guards (`false` from any of them cancels it). */
    async beforeQuit(): Promise<boolean> {
      const answers = await Promise.all([...guards].map((fn) => fn()));
      return answers.every((ok) => ok !== false);
    },
    /** Open a window (as `windows.open({ key })`): the `onWindowOpened` hooks hear of it. */
    open(info: WindowInfo) {
      windows.push(info);
      for (const fn of [...opened]) fn(info);
    },
    /** Close window `id` for good (`appQuitting` when the app quits). */
    async close(id: string, appQuitting = false) {
      const i = windows.findIndex((w) => w.id === id);
      const [info] = windows.splice(i, 1);
      for (const fn of [...closed]) await fn({ ...info, appQuitting });
    },
    /** The app quits: every window closes, then the quit hooks run. */
    async quit() {
      for (const w of [...windows]) await fake.close(w.id, true);
      for (const fn of [...quits]) await fn();
    },
    /** The text of every `data` event for terminal `id` (to any window, or to `window`). */
    text(id: string, window?: string): string {
      return events.filter((e) =>
        e.event === "data" && (e.data as { id: string }).id === id &&
        (window === undefined || e.window === window)
      ).map((e) => (e.data as { data: { data: string } }).data.data).join("");
    },
    /** Whether terminal `id`'s exit was emitted (to `window`, if given). */
    exited(id: string, window?: string): boolean {
      return events.some((e) =>
        e.event === "exit" && (e.data as { id: string }).id === id &&
        (window === undefined || e.window === window)
      );
    },
  };
  return fake;
}

/**
 * A fake of desktop.ts's `DesktopRuntime.windows` slice Qutty uses: the open windows (`list`) and
 * `forget(key)`, which records the keys it was given.
 */
export function fakeRuntimeWindows(open: WindowInfo[] = []) {
  const forgotten: string[] = [];
  const windows = [...open];
  return {
    forgotten,
    windows,
    list: () => windows as never[],
    forget: (key: string) => void forgotten.push(key),
  };
}

/** A handler context for window `windowId` (the extensions emit through their host). */
export function ctxOf(windowId: string | undefined): DesktopCapCtx {
  return {
    emit: () => {
      throw new Error("the extension emits through its host");
    },
    appSupportDir: "",
    os: Deno.build.os as "darwin" | "linux",
    windowId,
    signal: new AbortController().signal,
    runOnMainThread: () => Promise.reject(new Error("unused")),
    pickedPath: () => {
      throw new Error("unused");
    },
    secureStore: unusedSecureStore,
  } as DesktopCapCtx;
}

/** Poll `cond` every 10 ms until it holds, or throw after `ms`. */
export async function until(
  what: string,
  cond: () => boolean,
  ms = 15_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
