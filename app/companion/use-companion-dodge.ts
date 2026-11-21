// Keeping the companion off the prompt boxes and the harness overlay's rail, the DOM side of
// lib/companion/dodge.ts. The overlay rests in its corner of the tile area; where the companion
// (its stage: the face and the buttons beside it) would cover a prompt box (`data-part="composer"`)
// or anything marked `data-companion-avoid`, it moves off it (`--companion-dodge-x` / `-y`, a
// transform the CSS eases). It looks again whenever one of them is added, removed or resized, the
// tile area is resized or a tile's move ends (`transitionend`), at most once a frame. While it is
// dragged it keeps the move it had (so it stays under the pointer) and looks again once it is
// dropped in a corner; never in the floating companion's own window.

import { useEffect } from "denext";
import {
  type Box,
  dodgeOffset,
  type Offset,
} from "../../lib/companion/dodge.ts";

/** What the companion keeps off. */
const AVOID = '[data-part="composer"], [data-companion-avoid]';

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

/**
 * Where `el` is drawn. A prompt box takes its tile's zoom (CSS `zoom`), and a Chromium before 128
 * (no `currentCSSZoom`) gives a zoomed element's box in its own zoomed px: scaled back here.
 */
const drawnBoxOf = (el: Element): Box => {
  const b = boxOf(el);
  if ("currentCSSZoom" in el) return b;
  const z = parseFloat(getComputedStyle(el).zoom) || 1;
  return z === 1 ? b : {
    left: b.left * z,
    top: b.top * z,
    right: b.right * z,
    bottom: b.bottom * z,
  };
};

/** Whether a node added or removed is, or holds, something the companion keeps off. */
const avoids = (n: Node): boolean =>
  n instanceof Element && (n.matches(AVOID) || n.querySelector(AVOID) !== null);

/** The move the overlay is set to make now. */
function offsetOf(el: HTMLElement): Offset {
  return {
    dx: parseFloat(el.style.getPropertyValue("--companion-dodge-x")) || 0,
    dy: parseFloat(el.style.getPropertyValue("--companion-dodge-y")) || 0,
  };
}

/**
 * Keep the companion in `overlay` off the prompt boxes while `on` (not `dragging`); see the
 * module comment.
 */
export function useCompanionDodge(
  overlay: { readonly current: HTMLElement | null },
  on: boolean,
  dragging: boolean,
  corner: string,
): void {
  useEffect(() => {
    const el = overlay.current;
    if (!el) return;
    let at = offsetOf(el);
    const set = (o: Offset) => {
      at = o;
      if (o.dx === 0 && o.dy === 0) {
        el.style.removeProperty("--companion-dodge-x");
        el.style.removeProperty("--companion-dodge-y");
        el.removeAttribute("data-dodging");
      } else {
        el.style.setProperty("--companion-dodge-x", `${o.dx}px`);
        el.style.setProperty("--companion-dodge-y", `${o.dy}px`);
        el.setAttribute("data-dodging", "true");
      }
    };
    if (!on) return set({ dx: 0, dy: 0 });
    const area = el.offsetParent;
    if (dragging || !(area instanceof HTMLElement)) return;
    let frame = 0;
    const look = () => {
      frame = 0;
      const stage = el.querySelector(".stage");
      if (!stage) return;
      // Where the corner puts it: its box now, less the move it is drawn with (mid-ease, the
      // computed transform is the eased one).
      const now = boxOf(stage);
      const shown = getComputedStyle(el).transform;
      const m = shown && shown !== "none"
        ? new DOMMatrixReadOnly(shown)
        : { m41: 0, m42: 0 };
      const home: Box = {
        left: now.left - m.m41,
        top: now.top - m.m42,
        right: now.right - m.m41,
        bottom: now.bottom - m.m42,
      };
      const obstacles = [...area.querySelectorAll(AVOID)]
        .filter((n) => !el.contains(n))
        .map(drawnBoxOf)
        .filter((b) => b.right > b.left && b.bottom > b.top);
      const raw = dodgeOffset(home, obstacles, boxOf(area));
      // Whole pixels, and no move for a pixel or two (the face's own animations nudge its box):
      // a move eases, and a new one each frame would never let it settle.
      const next = { dx: Math.round(raw.dx), dy: Math.round(raw.dy) };
      if (Math.abs(next.dx - at.dx) > 2 || Math.abs(next.dy - at.dy) > 2) {
        set(next);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(look);
    };
    const sizes = new ResizeObserver(schedule);
    sizes.observe(area);
    const watch = () =>
      area.querySelectorAll(AVOID).forEach((n) => sizes.observe(n));
    watch();
    const tree = new MutationObserver((records) => {
      if (
        records.some((r) =>
          [...r.addedNodes].some(avoids) || [...r.removedNodes].some(avoids)
        )
      ) {
        watch();
        schedule();
      }
    });
    tree.observe(area, { childList: true, subtree: true });
    // A tile's move ending (not the companion's own).
    const moved = (e: Event) => {
      if (!(e.target instanceof Node && el.contains(e.target))) schedule();
    };
    area.addEventListener("transitionend", moved);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      sizes.disconnect();
      tree.disconnect();
      area.removeEventListener("transitionend", moved);
    };
  }, [on, dragging, corner]);
}
