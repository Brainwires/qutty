// Port forwards on a shared SSH connection: the model the forward panel edits, its strict
// parser, and the `ssh -O forward` / `-O cancel` arguments (built in lib/ssh-command.ts). Pure
// and client-safe, like lib/ssh-config.ts.
//
// A forward is added to, or removed from, a running master connection through its control
// socket: `ssh -O forward -L 8080:localhost:80 host` asks the master to listen, and
// `ssh -O cancel -L …` stops it. OpenSSH has no "list" control command, so the panel shows the
// forwards Qutty added on that connection (desktop/ssh.ts tracks them per connection, and drops
// them when the master is gone) next to the ones the host's own config starts with it
// (`LocalForward` and friends, read-only).
//
// Favourites are saved per host as `# qutty:` metadata (`"forwards": ["L 8080:localhost:80"]`),
// never as `LocalForward` lines: those would open on every connection, also from a plain
// terminal. Only these shapes are accepted, every field checked: TCP ports 1-65535 and host
// names or addresses in ssh's safe charset (never a leading `-`, so nothing reads as an option).
// Unix-socket forwards and `-R 0` (a port the server picks) are not offered.

import { isSafeHost, splitWords } from "./ssh-config.ts";

/** `-L` (a local port to a host the server reaches), `-R` (the reverse), `-D` (SOCKS). */
export type ForwardKind = "local" | "remote" | "dynamic";

/** One forward. `host` and `hostPort` are set for local and remote ones, never for dynamic. */
export interface SshForward {
  kind: ForwardKind;
  /** The listening address (`127.0.0.1`, `localhost`); absent means ssh's default (loopback). */
  bind?: string;
  /** The listening port. */
  port: number;
  /** Where connections go (`localhost`, `db.internal`, `::1`). */
  host?: string;
  hostPort?: number;
}

export const FORWARD_KINDS: readonly ForwardKind[] = [
  "local",
  "remote",
  "dynamic",
];

const FLAG: Record<ForwardKind, "-L" | "-R" | "-D"> = {
  local: "-L",
  remote: "-R",
  dynamic: "-D",
};
const LETTER: Record<ForwardKind, "L" | "R" | "D"> = {
  local: "L",
  remote: "R",
  dynamic: "D",
};
const BY_LETTER: Record<string, ForwardKind> = {
  L: "local",
  R: "remote",
  D: "dynamic",
};

/** ssh's flag for a kind. */
function forwardFlag(kind: ForwardKind): "-L" | "-R" | "-D" {
  return FLAG[kind];
}

/** What the panel calls a kind. */
export function kindLabel(kind: ForwardKind): string {
  return kind === "local"
    ? "Local (-L)"
    : kind === "remote"
    ? "Remote (-R)"
    : "Dynamic (-D)";
}

/** The example the spec field shows for a kind. */
export function specPlaceholder(kind: ForwardKind): string {
  return kind === "dynamic"
    ? "1080"
    : kind === "local"
    ? "8080:localhost:80"
    : "9000:localhost:3000";
}

const MAX_SPEC = 300;
const PORT = /^\d{1,5}$/;

function port(s: string): number | undefined {
  if (!PORT.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : undefined;
}

/**
 * Split `a:b:[::1]:c` on colons, a `[...]` group (an IPv6 literal) staying whole. `undefined`
 * when a bracket is not closed or is followed by anything but a colon.
 */
function splitSpec(s: string): string[] | undefined {
  const out: string[] = [];
  let i = 0;
  while (i <= s.length) {
    if (s[i] === "[") {
      const close = s.indexOf("]", i);
      if (close < 0) return undefined;
      out.push(s.slice(i + 1, close));
      i = close + 1;
      if (i < s.length && s[i] !== ":") return undefined;
      i++;
      continue;
    }
    const colon = s.indexOf(":", i);
    const end = colon < 0 ? s.length : colon;
    const part = s.slice(i, end);
    if (part.includes("[") || part.includes("]")) return undefined;
    out.push(part);
    i = end + 1;
  }
  return out;
}

/** The parsed forward, or why the text is not one. */
export type ForwardParse = { forward: SshForward; error?: undefined } | {
  forward?: undefined;
  error: string;
};

/**
 * Parse a forward as ssh writes it after the flag: `[bind:]port:host:hostport` for local and
 * remote, `[bind:]port` for dynamic. Strict: anything ssh would read differently, or that is
 * not a plain TCP forward, is refused with a short reason.
 */
export function parseForward(kind: ForwardKind, text: string): ForwardParse {
  const s = text.trim();
  if (s === "") return { error: "Type a forward." };
  if (s.length > MAX_SPEC) return { error: "Too long." };
  if (/\s/.test(s)) return { error: "No spaces." };
  const parts = splitSpec(s);
  if (!parts || parts.some((p) => p === "")) {
    return { error: "Use colons between the parts, brackets around IPv6." };
  }
  const want = kind === "dynamic" ? [1, 2] : [3, 4];
  if (!want.includes(parts.length)) {
    return {
      error: kind === "dynamic"
        ? "Write it as port or bind:port."
        : "Write it as port:host:hostport or bind:port:host:hostport.",
    };
  }
  const hasBind = parts.length === want[1];
  const bind = hasBind ? parts[0] : undefined;
  const rest = hasBind ? parts.slice(1) : parts;
  if (bind !== undefined && !isSafeHost(bind)) {
    return { error: `${bind} is not a listening address.` };
  }
  const listen = port(rest[0]);
  if (listen === undefined) return { error: `${rest[0]} is not a port.` };
  const forward: SshForward = {
    kind,
    ...(bind !== undefined ? { bind } : {}),
    port: listen,
  };
  if (kind === "dynamic") return { forward };
  if (!isSafeHost(rest[1])) return { error: `${rest[1]} is not a host.` };
  const hostPort = port(rest[2]);
  if (hostPort === undefined) return { error: `${rest[2]} is not a port.` };
  return { forward: { ...forward, host: rest[1], hostPort } };
}

/** The reason a forward (from the page, so of unknown shape) is unusable, or `undefined`. */
export function forwardProblem(f: unknown): string | undefined {
  if (typeof f !== "object" || f === null || Array.isArray(f)) {
    return "a forward must be an object";
  }
  const o = f as Record<string, unknown>;
  if (!FORWARD_KINDS.includes(o.kind as ForwardKind)) return "bad kind";
  const kind = o.kind as ForwardKind;
  const isPort = (n: unknown) =>
    typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535;
  if (!isPort(o.port)) return "bad port";
  if (
    o.bind !== undefined && (typeof o.bind !== "string" || !isSafeHost(o.bind))
  ) return "bad listening address";
  if (kind === "dynamic") {
    return o.host === undefined && o.hostPort === undefined
      ? undefined
      : "a dynamic forward has no destination";
  }
  if (typeof o.host !== "string" || !isSafeHost(o.host)) return "bad host";
  if (!isPort(o.hostPort)) return "bad destination port";
  return undefined;
}

const hostPart = (h: string) => (h.includes(":") ? `[${h}]` : h);
const listenText = (f: SshForward) =>
  `${f.bind !== undefined ? `${hostPart(f.bind)}:` : ""}${f.port}`;

/** The argument after `-L` / `-R` / `-D`: `[bind:]port[:host:hostport]`. */
export function forwardSpec(f: SshForward): string {
  const listen = listenText(f);
  return f.kind === "dynamic"
    ? listen
    : `${listen}:${hostPart(f.host!)}:${f.hostPort}`;
}

/** The arguments for ssh: `["-L", "8080:localhost:80"]`. Throws on a bad forward. */
export function forwardArgs(f: SshForward): string[] {
  const problem = forwardProblem(f);
  if (problem) throw new Error(problem);
  return [forwardFlag(f.kind), forwardSpec(f)];
}

/** A short line for the panel: `8080 → localhost:80`, `SOCKS on 1080`. */
export function forwardText(f: SshForward): string {
  const listen = listenText(f);
  if (f.kind === "dynamic") return `SOCKS on ${listen}`;
  const to = `${hostPart(f.host!)}:${f.hostPort}`;
  return f.kind === "local"
    ? `local ${listen} → ${to}`
    : `remote ${listen} → ${to}`;
}

/** A stable key: two forwards with the same key are the same forward to ssh. */
export function forwardKey(f: SshForward): string {
  return `${LETTER[f.kind]} ${forwardSpec(f)}`;
}

export function sameForward(a: SshForward, b: SshForward): boolean {
  return forwardKey(a) === forwardKey(b);
}

/** `forwards` with `f` added once (an equal one already there is kept, not duplicated). */
export function addForward(
  forwards: readonly SshForward[],
  f: SshForward,
): SshForward[] {
  return forwards.some((x) => sameForward(x, f))
    ? [...forwards]
    : [...forwards, f];
}

/** `forwards` without `f`. */
export function removeForward(
  forwards: readonly SshForward[],
  f: SshForward,
): SshForward[] {
  return forwards.filter((x) => !sameForward(x, f));
}

// ---------------------------------------------------------------------------------------------
// Favourites (`# qutty:` metadata) and the host's own forward directives
// ---------------------------------------------------------------------------------------------

/** A favourite as stored in the metadata: `L 8080:localhost:80`. */
export function favoriteText(f: SshForward): string {
  return forwardKey(f);
}

/** A stored favourite back as a forward (`undefined` when it does not parse). */
export function parseFavorite(text: string): SshForward | undefined {
  const m = /^([LRD]) (\S+)$/.exec(text);
  if (!m) return undefined;
  return parseForward(BY_LETTER[m[1]], m[2]).forward;
}

/** The favourites of a host's metadata, the unreadable ones left out. */
export function favoritesOf(
  stored: readonly string[] | undefined,
): SshForward[] {
  let out: SshForward[] = [];
  for (const s of stored ?? []) {
    const f = parseFavorite(s);
    if (f) out = addForward(out, f);
  }
  return out;
}

const DIRECTIVE_KIND: Record<string, ForwardKind> = {
  localforward: "local",
  remoteforward: "remote",
  dynamicforward: "dynamic",
};

/**
 * The forwards a host's config starts with every connection (`LocalForward 5432 localhost:5432`,
 * `DynamicForward 1080`), as far as they are plain TCP forwards. Shown read-only.
 */
export function configuredForwards(
  directives: readonly { key: string; value: string }[],
): SshForward[] {
  const out: SshForward[] = [];
  for (const d of directives) {
    const kind = DIRECTIVE_KIND[d.key.toLowerCase()];
    if (!kind) continue;
    const words = splitWords(d.value);
    const text = kind === "dynamic" ? words[0] : words.slice(0, 2).join(":");
    const f = text ? parseForward(kind, text).forward : undefined;
    if (f) out.push(f);
  }
  return out;
}
