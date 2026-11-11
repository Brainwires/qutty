/**
 * HTML overlays over web tiles: a count of the menus, dialogs and popovers open in the page.
 *
 * A native web view (Denext's embedded webview, the coming `NativeEngine`) is a layer drawn above
 * all HTML, so a menu or dialog that overlaps a web tile would be hidden under it. Every overlay
 * registers here while it is open (app/use-html-overlay.ts: the link menu, the modal dialogs,
 * Settings, the bar's menus) and a web tile whose engine `drawsAboveHtml` hides its view while
 * the count is above zero. The iframe engine is ordinary HTML and ignores it.
 *
 * Client-safe, no DOM.
 *
 * @module
 */

type Listener = (open: number) => void;

let open = 0;
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) fn(open);
}

/** An overlay opened; the returned function closes it (once). */
export function openOverlay(): () => void {
  open++;
  emit();
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    open--;
    emit();
  };
}

/** How many overlays are open. */
export function openOverlays(): number {
  return open;
}

/** Follow the count (called with the current one at once); returns the unsubscribe. */
export function onOverlays(fn: Listener): () => void {
  listeners.add(fn);
  fn(open);
  return () => void listeners.delete(fn);
}
