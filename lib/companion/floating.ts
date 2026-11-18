/**
 * The floating companion (Settings → Companion → Floating): the pure half of its window
 * (app/companion/floating-companion.tsx draws it, desktop/companion-window.ts opens it).
 *
 * - Whether this system can float it at all ({@linkcode floatingSupport}): a transparent window
 *   that lets clicks through where it draws nothing and, on Wayland, a layer-shell surface (the
 *   only way a window stays on top there). Where it cannot, Floating is grayed out with the
 *   reason and the companion is drawn in the window.
 * - Where clicks go through it ({@linkcode clickThroughPlan}, {@linkcode hitRects},
 *   {@linkcode insideAny}): ported from Denext's examples/companion (lib/click-through.ts; same
 *   author, MIT).
 * - Its size, the corner of the screen it starts in, and the position it was dragged to, kept in
 *   the page's storage ({@linkcode parseFloatPosition}).
 * - What the hub says of the window ({@linkcode CompanionWindowState}).
 *
 * Client-safe and pure.
 *
 * @module
 */

/** The floating window's size in CSS pixels: the companion, its bubble and its chat box. */
export const FLOATING_SIZE = { width: 300, height: 440 } as const;

/** How far from the screen's edges the floating window starts (its first open). */
const SCREEN_MARGIN = 24;

/** The window capabilities {@linkcode floatingSupport} reads (`windowCapabilities()`). */
export interface FloatingCaps {
  readonly transparent?: unknown;
  readonly hitRegion?: unknown;
  readonly clickThrough?: unknown;
  readonly clickThroughForward?: unknown;
  readonly sessionType?: unknown;
  readonly layerShell?: unknown;
}

/** Whether the companion can float here, and why not. */
export type FloatingSupport =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether this system can show the floating companion: `null` caps is a page outside the desktop
 * app (the browser demo). It needs a transparent window, clicks let through outside the companion
 * (a hit region, or click-through with pointer moves still reported), and on Wayland a
 * layer-shell surface.
 */
export function floatingSupport(caps: FloatingCaps | null): FloatingSupport {
  if (caps === null) {
    return { ok: false, reason: "Floating needs the desktop app." };
  }
  if (caps.transparent !== true) {
    return {
      ok: false,
      reason:
        "This system can't draw a transparent window, so the companion stays in the window.",
    };
  }
  if (clickThroughPlan(caps) === "none") {
    return {
      ok: false,
      reason:
        "This system can't let clicks through a window, so the companion stays in the window.",
    };
  }
  if (caps.sessionType === "wayland" && caps.layerShell !== true) {
    return {
      ok: false,
      reason:
        "This Wayland desktop has no layer-shell (gtk-layer-shell on KDE Plasma or a wlroots compositor), so a window can't stay on top; the companion stays in the window.",
    };
  }
  return { ok: true };
}

/**
 * The attribute that marks an element as catching clicks in the floating window: the companion,
 * its bubble, its chat box and its buttons. The rest of the window lets clicks through.
 */
export const HIT_SELECTOR = "[data-companion-hit]";

/** A rectangle in page CSS pixels. */
export interface HitRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** How the window lets clicks through outside the companion. */
export type ClickThroughPlan = "region" | "forward" | "none";

/**
 * The best way this runtime has to let clicks through everywhere but the companion: a native hit
 * region, else click-through whose pointer moves still reach the page (so it can catch clicks
 * again over the companion), else none.
 */
export function clickThroughPlan(caps: FloatingCaps): ClickThroughPlan {
  if (caps.hitRegion === true) return "region";
  if (caps.clickThrough === true && caps.clickThroughForward === true) {
    return "forward";
  }
  return "none";
}

/**
 * The click-catching rectangles of `boxes` (page CSS pixels, as `getBoundingClientRect()` gives
 * them), rounded outwards; empty boxes are left out.
 */
export function hitRects(
  boxes: readonly {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  }[],
): HitRect[] {
  return boxes.flatMap((b) => {
    const x = Math.floor(b.left);
    const y = Math.floor(b.top);
    const width = Math.ceil(b.right) - x;
    const height = Math.ceil(b.bottom) - y;
    return width > 0 && height > 0 ? [{ x, y, width, height }] : [];
  });
}

/** Whether point (`x`, `y`) is inside one of `rects`. */
export function insideAny(
  rects: readonly HitRect[],
  x: number,
  y: number,
): boolean {
  return rects.some((r) =>
    x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
  );
}

/** A point on screen. */
export interface FloatPosition {
  readonly x: number;
  readonly y: number;
}

/** Where the page keeps the floating window's position (the page's storage, per app). */
export const FLOAT_POSITION_KEY = "qutty.companion.floatPosition";

/** The farthest a saved coordinate may be (screens far apart still fit). */
const POSITION_LIMIT = 100_000;

/** A saved position from storage (`null`: none, or not a position). */
export function parseFloatPosition(raw: string | null): FloatPosition | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const { x, y } = (v ?? {}) as { x?: unknown; y?: unknown };
  const ok = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) &&
    Math.abs(n) <= POSITION_LIMIT;
  return ok(x) && ok(y) ? { x: Math.round(x), y: Math.round(y) } : null;
}

/** A display's area outside its menu bar, Dock and panels, in screen CSS pixels. */
export interface ScreenArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where a window of `size` starts: the bottom-right corner of `area`, clear of its edges. */
export function cornerPosition(
  area: ScreenArea,
  size: { readonly width: number; readonly height: number } = FLOATING_SIZE,
): FloatPosition {
  return {
    x: Math.round(
      area.x + Math.max(0, area.width - size.width - SCREEN_MARGIN),
    ),
    y: Math.round(
      area.y + Math.max(0, area.height - size.height - SCREEN_MARGIN),
    ),
  };
}

/** What the hub says of the floating companion's window (desktop/companion-window.ts). */
export interface CompanionWindowState {
  /** The window is open. */
  readonly open: boolean;
  /** Its page has loaded and follows the companion: bubbles and questions go there. */
  readonly ready: boolean;
  /** Why it could not open (the last request), if it failed. */
  readonly error?: string;
}

/** What a workspace window asks of the floating companion's window. */
export interface CompanionWindowRequest {
  /** Open it (or keep it open), or close it. */
  readonly open: boolean;
  /** Where it opens: where it was last dragged to (none: the page places it in a corner). */
  readonly position?: FloatPosition;
  /** On every Space / virtual desktop. */
  readonly allSpaces?: boolean;
}

/**
 * A {@linkcode CompanionWindowRequest} from a page's untrusted input, or what is wrong with it.
 */
export function windowRequestFrom(
  v: Record<string, unknown>,
): CompanionWindowRequest | string {
  if (typeof v.open !== "boolean") return "open must be a boolean";
  if (v.allSpaces !== undefined && typeof v.allSpaces !== "boolean") {
    return "allSpaces must be a boolean";
  }
  let position: FloatPosition | null = null;
  if (v.position !== undefined) {
    position = parseFloatPosition(JSON.stringify(v.position));
    if (!position) return "position must be { x, y } on screen";
  }
  return {
    open: v.open,
    ...(position ? { position } : {}),
    ...(typeof v.allSpaces === "boolean" ? { allSpaces: v.allSpaces } : {}),
  };
}
