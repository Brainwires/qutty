/**
 * A web tile's back/forward list, kept by the tile itself. A cross-origin iframe tells its parent
 * nothing about its history (not its URL, not whether it can go back), so the iframe engine
 * records the navigations it starts — the first page, the address field, back, forward — and
 * walks this list. Navigations the page makes on its own (a click on one of its links) are not
 * seen; the native engine reports those (its `url` event) and replaces this.
 *
 * Pure and immutable: every operation returns a new history (or the same one when nothing
 * changes).
 *
 * @module
 */

/** The visited URLs, oldest first, and the index of the one shown. */
export interface WebHistory {
  readonly entries: readonly string[];
  readonly index: number;
}

/** The most entries kept (the oldest go first). */
export const MAX_HISTORY = 50;

/** A history holding just `url`. */
export function startHistory(url: string): WebHistory {
  return { entries: [url], index: 0 };
}

/** The URL shown. */
export function currentUrl(h: WebHistory): string {
  return h.entries[h.index];
}

export function canGoBack(h: WebHistory): boolean {
  return h.index > 0;
}

export function canGoForward(h: WebHistory): boolean {
  return h.index < h.entries.length - 1;
}

/**
 * A navigation to `url`: it follows the shown entry and drops the forward ones (as a browser
 * does). Navigating to the URL already shown changes nothing.
 */
export function pushUrl(h: WebHistory, url: string): WebHistory {
  if (currentUrl(h) === url) return h;
  const entries = [...h.entries.slice(0, h.index + 1), url];
  const drop = Math.max(0, entries.length - MAX_HISTORY);
  return { entries: entries.slice(drop), index: entries.length - 1 - drop };
}

/** One step back (unchanged at the start). */
export function goBack(h: WebHistory): WebHistory {
  return canGoBack(h) ? { entries: h.entries, index: h.index - 1 } : h;
}

/** One step forward (unchanged at the end). */
export function goForward(h: WebHistory): WebHistory {
  return canGoForward(h) ? { entries: h.entries, index: h.index + 1 } : h;
}
