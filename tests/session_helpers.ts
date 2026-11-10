// Shared helpers for the detachable-session tests (not a test module itself): a stand-in for an
// extension's `setup(host)` host with windows that open, close and quit, and handler contexts.

import type {
  DesktopCapCtx,
  DesktopConfirmOptions,
  DesktopSecureStore,
} from "denext/desktop";

/** The extension secure store (Denext 4.15) for hosts and contexts whose tests never use it. */
const unusedSecureStore: DesktopSecureStore = {
  get: () => Promise.reject(new Error("unused")),
  set: () => Promise.reject(new Error("unused")),
  delete: () => Promise.reject(new Error("unused")),
};

/** One event the fake extension host was given: its name, data and target window. */
interface HostEvent {
  event: string;
  data: unknown;
  window?: string;
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
 * fires the window lifecycle hooks on `close` / `quit`, runs the quit guards on `beforeQuit`, and
 * records each `confirm` (the OS message box), answering it with `reply`.
 */
export function fakeExtensionHost(open: WindowInfo[] = []) {
  const events: HostEvent[] = [];
  const windows = [...open];
  const closed = new Set<ClosedFn>();
  const quits = new Set<() => unknown>();
  const guards = new Set<() => boolean | Promise<boolean>>();
  /** Every `host.confirm` call's options, in order. */
  const confirms: DesktopConfirmOptions[] = [];
  function on<T>(set: Set<T>) {
    return (fn: T) => {
      set.add(fn);
      return () => void set.delete(fn);
    };
  }
  const host = {
    emit: (event: string, data: unknown, o?: { window?: string }) =>
      void events.push({
        event,
        data,
        ...(o?.window ? { window: o.window } : {}),
      }),
    pickedPath: (): string => {
      throw new Error("unused");
    },
    appSupportDir: "",
    os: Deno.build.os as "darwin" | "linux",
    onWindowOpened: () => () => {},
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
    /** A quit: the `onBeforeQuit` guards (`false` from any of them cancels it). */
    async beforeQuit(): Promise<boolean> {
      const answers = await Promise.all([...guards].map((fn) => fn()));
      return answers.every((ok) => ok !== false);
    },
    /** Open a window (as `windows.open({ key })`). */
    open(info: WindowInfo) {
      windows.push(info);
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
