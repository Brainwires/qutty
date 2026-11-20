// The floating companion's own window (app/companion/floating-companion.tsx), as its page sets it
// up. The window itself is opened by the app (desktop/companion-window.ts: transparent, frameless,
// non-activating, on top, off the taskbar); here the page:
//
// - clears its background, so the companion stands on the desktop (`data-floating` on <html>);
// - lets clicks through everywhere but the companion, its bubble, its chat box and its buttons
//   (the elements marked `data-companion-hit`): a hit region where the runtime has one
//   (`setHitRegion`, re-sent as they come, go, move and resize), else click-through with pointer
//   forwarding toggled over them, else the whole window catches clicks;
// - keeps where it was dragged to, for the next open (lib/companion/floating.ts; the workspace
//   window that asks for it passes it on, app/use-floating-companion.ts);
// - shows on every Space or only the current one (Settings → Companion → On every Space);
// - moves with the companion when it is dragged (`mover`, for app/companion/use-companion-drag.ts),
//   and keeps where it was dropped;
// - takes the keyboard for the chat box (`takeKeyboard`: the window never takes it by itself);
// - tells the hub it is ready, so the companion's bubbles and questions come here.
//
// Each step is feature-detected through `windowCapabilities()` and skipped where the runtime
// can't. Off desktop (the browser demo) every call rejects and the page just draws the companion.
// The same approach as Denext's examples/companion (lib/window-setup.ts; same author, MIT).

import { useEffect, useMemo, useRef, useState } from "denext";
import {
  focusWindow,
  getWindowState,
  setHitRegion,
  setIgnoreMouseEvents,
  setVisibleOnAllWorkspaces,
  setWindowPosition,
  type WindowBounds,
  windowCapabilities,
} from "denext/desktop/window";
import {
  clickThroughPlan,
  FLOAT_POSITION_KEY,
  type FloatPosition,
  HIT_SELECTOR,
  hitRects,
  insideAny,
} from "../../lib/companion/floating.ts";
import type { WindowMover } from "./use-companion-drag.ts";
import type { PtyBackend } from "../../lib/pty-client.ts";

/** What `windowCapabilities()` reports. */
type Caps = Awaited<ReturnType<typeof windowCapabilities>>;

/** The current rectangles of the click-catching elements under `root`. */
function rectsOf(root: ParentNode): WindowBounds[] {
  return hitRects(
    [...root.querySelectorAll(HIT_SELECTOR)].map((e) =>
      e.getBoundingClientRect()
    ),
  );
}

/**
 * Keep the native hit region on the click-catching elements under `root`: re-sent when one is
 * added or removed (a bubble opens or closes), resizes, or ends an animation (the bubble springs
 * in scaled down, which no resize reports). Returns the stop.
 */
function followRegion(root: Element): () => void {
  const send = () => void setHitRegion(rectsOf(root)).catch(() => {});
  const resized = typeof ResizeObserver === "function"
    ? new ResizeObserver(send)
    : null;
  const observe = () => {
    resized?.disconnect();
    for (const e of root.querySelectorAll(HIT_SELECTOR)) resized?.observe(e);
    send();
  };
  observe();
  const changed = typeof MutationObserver === "function"
    ? new MutationObserver(observe)
    : null;
  changed?.observe(root, { childList: true, subtree: true });
  root.addEventListener("animationend", send);
  root.addEventListener("transitionend", send);
  return () => {
    resized?.disconnect();
    changed?.disconnect();
    root.removeEventListener("animationend", send);
    root.removeEventListener("transitionend", send);
  };
}

/** Click-through with forwarded pointer moves, caught again while the pointer is over `root`'s hits. */
function followPointer(root: Element): () => void {
  let ignoring = true;
  void setIgnoreMouseEvents(true, { forward: true }).catch(() => {});
  const onMove = (e: PointerEvent) => {
    const over = insideAny(rectsOf(root), e.clientX, e.clientY);
    if (over === !ignoring) return;
    ignoring = !over;
    void setIgnoreMouseEvents(ignoring, { forward: true }).catch(() => {});
  };
  globalThis.addEventListener("pointermove", onMove);
  return () => globalThis.removeEventListener("pointermove", onMove);
}

/** Keep where the window was dropped, for its next open. */
function savePosition(at: FloatPosition): void {
  try {
    globalThis.localStorage?.setItem(FLOAT_POSITION_KEY, JSON.stringify(at));
  } catch { /* no storage: it starts in the corner again */ }
}

/** Moves the window by a drag of its companion; see the module comment. */
function windowMover(): WindowMover {
  let origin: WindowBounds | null = null;
  let last: FloatPosition | null = null;
  let inFlight = false;
  let next: FloatPosition | null = null;
  const flush = () => {
    if (inFlight || !next) return;
    const at = next;
    next = null;
    inFlight = true;
    setWindowPosition(at.x, at.y).catch(() => {}).finally(() => {
      inFlight = false;
      flush();
    });
  };
  const go = (at: FloatPosition) => {
    next = at;
    flush();
  };
  return {
    start() {
      origin = null;
      last = null;
      getWindowState().then((s) => origin = s.bounds, () => {});
    },
    moveBy(dx, dy) {
      if (!origin) return;
      last = { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) };
      go(last);
    },
    end(cancelled) {
      if (cancelled && origin) go({ x: origin.x, y: origin.y });
      else if (last) savePosition(last);
      origin = null;
    },
  };
}

/** What the floating page gets from {@linkcode useFloatingWindow}. */
export interface FloatingWindow {
  /** Moves the window when the companion is dragged. */
  readonly mover: WindowMover;
  /** Give the window the keyboard (the chat box). */
  takeKeyboard(): void;
}

/**
 * Set the page's window up as the floating companion; see the module comment.
 *
 * @param root The page's root: the elements under it marked `data-companion-hit` catch clicks.
 * @param backend The hub, told the page is ready.
 * @param allSpaces Settings → Companion → On every Space.
 */
export function useFloatingWindow(
  root: { readonly current: HTMLElement | null },
  backend: PtyBackend | null,
  allSpaces: boolean,
): FloatingWindow {
  const caps = useRef<Caps | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.floating = "true";
    let stop = () => {};
    let live = true;
    windowCapabilities().then((c) => {
      if (!live) return;
      caps.current = c;
      const el = root.current;
      const plan = clickThroughPlan(c);
      if (el && plan === "region") stop = followRegion(el);
      if (el && plan === "forward") stop = followPointer(el);
      setReady(true);
    }, () => {/* off desktop: the companion is drawn in the page */});
    return () => {
      live = false;
      stop();
    };
  }, []);

  // On every Space, or the current one only.
  useEffect(() => {
    if (!ready || !caps.current?.visibleOnAllWorkspaces) return;
    void setVisibleOnAllWorkspaces(allSpaces).catch(() => {});
  }, [ready, allSpaces]);

  // The hub sends the bubbles and questions here once the page is up.
  useEffect(() => {
    if (!backend) return;
    void backend.companionWindowReady().catch(() => {});
  }, [backend]);

  return useMemo(() => ({
    mover: windowMover(),
    takeKeyboard: () => void focusWindow().catch(() => {}),
  }), []);
}
