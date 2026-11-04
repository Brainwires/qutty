// OpenSSH client configuration, as Qutty reads and edits it. Pure and client-safe: no file
// system here (the desktop extension passes file contents in and gets text back), so the page
// can share the types and the tests need no fixtures on disk.
//
// Two files matter. `~/.ssh/config` is the user's own: it is parsed (following `Include`) but
// never rewritten, except for the one-line `Include ~/.ssh/qutty.conf` that `ensureInclude`
// adds at its top. `~/.ssh/qutty.conf` holds the hosts saved in Qutty, so they also work from
// a plain terminal. Qutty's own per-host data (tint, tags, favorite, tmux-on-connect, remote
// command) lives in a `# qutty: {...}` comment inside the host block, which ssh ignores.
//
// The document model keeps every line verbatim and only rewrites the lines it models, so a
// round trip through `parseSshConfig` + `serializeSshConfig` never loses a comment, a `Match`
// block, an unknown directive or the user's indentation.

// ---------------------------------------------------------------------------------------------
// Shapes shared with the page
// ---------------------------------------------------------------------------------------------

/** Qutty's own per-host data, stored as a `# qutty: {...}` comment in the host block. */
export interface SshHostMeta {
  /** A theme palette color id for the tile border (phase B maps it to a color). */
  tint?: string;
  /** Free-form tags, e.g. `prod`. */
  tags?: string[];
  favorite?: boolean;
  /** Attach to (or create) a `qutty` tmux session on connect, so a reconnect lands back in it. */
  tmux?: boolean;
  /** A command to run instead of the login shell (through the remote shell). */
  remoteCommand?: string;
}

/** One `Host` entry, as the connection manager lists it. */
export interface SshHost extends SshHostMeta {
  /** The first literal alias on the `Host` line (the one Qutty connects to and edits by). */
  alias: string;
  /** Every literal alias on the `Host` line (patterns with `*`, `?` or `!` are left out). */
  aliases: string[];
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
  /** Every other directive in the block, verbatim and in order (forwards, agent, ciphers...). */
  directives: { key: string; value: string }[];
  /** The file the entry came from. */
  source: string;
  /** Whether Qutty may edit or delete it (only entries in qutty.conf). */
  editable: boolean;
}

/** What `sshSaveHost` takes: the modelled fields of a host in qutty.conf. */
export interface SshHostInput extends SshHostMeta {
  alias: string;
  /** When renaming: the alias the block currently has. Its unmodelled directives are kept. */
  previousAlias?: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
}

/** A parsed `[user@]host[:port]`, as typed into the manager's filter box. */
export interface SshQuickTarget {
  user?: string;
  host: string;
  port?: number;
}

/** What to connect to: a saved alias, or a quick-connect destination. */
export type SshTarget = { alias: string } | SshQuickTarget;

// ---------------------------------------------------------------------------------------------
// Validation (what may go on an ssh command line or into qutty.conf)
// ---------------------------------------------------------------------------------------------

/** An alias or host name: ssh's safe charset, and never a leading `-` (it would be an option). */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
/** An IPv6 literal (what `[...]` wraps): hex, colons, dots (v4-mapped) and a `%zone`. */
const IPV6 = /^[0-9A-Fa-f:.]+(%[A-Za-z0-9._-]+)?$/;
const SAFE_USER = /^[A-Za-z0-9_][A-Za-z0-9._@+-]{0,63}$/;
/** A `ProxyJump` list: `[user@]host[:port]`, comma separated. */
const SAFE_JUMP = /^[A-Za-z0-9][A-Za-z0-9._@:\[\]%,-]{0,511}$/;

export function isSafeAlias(s: string): boolean {
  return SAFE_NAME.test(s);
}

export function isSafeHost(s: string): boolean {
  // Every IPv6 literal has at least two colons; `a:b` is not one.
  return SAFE_NAME.test(s) || (s.split(":").length >= 3 && IPV6.test(s));
}

export function isSafeUser(s: string): boolean {
  return SAFE_USER.test(s);
}

export function isSafeProxyJump(s: string): boolean {
  return SAFE_JUMP.test(s);
}

function isValidPort(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * A value written to qutty.conf: no newline (it would start another directive), no NUL and no
 * double quote (OpenSSH has no escape for one inside a quoted value).
 */
export function isSafeConfigValue(s: string): boolean {
  return s.length > 0 && s.length <= 4096 && !/[\n\r"\0]/.test(s);
}

/** The target's problem as a message, or `undefined` when it is fine. */
export function targetProblem(t: SshTarget): string | undefined {
  if ("alias" in t) return isSafeAlias(t.alias) ? undefined : "bad alias";
  if (!isSafeHost(t.host)) return "bad host";
  if (t.user !== undefined && !isSafeUser(t.user)) return "bad user";
  if (t.port !== undefined && !isValidPort(t.port)) return "bad port";
  return undefined;
}

/** `user@host:port` for a quick target, the alias otherwise (what recents and labels show). */
export function targetLabel(t: SshTarget): string {
  if ("alias" in t) return t.alias;
  const host = t.host.includes(":") ? `[${t.host}]` : t.host;
  return `${t.user ? `${t.user}@` : ""}${host}${t.port ? `:${t.port}` : ""}`;
}

/**
 * Parse `[user@]host[:port]`. IPv6 goes in brackets when it has a port (`[::1]:22`); a bare
 * address with several colons is taken as a host without a port. `undefined` when it is not a
 * destination (empty, a leading `-`, a bad port, characters ssh would not accept).
 */
export function parseQuickTarget(input: string): SshQuickTarget | undefined {
  const s = input.trim();
  if (!s) return undefined;
  let user: string | undefined;
  let rest = s;
  const at = s.lastIndexOf("@");
  if (at >= 0) {
    user = s.slice(0, at);
    rest = s.slice(at + 1);
    if (!isSafeUser(user)) return undefined;
  }
  let host: string;
  let portText: string | undefined;
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (bracket) {
    host = bracket[1];
    portText = bracket[2];
  } else if ((rest.match(/:/g) ?? []).length > 1) {
    host = rest; // bare IPv6
  } else {
    const colon = rest.indexOf(":");
    host = colon < 0 ? rest : rest.slice(0, colon);
    portText = colon < 0 ? undefined : rest.slice(colon + 1);
  }
  if (!isSafeHost(host)) return undefined;
  let port: number | undefined;
  if (portText !== undefined) {
    if (!/^\d{1,5}$/.test(portText)) return undefined;
    port = Number(portText);
    if (!isValidPort(port)) return undefined;
  }
  return { ...(user ? { user } : {}), host, ...(port ? { port } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Lines and directives (OpenSSH readconf rules)
// ---------------------------------------------------------------------------------------------

interface Directive {
  /** The keyword as written. */
  key: string;
  /** Lower-cased keyword (ssh keywords are case-insensitive). */
  lkey: string;
  /** The rest of the line, as written (quotes included), trailing whitespace trimmed. */
  value: string;
}

/** `key value`, `key=value` or `key = value`; `undefined` for blank and comment lines. */
export function parseDirective(line: string): Directive | undefined {
  const s = line.replace(/\r$/, "").trim();
  if (s === "" || s.startsWith("#")) return undefined;
  const m = /^([^\s=]+)\s*=?\s*(.*)$/.exec(s);
  if (!m) return undefined;
  return { key: m[1], lkey: m[1].toLowerCase(), value: m[2].trimEnd() };
}

/** The first (possibly quoted) word of a value, unquoted. */
function unquote(value: string): string {
  const words = splitWords(value);
  return words[0] ?? "";
}

/** Split a value into words, honoring double quotes (ssh has no escapes inside them). */
export function splitWords(value: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    out.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return out;
}

/** Quote a value for a config line when ssh would otherwise split it. */
export function quoteValue(value: string): string {
  return /\s/.test(value) || value.startsWith('"') ? `"${value}"` : value;
}

const isPattern = (alias: string) => /[*?!]/.test(alias);

// ---------------------------------------------------------------------------------------------
// The document model
// ---------------------------------------------------------------------------------------------

/** A `Host` or `Match` block: header line index and the line after its last (blank lines included). */
interface Block {
  kind: "host" | "match";
  start: number;
  end: number;
  /** `Host` patterns as written (empty for `Match`). */
  patterns: string[];
}

/** A config file as lines, with the block structure over them. */
export interface SshConfigDoc {
  /** The file's lines (`text.split("\n")`, so a final newline shows as a trailing `""`). */
  lines: string[];
  blocks: Block[];
}

export function parseSshConfig(text: string): SshConfigDoc {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  lines.forEach((line, i) => {
    const d = parseDirective(line);
    if (!d || (d.lkey !== "host" && d.lkey !== "match")) return;
    const prev = blocks.at(-1);
    if (prev) prev.end = i;
    blocks.push({
      kind: d.lkey,
      start: i,
      end: lines.length,
      patterns: d.lkey === "host" ? splitWords(d.value) : [],
    });
  });
  return { lines, blocks };
}

export function serializeSshConfig(doc: SshConfigDoc): string {
  return doc.lines.join("\n");
}

/** The `Include` values (as written, one entry per word) with their line index, in file order. */
export function includeValues(
  doc: SshConfigDoc,
): { value: string; line: number }[] {
  const out: { value: string; line: number }[] = [];
  doc.lines.forEach((text, line) => {
    const d = parseDirective(text);
    if (d?.lkey !== "include") return;
    for (const value of splitWords(d.value)) out.push({ value, line });
  });
  return out;
}

const META_PREFIX = "# qutty:";

function parseMeta(line: string): SshHostMeta | undefined {
  const s = line.trim();
  if (!s.startsWith(META_PREFIX)) return undefined;
  try {
    const raw = JSON.parse(s.slice(META_PREFIX.length)) as Record<
      string,
      unknown
    >;
    if (typeof raw !== "object" || raw === null) return undefined;
    return normalizeMeta(raw);
  } catch {
    return undefined;
  }
}

/** Keep only well-typed metadata fields (a hand-edited comment may hold anything). */
function normalizeMeta(raw: Record<string, unknown>): SshHostMeta {
  const meta: SshHostMeta = {};
  if (typeof raw.tint === "string" && raw.tint) meta.tint = raw.tint;
  if (Array.isArray(raw.tags)) {
    const tags = raw.tags.filter((t): t is string =>
      typeof t === "string" && t !== ""
    );
    if (tags.length > 0) meta.tags = tags;
  }
  if (raw.favorite === true) meta.favorite = true;
  if (raw.tmux === true) meta.tmux = true;
  if (typeof raw.remoteCommand === "string" && raw.remoteCommand) {
    meta.remoteCommand = raw.remoteCommand;
  }
  return meta;
}

/** `# qutty: {...}`, or `undefined` when there is nothing to store. */
export function serializeMeta(meta: SshHostMeta): string | undefined {
  const m = normalizeMeta(meta as Record<string, unknown>);
  return Object.keys(m).length === 0
    ? undefined
    : `${META_PREFIX} ${JSON.stringify(m)}`;
}

/** The directives Qutty models as fields; everything else is kept verbatim. */
const MODELLED: Record<string, keyof SshHostInput> = {
  hostname: "hostName",
  user: "user",
  port: "port",
  identityfile: "identityFile",
  proxyjump: "proxyJump",
};
const CANONICAL: Record<string, string> = {
  hostname: "HostName",
  user: "User",
  port: "Port",
  identityfile: "IdentityFile",
  proxyjump: "ProxyJump",
};

/** The host entries of a document: one per `Host` line with at least one literal alias. */
export function hostsOf(
  doc: SshConfigDoc,
  source: string,
  editable: boolean,
): SshHost[] {
  return hostBlocks(doc, source, editable).map((h) => h.host);
}

/** `hostsOf` with each entry's `Host` line index (to merge included files in place). */
function hostBlocks(
  doc: SshConfigDoc,
  source: string,
  editable: boolean,
): { host: SshHost; line: number }[] {
  const hosts: { host: SshHost; line: number }[] = [];
  for (const b of doc.blocks) {
    if (b.kind !== "host") continue;
    const aliases = b.patterns.filter((p) => !isPattern(p));
    if (aliases.length === 0) continue;
    const host: SshHost = {
      alias: aliases[0],
      aliases,
      directives: [],
      source,
      editable,
    };
    const seen = new Set<string>();
    for (let i = b.start + 1; i < b.end; i++) {
      const line = doc.lines[i];
      const meta = parseMeta(line);
      if (meta) {
        Object.assign(host, meta);
        continue;
      }
      const d = parseDirective(line);
      if (!d) continue;
      // ssh keeps the first value of a repeated option; the rest stay as plain directives.
      if (d.lkey in MODELLED && !seen.has(d.lkey)) {
        seen.add(d.lkey);
        const v = unquote(d.value);
        if (d.lkey === "port") {
          const n = Number(v);
          if (isValidPort(n)) host.port = n;
        } else {
          (host as unknown as Record<string, string>)[MODELLED[d.lkey]] = v;
        }
      } else {
        host.directives.push({ key: d.key, value: d.value });
      }
    }
    hosts.push({ host, line: b.start });
  }
  return hosts;
}

/** The host block whose `Host` line names `alias` literally. */
function findBlock(doc: SshConfigDoc, alias: string): Block | undefined {
  return doc.blocks.find((b) =>
    b.kind === "host" && b.patterns.includes(alias)
  );
}

/** The indentation the file uses for directives (`"  "` when it has none yet). */
function detectIndent(lines: string[]): string {
  for (const line of lines) {
    const m = /^(\s+)\S/.exec(line);
    if (m && parseDirective(line)) return m[1];
  }
  return "  ";
}

/** The modelled lines of `input`, in a fixed order, as `[lkey, text]`. */
function modelledLines(
  input: SshHostInput,
  indent: string,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [lkey, field] of Object.entries(MODELLED)) {
    const v = input[field];
    if (v === undefined || v === "") continue;
    out.set(lkey, `${indent}${CANONICAL[lkey]} ${quoteValue(String(v))}`);
  }
  const meta = serializeMeta(input);
  if (meta) out.set("#meta", `${indent}${meta}`);
  return out;
}

/**
 * Add or update the host block for `input.alias` (or `input.previousAlias` when renaming),
 * rewriting only the modelled directives and the metadata comment; every other line of the
 * block, and of the file, stays as it is. Returns the new text.
 */
export function upsertHost(text: string, input: SshHostInput): string {
  const doc = parseSshConfig(text);
  const indent = detectIndent(doc.lines);
  const wanted = modelledLines(input, indent);
  const existing = findBlock(doc, input.previousAlias ?? input.alias) ??
    findBlock(doc, input.alias);
  if (!existing) {
    const body = [`Host ${input.alias}`, ...wanted.values()];
    const lines = doc.lines;
    while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push(...body, "");
    return lines.join("\n");
  }
  const header = doc.lines[existing.start];
  const oldAlias = input.previousAlias ?? input.alias;
  const patterns = existing.patterns.map((p) =>
    p === oldAlias ? input.alias : p
  );
  const headerDirective = parseDirective(header)!;
  const newHeader = header.replace(
    headerDirective.value,
    patterns.map(quoteValue).join(" "),
  );
  const body: string[] = [];
  const placed = new Set<string>();
  for (let i = existing.start + 1; i < existing.end; i++) {
    const line = doc.lines[i];
    const d = parseDirective(line);
    const slot = parseMeta(line)
      ? "#meta"
      : d && d.lkey in MODELLED
      ? d.lkey
      : undefined;
    if (slot === undefined) {
      body.push(line);
      continue;
    }
    // A repeated modelled directive is dropped: ssh would ignore it, and keeping it would
    // resurrect the old value if the first line were removed later.
    if (placed.has(slot)) continue;
    placed.add(slot);
    const replacement = wanted.get(slot);
    if (replacement !== undefined) body.push(replacement);
  }
  const missing = [...wanted].filter(([slot]) => !placed.has(slot)).map((
    [, l],
  ) => l);
  const lines = [
    ...doc.lines.slice(0, existing.start),
    newHeader,
    ...missing,
    ...body,
    ...doc.lines.slice(existing.end),
  ];
  return lines.join("\n");
}

/** Remove the host block for `alias`. The text is unchanged when there is none. */
export function deleteHost(text: string, alias: string): string {
  const doc = parseSshConfig(text);
  const b = findBlock(doc, alias);
  if (!b) return text;
  const lines = [...doc.lines.slice(0, b.start), ...doc.lines.slice(b.end)];
  // The removed block may have been the only thing after the preamble's blank separator.
  while (lines.length > 1 && lines.at(-1) === "" && lines.at(-2) === "") {
    lines.pop();
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Include handling
// ---------------------------------------------------------------------------------------------

/** How `loadSshHosts` reads files: injected so the desktop side and the tests supply it. */
export interface SshConfigFs {
  /** The file's text, or `undefined` when it does not exist or cannot be read. */
  readText(path: string): Promise<string | undefined>;
  /** The files matching a glob pattern (absolute), sorted. */
  glob(pattern: string): Promise<string[]>;
}

/** How deep `Include` may nest (ssh itself stops at 16). */
const MAX_INCLUDE_DEPTH = 8;

const hasGlob = (s: string) => /[*?\[]/.test(s);

/** An `Include` value as an absolute path: `~` is the home, a relative one is under `~/.ssh`. */
export function resolveIncludePath(value: string, home: string): string {
  if (value.startsWith("~/")) return `${home}/${value.slice(2)}`;
  if (value === "~") return home;
  if (value.startsWith("/")) return value;
  return `${home}/.ssh/${value}`;
}

/**
 * Every host entry, in the order ssh reads them: `~/.ssh/config` with each `Include` expanded
 * where it stands (read-only entries), then `~/.ssh/qutty.conf` (editable). The qutty file is
 * skipped when reached through an `Include`, so it is listed once, as editable, whether or not
 * the Include is in place yet. (An `Include` inside a `Host` block is, to ssh, conditional on
 * that block; here its hosts are listed like any other.)
 */
export async function loadSshHosts(
  home: string,
  fs: SshConfigFs,
): Promise<SshHost[]> {
  const quttyConf = quttyConfPath(home);
  const visited = new Set<string>([quttyConf]);
  const visit = async (path: string, depth: number): Promise<SshHost[]> => {
    if (visited.has(path) || depth > MAX_INCLUDE_DEPTH) return [];
    visited.add(path);
    const text = await fs.readText(path);
    if (text === undefined) return [];
    const doc = parseSshConfig(text);
    const own = hostBlocks(doc, path, false);
    const out: SshHost[] = [];
    for (const inc of includeValues(doc)) {
      while (own.length > 0 && own[0].line < inc.line) {
        out.push(own.shift()!.host);
      }
      const resolved = resolveIncludePath(inc.value, home);
      const files = hasGlob(resolved) ? await fs.glob(resolved) : [resolved];
      for (const f of files) out.push(...await visit(f, depth + 1));
    }
    return [...out, ...own.map((h) => h.host)];
  };
  const hosts = await visit(userConfigPath(home), 0);
  const own = await fs.readText(quttyConf);
  if (own !== undefined) {
    hosts.push(...hostsOf(parseSshConfig(own), quttyConf, true));
  }
  return hosts;
}

export const userConfigPath = (home: string): string => `${home}/.ssh/config`;
export const quttyConfPath = (home: string): string =>
  `${home}/.ssh/qutty.conf`;
const QUTTY_INCLUDE_LINE = "Include ~/.ssh/qutty.conf";

/** A glob as a RegExp over a whole path (`*` and `?` do not cross `/`). */
function globToRegExp(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${re}$`);
}

/**
 * Whether the user's config already includes qutty.conf globally: an `Include` before the
 * first `Host`/`Match` (after one it would apply to that block only) whose value names the
 * file, by any spelling (`~/.ssh/qutty.conf`, `qutty.conf`, the absolute path, or a glob).
 */
export function hasQuttyInclude(text: string, home: string): boolean {
  const doc = parseSshConfig(text);
  const firstBlock = doc.blocks[0]?.start ?? doc.lines.length;
  const target = quttyConfPath(home);
  for (let i = 0; i < firstBlock; i++) {
    const d = parseDirective(doc.lines[i]);
    if (d?.lkey !== "include") continue;
    for (const w of splitWords(d.value)) {
      const resolved = resolveIncludePath(w, home);
      if (resolved === target) return true;
      if (hasGlob(resolved) && globToRegExp(resolved).test(target)) return true;
    }
  }
  return false;
}

/**
 * The user's config with `Include ~/.ssh/qutty.conf` at the very top (it must precede any
 * `Host`/`Match` to apply to every connection). `changed` is false when it is there already,
 * and then `text` is the input, byte for byte.
 */
export function ensureInclude(
  text: string,
  home: string,
): { text: string; changed: boolean } {
  if (hasQuttyInclude(text, home)) return { text, changed: false };
  const body = text === "" ? "" : `\n${text}`;
  return { text: `${QUTTY_INCLUDE_LINE}\n${body}`, changed: true };
}
