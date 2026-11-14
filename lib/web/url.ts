/**
 * Web tile URLs: which pages the iframe engine may embed, what the address field turns typed
 * text into, and the header's fallback label. Pure and client-safe.
 *
 * The iframe engine embeds only loopback and local development hosts, on any port: `localhost`
 * and `127.0.0.1` over http or https, and `*.localhost` and `*.test` over https only. The app page
 * is a secure context (`app://` is registered secure on every engine), so an http frame counts as
 * mixed content unless its host is loopback: an `http://*.test` frame is blocked on every engine,
 * and WebKit may upgrade `http://*.localhost` to https. Those URLs open in the default browser
 * instead (the native engine has no such limit). Most public sites refuse to be
 * framed (`X-Frame-Options`, `frame-ancestors`), so they open in the default browser until the
 * native engine lands. The page's CSP allows exactly these origins ({@linkcode FRAME_SRC}).
 *
 * `[::1]` is left out: a CSP host-source has no IPv6 literal (Chromium reports
 * `http://[::1]:*` as a `frame-src` violation), so the page could not frame it anyway. Such a
 * URL goes to the default browser.
 *
 * @module
 */

/** The page a web tile shows, as the workspace keeps and saves it. */
export interface WebPage {
  url: string;
  /** The page's title, when the engine can read it. */
  title?: string;
}

/** The longest URL a web tile keeps (a saved snapshot stays small). */
const MAX_URL = 8192;
/** The longest title a web tile keeps. */
const MAX_TITLE = 300;

/** `raw` as an http(s) URL, or `null`. */
export function parseWebUrl(raw: string): URL | null {
  if (raw.length > MAX_URL) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** A loopback or local development host name (`localhost`, `127.0.0.1`, `*.localhost`, `*.test`). */
export function isDevHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h === "127.0.0.1" ||
    (h.endsWith(".localhost") && h.length > ".localhost".length) ||
    (h.endsWith(".test") && h.length > ".test".length);
}

/** `localhost` or `127.0.0.1`: the hosts an http frame may use inside the secure app page. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h === "127.0.0.1";
}

/**
 * Whether the iframe engine can show `url`: http(s) on a dev host, and never the app's own
 * origin (`appOrigin`, the page's `location.origin`). The iframe is sandboxed with
 * `allow-scripts allow-same-origin`, which would let a same-origin page reach into Qutty's page
 * and its bridge token; under Denext's own runtime the app is at a custom scheme
 * (`app://localhost`) that no URL here can match, but under a stock runtime or the browser demo
 * it is served from `http://127.0.0.1:<port>`.
 */
export function canEmbedInFrame(raw: string, appOrigin?: string): boolean {
  const url = parseWebUrl(raw);
  if (!url || !isDevHost(url.hostname)) return false;
  if (url.username || url.password) return false;
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) return false;
  return appOrigin === undefined || url.origin !== appOrigin;
}

/** The CSP `frame-src` sources that allow what {@linkcode canEmbedInFrame} accepts. */
export const FRAME_SRC: readonly string[] = [
  "http://localhost:*",
  "https://localhost:*",
  "http://127.0.0.1:*",
  "https://127.0.0.1:*",
  "https://*.localhost:*",
  "https://*.test:*",
];

/**
 * What the address field turns typed text into: a full http(s) URL as it is; a bare
 * `localhost:3000/x` or `app.test` gets `http://`, anything else `https://`. `null` for text
 * that is not an address (spaces, another scheme such as `file:` or `javascript:`).
 */
export function addressToUrl(input: string): string | null {
  const text = input.trim();
  if (text === "" || /\s/.test(text)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return parseWebUrl(text)?.href ?? null;
  }
  // `localhost:3000` parses as a URL with the scheme `localhost:`: anything with a colon before
  // the first slash that is not `//` is a host and port here, not a scheme.
  const host = text.split(/[/?#]/)[0].replace(/:\d+$/, "");
  const scheme = isDevHost(host) ? "http" : "https";
  const url = parseWebUrl(`${scheme}://${text}`);
  if (!url) return null;
  // A single word is not an address (there is no search engine to send it to).
  return url.hostname.includes(".") || url.hostname === "localhost"
    ? url.href
    : null;
}

/** The header's label for a page whose title is unknown: its host (with the port). */
export function hostLabel(raw: string): string {
  return parseWebUrl(raw)?.host ?? raw.slice(0, 80);
}

/** A stored or reported page, checked: an http(s) URL and a short title. */
export function sanitizeWebPage(v: unknown): WebPage | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.url !== "string" || !parseWebUrl(r.url)) return undefined;
  const title = typeof r.title === "string"
    // deno-lint-ignore no-control-regex -- control characters are what it strips
    ? r.title.replace(/[\0-\x1f]/g, " ").trim().slice(0, MAX_TITLE)
    : "";
  return { url: r.url, ...(title ? { title } : {}) };
}

/** The header title of a web tile: the page's title, else its host. */
export function webTitle(page: WebPage): string {
  return page.title || hostLabel(page.url);
}
