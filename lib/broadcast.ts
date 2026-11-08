// deno-lint-ignore-file no-control-regex
/**
 * Broadcast input (cluster ssh): what the user types in one selected tile goes to every selected
 * tile. The rules live here, pure, so they are testable without xterm or a DOM; the terminal
 * manager applies them to each chunk xterm hands it, and the workspace keeps the selection.
 *
 * Safety rules:
 *
 * - Nothing is sent to a tile that is not selected, and nothing is sent from a tile that is not
 *   selected (typing in it reaches it alone).
 * - Only the user's own keyboard and paste input is repeated. xterm also writes data of its own
 *   to the program: replies to queries (DA, DSR, the cursor position, OSC colour reports),
 *   focus reports and mouse reports. Those belong to the tile that produced them; repeating one
 *   would answer a query another program never asked, or click into another screen. The manager
 *   marks each keyboard, paste and IME event as it happens and lets exactly one data chunk claim
 *   the mark ({@linkcode InputOrigin}); a chunk with no mark is never repeated. Chunks that look
 *   like a report are also refused whatever their mark ({@linkcode isTerminalReport}).
 * - A big paste (several lines, or long) is held until the user confirms it for every tile.
 * - The mode is never saved: a new window always starts with it off.
 *
 * @module
 */

/** Where a chunk of terminal input came from: a key (or IME composition), a paste, or neither. */
export type InputOrigin = "key" | "paste" | null;

/** The broadcast selection. `on` with no members broadcasts nothing (each tile gets its own keys). */
export interface BroadcastState {
  on: boolean;
  /** The selected tiles, in the order they were checked. */
  members: readonly string[];
}

export const BROADCAST_OFF: BroadcastState = { on: false, members: [] };

/** Turn the mode on (nothing selected yet) or off (the selection is dropped). */
export function toggleBroadcast(state: BroadcastState): BroadcastState {
  return state.on ? BROADCAST_OFF : { on: true, members: [] };
}

/** Check or uncheck tile `id` (only while the mode is on). */
export function setMember(
  state: BroadcastState,
  id: string,
  member: boolean,
): BroadcastState {
  if (!state.on) return state;
  const has = state.members.includes(id);
  if (has === member) return state;
  return {
    on: true,
    members: member
      ? [...state.members, id]
      : state.members.filter((m) => m !== id),
  };
}

/** Drop the members that are no longer open. */
export function pruneMembers(
  state: BroadcastState,
  open: readonly string[],
): BroadcastState {
  const kept = state.members.filter((m) => open.includes(m));
  return kept.length === state.members.length
    ? state
    : { on: state.on, members: kept };
}

/** The members input is repeated to (`null` when the mode is off or fewer than two are checked). */
export function activeMembers(
  state: BroadcastState,
): ReadonlySet<string> | null {
  return state.on && state.members.length >= 2 ? new Set(state.members) : null;
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

const REPORTS: RegExp[] = [
  // Mouse: SGR (`CSI < b ; x ; y M/m`), urxvt (`CSI b ; x ; y M`) and X10 (`CSI M` + 3 bytes).
  /^\x1b\[<\d+;\d+;\d+[Mm]/,
  /^\x1b\[\d+;\d+;\d+M/,
  /^\x1b\[M[\s\S]{3}/,
  // Focus in / out.
  /^\x1b\[[IO]$/,
  // Device attributes (`CSI ? … c`, `CSI > … c`, `CSI = … c`) and DECRQM / mode reports (`$y`).
  /^\x1b\[[?>=][\d;]*c$/,
  /^\x1b\[\??[\d;]*\$y$/,
  // DSR "ok" (`CSI 0 n`) and the extended cursor position report (`CSI ? r ; c R`).
  /^\x1b\[0n$/,
  /^\x1b\[\?\d+;\d+(?:;\d+)?R$/,
  // Window reports (`CSI 4 ; h ; w t`, `CSI 8 ; … t`), and OSC / DCS / APC / PM string replies,
  // which end in BEL or ST (Alt+] alone is `ESC ]`: a key, not a reply).
  /^\x1b\[\d+;\d+;\d+t$/,
  /^\x1b[\]P_^][\s\S]+(?:\x07|\x1b\\)$/,
];

/**
 * Whether a chunk xterm sent is one of its own reports (mouse, focus, a reply to a query) rather
 * than something typed. The plain cursor position report (`CSI r ; c R`) is not here: it is also
 * what Shift+F3 sends, and it is kept from being repeated by its missing mark instead.
 */
export function isTerminalReport(data: string): boolean {
  return REPORTS.some((re) => re.test(data));
}

/**
 * The other tiles a chunk typed in `source` goes to: every member but the source, when the
 * source is a member, the chunk is the user's (`origin`) and is not a report. Members that cannot
 * take input (`alive` false: exited, not started) are left out.
 */
export function broadcastTargets(
  source: string,
  data: string,
  origin: InputOrigin,
  members: ReadonlySet<string> | null,
  alive: (id: string) => boolean,
): string[] {
  if (!members || !members.has(source) || origin === null) return [];
  if (data === "" || isTerminalReport(data)) return [];
  return [...members].filter((id) => id !== source && alive(id));
}

// ---------------------------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------------------------

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** A paste's text without bracketed-paste markers (xterm adds them in that mode). */
export function unbracketPaste(data: string): string {
  return data.startsWith(PASTE_START) && data.endsWith(PASTE_END)
    ? data.slice(PASTE_START.length, data.length - PASTE_END.length)
    : data;
}

/**
 * A paste as one tile should receive it: wrapped in bracketed-paste markers when that tile's
 * program asked for them (each tile's program may differ from the source's).
 */
export function pasteFor(data: string, bracketed: boolean): string {
  const text = unbracketPaste(data);
  return bracketed ? `${PASTE_START}${text}${PASTE_END}` : text;
}

/** A paste longer than this is confirmed before it goes to every tile. */
const BIG_PASTE_CHARS = 256;

/** Whether a paste must be confirmed before it is broadcast: it has a line break, or is long. */
export function pasteNeedsConfirm(data: string): boolean {
  const text = unbracketPaste(data);
  return /[\r\n]/.test(text) || text.length > BIG_PASTE_CHARS;
}

/** `12 lines, 1,480 characters` for the confirmation. */
export function pasteSummary(data: string): string {
  const text = unbracketPaste(data).replace(/\r\n?/g, "\n");
  // A final line break ends the last line; it does not start another.
  const lines = text.replace(/\n$/, "").split("\n").length;
  const chars = text.length.toLocaleString("en-US");
  return `${lines} line${lines === 1 ? "" : "s"}, ${chars} character${
    text.length === 1 ? "" : "s"
  }`;
}

/** The banner's text: `Broadcasting to 4 tiles`, or what to do while too few are checked. */
export function broadcastLabel(state: BroadcastState): string {
  const n = state.members.length;
  if (n === 0) return "Broadcast: check the tiles to type into";
  if (n === 1) return "Broadcast: check at least one more tile";
  return `Broadcasting to ${n} tiles`;
}
