/**
 * The site permissions a web tile remembers: for each origin, each permission kind (camera,
 * microphone, location, notifications …) the user said "always" to, allowed or denied. Stored on
 * its own localStorage key ({@linkcode SITE_PERMISSIONS_STORAGE_KEY}) and synced across windows
 * (lib/web/synced.ts), like the bookmarks and the per-site zoom.
 *
 * Where the runtime hands a page's permission requests to the app (Denext's `permissions: "app"`,
 * `webViewCapabilities().permissionRequests`), the web tile asks {@linkcode decideRequest} first:
 *
 * - `"allow"`: every kind the request names is remembered as allowed, so it is allowed without a
 *   word (a request naming several kinds is allowed only when each of them is).
 * - `"deny"`: one of its kinds is remembered as denied, so it can never be all allowed: refused
 *   without a word.
 * - `"ask"`: the tile's permission bar asks (app/web-chrome.tsx); with "Remember" ticked the
 *   answer is kept for every kind of the request ({@linkcode rememberChoice}).
 *
 * Settings → Links → Site permissions lists what is remembered ({@linkcode permissionEntries}),
 * with Forget per entry ({@linkcode forgetPermission}) and Clear all.
 *
 * Origins are kept as the runtime reports them, lower-cased (`"https://example.com"`,
 * `"http://localhost:8000"`); anything that is not an http(s) origin is not remembered. Kinds are
 * Denext's names (`"camera"`, `"microphone"`, `"geolocation"`, `"notifications"` …).
 *
 * Pure and client-safe.
 *
 * @module
 */

/** The localStorage key; bump the suffix when the shape changes incompatibly. */
export const SITE_PERMISSIONS_STORAGE_KEY = "qutty.web-permissions.v1";

/** The most sites remembered (the oldest go first). */
const MAX_SITES = 500;
/** The most kinds remembered per site. */
const MAX_KINDS = 32;

/** What was said for a kind. */
export type PermissionChoice = "allow" | "deny";

/** The remembered choices: origin → kind → choice. */
export interface SitePermissions {
  readonly sites: Readonly<
    Record<string, Readonly<Record<string, PermissionChoice>>>
  >;
}

export const NO_SITE_PERMISSIONS: SitePermissions = { sites: {} };

/** What to do with a request. */
export type PermissionDecision = "allow" | "deny" | "ask";

/** `origin` as it is remembered (`""`: not an http(s) origin). */
export function originKey(origin: string): string {
  if (typeof origin !== "string" || origin.length > 300) return "";
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  return url.origin.toLowerCase();
}

/** A kind's name as it is remembered (`""`: not one). */
function kindKey(kind: string): string {
  return typeof kind === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(kind)
    ? kind
    : "";
}

/** What is remembered for `kind` on `origin`. */
export function sitePermission(
  p: SitePermissions,
  origin: string,
  kind: string,
): PermissionChoice | undefined {
  const key = originKey(origin);
  const site = key && Object.hasOwn(p.sites, key) ? p.sites[key] : undefined;
  return site && Object.hasOwn(site, kind) ? site[kind] : undefined;
}

/** What to do with a request from `origin` for `kinds` (see the module doc). */
export function decideRequest(
  p: SitePermissions,
  origin: string,
  kinds: readonly string[],
): PermissionDecision {
  if (!originKey(origin) || kinds.length === 0) return "ask";
  const choices = kinds.map((k) => sitePermission(p, origin, k));
  if (choices.includes("deny")) return "deny";
  return choices.every((c) => c === "allow") ? "allow" : "ask";
}

/** Remember `choice` for each of `kinds` on `origin`. */
export function rememberChoice(
  p: SitePermissions,
  origin: string,
  kinds: readonly string[],
  choice: PermissionChoice,
): SitePermissions {
  const key = originKey(origin);
  const named = kinds.map(kindKey).filter(Boolean);
  if (!key || named.length === 0) return p;
  const had = Object.hasOwn(p.sites, key) ? p.sites[key] : {};
  if (named.every((k) => Object.hasOwn(had, k) && had[k] === choice)) return p;
  const site: Record<string, PermissionChoice> = { ...had };
  for (const k of named) site[k] = choice;
  const sites = { ...p.sites };
  // The newest is last: the oldest go first past the limit.
  delete sites[key];
  sites[key] = limitKinds(site);
  const keys = Object.keys(sites);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SITES))) {
    delete sites[k];
  }
  return { sites };
}

function limitKinds(
  site: Record<string, PermissionChoice>,
): Record<string, PermissionChoice> {
  const entries = Object.entries(site);
  if (entries.length <= MAX_KINDS) return site;
  return Object.fromEntries(entries.slice(entries.length - MAX_KINDS));
}

/** Forget `kind` on `origin` (no `kind`: everything about `origin`). */
export function forgetPermission(
  p: SitePermissions,
  origin: string,
  kind?: string,
): SitePermissions {
  const key = originKey(origin);
  const had = key && Object.hasOwn(p.sites, key) ? p.sites[key] : undefined;
  if (!had) return p;
  const sites = { ...p.sites };
  if (kind === undefined) {
    delete sites[key];
    return { sites };
  }
  if (!Object.hasOwn(had, kind)) return p;
  const site = { ...had };
  delete site[kind];
  if (Object.keys(site).length) sites[key] = site;
  else delete sites[key];
  return { sites };
}

/** Nothing remembered. */
export function clearSitePermissions(): SitePermissions {
  return NO_SITE_PERMISSIONS;
}

/** One remembered choice, as Settings lists it. */
export interface PermissionEntry {
  origin: string;
  kind: string;
  choice: PermissionChoice;
}

/** Every remembered choice, by origin then kind. */
export function permissionEntries(p: SitePermissions): PermissionEntry[] {
  const out: PermissionEntry[] = [];
  for (const origin of Object.keys(p.sites).sort()) {
    const site = p.sites[origin];
    for (const kind of Object.keys(site).sort()) {
      out.push({ origin, kind, choice: site[kind] });
    }
  }
  return out;
}

/** A stored or synced value, checked. */
export function sanitizeSitePermissions(raw: unknown): SitePermissions {
  const src = raw && typeof raw === "object"
    ? (raw as { sites?: unknown }).sites
    : undefined;
  if (!src || typeof src !== "object" || Array.isArray(src)) {
    return NO_SITE_PERMISSIONS;
  }
  const sites: Record<string, Record<string, PermissionChoice>> = {};
  for (const [origin, kinds] of Object.entries(src).slice(-MAX_SITES)) {
    const key = originKey(origin);
    if (!key || key !== origin) continue;
    if (!kinds || typeof kinds !== "object" || Array.isArray(kinds)) continue;
    const site: Record<string, PermissionChoice> = {};
    for (const [kind, choice] of Object.entries(kinds).slice(-MAX_KINDS)) {
      if (!kindKey(kind)) continue;
      if (choice === "allow" || choice === "deny") site[kind] = choice;
    }
    if (Object.keys(site).length) sites[key] = site;
  }
  return { sites };
}

/** The plain words for the permission kinds Denext names. */
const KIND_LABELS: Readonly<Record<string, string>> = {
  camera: "use your camera",
  microphone: "use your microphone",
  screen: "share your screen",
  geolocation: "know your location",
  notifications: "show notifications",
  midi: "use MIDI devices",
  "pointer-lock": "lock the pointer",
  "storage-access": "use its cookies on other sites",
  sensors: "use motion sensors",
  "clipboard-read": "read the clipboard",
  "window-management": "manage windows on your displays",
  "local-fonts": "use the fonts on this computer",
  "file-system": "edit files on this computer",
  "multiple-downloads": "download several files",
  autoplay: "play media on its own",
};

/** `kind` in plain words, as the end of "example.com wants to …". */
function permissionLabel(kind: string): string {
  return KIND_LABELS[kind] ?? `use "${kind.replace(/-/g, " ")}"`;
}

/** `kinds` in plain words, joined (`"use your camera and use your microphone"`). */
export function permissionsLabel(kinds: readonly string[]): string {
  const words = kinds.map(permissionLabel);
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** A kind's short name, as Settings lists it (`"Camera"`, `"Location"`). */
export function permissionName(kind: string): string {
  if (kind === "geolocation") return "Location";
  if (kind === "storage-access") return "Cross-site cookies";
  const words = kind.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
