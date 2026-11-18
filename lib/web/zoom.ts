/**
 * Web page zoom: the steps ⌘+ / ⌘− / ⌘0 walk (Ctrl elsewhere; the browsers' own), and the zoom
 * each site was left at, remembered by host as browsers do. Stored on its own localStorage key
 * ({@linkcode ZOOM_STORAGE_KEY}) and synced across windows (lib/web/synced.ts).
 *
 * Pure and client-safe.
 *
 * @module
 */

import { parseWebUrl } from "./url.ts";

/** The zoom levels, as Chrome and Safari step them. */
const ZOOM_STEPS: readonly number[] = [
  0.25,
  0.33,
  0.5,
  0.67,
  0.75,
  0.8,
  0.9,
  1,
  1.1,
  1.25,
  1.5,
  1.75,
  2,
  2.5,
  3,
  4,
  5,
];

/** The localStorage key; bump the suffix when the shape changes incompatibly. */
export const ZOOM_STORAGE_KEY = "qutty.web-zoom.v1";

/** The most sites remembered. */
const MAX_ZOOM_SITES = 500;

/** The zoom per host (only the ones not at 100%). */
export interface SiteZoom {
  readonly sites: Readonly<Record<string, number>>;
}

export const NO_ZOOM: SiteZoom = { sites: {} };

/** The next step from `zoom` in direction `dir` (stays at the ends). */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  if (dir === 1) return ZOOM_STEPS.find((z) => z > zoom + 1e-3) ?? zoom;
  return [...ZOOM_STEPS].reverse().find((z) => z < zoom - 1e-3) ?? zoom;
}

/** `zoom` as a label (`"125%"`). */
export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/** The host a page's zoom is remembered under (`""`: none). */
function zoomKey(url: string): string {
  return parseWebUrl(url)?.host.toLowerCase() ?? "";
}

/** The zoom remembered for `url`'s site (1 when none). */
export function zoomFor(z: SiteZoom, url: string): number {
  return ownSiteZoom(z, url) ?? 1;
}

/** The zoom `url`'s site has of its own (`undefined`: none remembered). */
export function ownSiteZoom(z: SiteZoom, url: string): number | undefined {
  const key = zoomKey(url);
  return (key && z.sites[key]) || undefined;
}

/** Remember `zoom` for `url`'s site (100% forgets it). */
export function setSiteZoom(z: SiteZoom, url: string, zoom: number): SiteZoom {
  const key = zoomKey(url);
  if (!key) return z;
  const sites = { ...z.sites };
  delete sites[key];
  if (Math.abs(zoom - 1) > 1e-3) sites[key] = clampZoom(zoom);
  const keys = Object.keys(sites);
  // The newest is last: the oldest go first past the limit.
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ZOOM_SITES))) {
    delete sites[k];
  }
  if (zoomFor(z, url) === zoomFor({ sites }, url)) return z;
  return { sites };
}

function clampZoom(n: number): number {
  return Math.min(5, Math.max(0.25, Math.round(n * 100) / 100));
}

/** A stored or synced map, checked. */
export function sanitizeZoom(raw: unknown): SiteZoom {
  const src = raw && typeof raw === "object"
    ? (raw as { sites?: unknown }).sites
    : undefined;
  if (!src || typeof src !== "object") return NO_ZOOM;
  const sites: Record<string, number> = {};
  for (const [k, v] of Object.entries(src).slice(0, MAX_ZOOM_SITES)) {
    if (k.length > 260 || !/^[a-z0-9.:[\]-]+$/.test(k)) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (Math.abs(v - 1) > 1e-3) sites[k] = clampZoom(v);
  }
  return { sites };
}
