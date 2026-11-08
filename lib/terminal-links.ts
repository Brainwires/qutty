// Clickable links in one xterm.js terminal: ⌘-click (Ctrl-click elsewhere) opens what is under
// the pointer, which is underlined (with a pointer cursor) only while that modifier is held. A
// plain click is the terminal's own (selection, mouse reporting); right-click on a link asks for
// its menu (Copy / Open / Reveal, or Download in an SSH tile).
//
// Three sources, in xterm's provider order (the first that has a link under the pointer wins):
//
// 1. OSC 8 hyperlinks (`ls --hyperlink`, gcc, delta, Claude Code): xterm.js finds them itself and
//    calls `linkHandler`. Its OSC 8 provider gives every link an underline on hover; it is wrapped
//    (through xterm's internal link-provider list, guarded: without it OSC 8 links still work,
//    underlined on any hover) so they follow the modifier like the others.
// 2. URLs in plain output, 3. paths (lib/links.ts finds both). A local path is linked only if it
//    exists: the provider asks the backend (desktop/links.ts) on hover, resolved against the
//    tile's directory, and keeps the answer for a few seconds. In an SSH tile a path is remote:
//    it is linked without a check, resolved against the OSC 7 directory, and offers Download.
//
// No key is taken: the modifier is only observed (a passive keydown/keyup listener).
//
// xterm.js forgets the link under the pointer when the terminal resizes (a tile growing into
// place, a window resize), and finds it again only when the pointer moves to another cell. So
// pressing the modifier with the pointer still asks xterm to look again (internal, guarded), and a
// modifier-click that xterm has no link for finds the link under the pointer itself and opens it.

import type { ILink, ILinkProvider, Terminal } from "./xterm.ts";
import {
  findLinks,
  isOpenableUrl,
  type LinkMatch,
  type LinkTarget,
} from "./links.ts";

/** What a link opens. */
export type LinkHit =
  /** A URL (`osc8`: from an OSC 8 hyperlink; a `file:` one may name a local or remote path). */
  | { kind: "url"; url: string; osc8: boolean }
  /** A local path that exists. */
  | {
    kind: "local";
    path: string;
    isDir: boolean;
    line?: number;
    col?: number;
  }
  /** A path in an SSH tile's output, on the remote machine (`~/…` or absolute). */
  | { kind: "remote"; path: string; line?: number; col?: number };

/** What the e2e suite reads: the hovered link's text and whether it shows as one. */
export interface LinkHoverState {
  hovered: string | null;
  underline: boolean;
  pointer: boolean;
}

/** Where a terminal's paths point. */
export type LinkContext =
  /** A local tile: its current directory (the foreground process's, or OSC 7). */
  | { remote: false; cwd(): Promise<string | undefined> }
  /** An SSH tile: the remote directory from OSC 7, if known. */
  | { remote: true; cwd: string | undefined };

/** What a terminal's links need from the manager and the workspace. */
export interface TerminalLinksHost {
  platform: "mac" | "other";
  context(): LinkContext;
  /** Which paths exist (desktop/links.ts `resolve`). */
  resolve(
    cwd: string | undefined,
    paths: string[],
  ): Promise<(LinkTarget | null)[]>;
  /** The modifier-click. */
  activate(hit: LinkHit, event: MouseEvent): void;
  /** A right-click on a link. */
  menu(hit: LinkHit, event: MouseEvent): void;
}

/** How long an existence check is trusted. */
const RESOLVE_TTL_MS = 3000;
/** Logical lines longer than this (a minified bundle printed whole) are not scanned. */
const MAX_LINE = 4000;

// ---------------------------------------------------------------------------------------------
// The modifier, watched once per page
// ---------------------------------------------------------------------------------------------

const modifier = {
  held: false,
  platform: "mac" as "mac" | "other",
  installed: false,
  subs: new Set<() => void>(),
};

/** Whether the link modifier is held in `e` (⌘ on macOS, Ctrl elsewhere). */
export function linkModifier(
  e: { metaKey: boolean; ctrlKey: boolean },
  platform: "mac" | "other",
): boolean {
  return platform === "mac" ? e.metaKey : e.ctrlKey;
}

function setHeld(held: boolean): void {
  if (modifier.held === held) return;
  modifier.held = held;
  for (const cb of [...modifier.subs]) cb();
}

function watchModifier(platform: "mac" | "other"): void {
  modifier.platform = platform;
  if (modifier.installed || !globalThis.addEventListener) return;
  modifier.installed = true;
  const fromEvent = (e: KeyboardEvent | MouseEvent) =>
    setHeld(linkModifier(e, modifier.platform));
  // Observed only: never prevented or stopped, so the key still reaches whatever has focus.
  const opts = { capture: true, passive: true };
  globalThis.addEventListener("keydown", fromEvent, opts);
  globalThis.addEventListener("keyup", fromEvent, opts);
  globalThis.addEventListener("mousemove", fromEvent, opts);
  globalThis.addEventListener("blur", () => setHeld(false));
}

// ---------------------------------------------------------------------------------------------
// One terminal
// ---------------------------------------------------------------------------------------------

/** A logical line (a row and the rows wrapped onto it) and the cell of each string offset. */
interface LogicalLine {
  text: string;
  /** For each UTF-16 offset: its cell, 1-based x and buffer y. */
  cells: { x: number; y: number }[];
}

function readLogicalLine(term: Terminal, y: number): LogicalLine | undefined {
  const buf = term.buffer.active;
  let start = y;
  while (start > 0 && buf.getLine(start)?.isWrapped) start--;
  let text = "";
  const cells: { x: number; y: number }[] = [];
  for (let row = start; row < buf.length; row++) {
    const line = buf.getLine(row);
    if (!line || (row > start && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      for (let i = 0; i < chars.length; i++) {
        cells.push({ x: x + 1, y: row + 1 });
      }
      text += chars;
    }
    if (text.length > MAX_LINE) return undefined;
  }
  return { text, cells };
}

/** A remote path resolved against the SSH tile's directory (`~/…` and absolute stay as they are). */
function remotePath(path: string, cwd: string | undefined): string | undefined {
  if (path.startsWith("/") || path === "~" || path.startsWith("~/")) {
    return path;
  }
  if (!cwd?.startsWith("/")) return undefined;
  const parts = `${cwd}/${path}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return `/${out.join("/")}`;
}

type Hover = { link: ILink; hit: LinkHit };

/** A buffer cell: 1-based x, 1-based buffer y (xterm's link coordinates). */
type Cell = { x: number; y: number };

/** Whether `link` covers `cell` (xterm's own test). */
function covers(link: ILink, cell: Cell, cols: number): boolean {
  const at = (p: Cell) => p.y * cols + p.x;
  const here = at(cell);
  return at(link.range.start) <= here && here <= at(link.range.end);
}

/** The parts of xterm's Linkifier that `#rehover` uses (internal, so all optional). */
interface XtermLinkifier {
  _lastBufferCell?: unknown;
  _handleMouseMove?: (e: MouseEvent) => void;
}

/** xterm.js internals this file reaches into, every step guarded. */
type XtermCore = {
  _core?: {
    _linkProviderService?: { linkProviders?: ILinkProvider[] };
    linkifier?: XtermLinkifier;
  };
};

/** The links of one terminal; created with it, `attach`ed once it is opened into the DOM. */
export class TerminalLinks {
  #term: Terminal;
  #host: TerminalLinksHost;
  #current: Hover | null = null;
  #cache = new Map<string, { at: number; value: LinkTarget | null }>();
  #disposers: (() => void)[] = [];
  #provider: ILinkProvider;
  /** The last pointer move over this terminal (null once it leaves). */
  #pointer: MouseEvent | null = null;
  /** A modifier-click xterm had no link for: where it went down and the link found there. */
  #pending: { cell: Cell; link: Promise<ILink | undefined> } | null = null;
  /** The last event a link was activated with (so a click opens at most once). */
  #activated: Event | null = null;

  constructor(term: Terminal, host: TerminalLinksHost) {
    this.#term = term;
    this.#host = host;
    watchModifier(host.platform);
    term.options.linkHandler = {
      allowNonHttpProtocols: true,
      activate: (event, uri) => {
        this.#activated = event;
        if (!this.#held(event) || !isOpenableUrl(uri)) return;
        host.activate({ kind: "url", url: uri, osc8: true }, event);
      },
    };
    this.#wrapOsc8();
    this.#provider = {
      provideLinks: (y, cb) => {
        this.#provide(y).then(cb, () => cb(undefined));
      },
    };
    const provider = term.registerLinkProvider(this.#provider);
    this.#disposers.push(() => provider.dispose());
    const onModifier = () => {
      this.#sync();
      if (modifier.held && !this.#current) this.#rehover();
    };
    modifier.subs.add(onModifier);
    this.#disposers.push(() => modifier.subs.delete(onModifier));
  }

  /**
   * Listen for right-clicks on links, and for modifier-clicks xterm has no link for (once the
   * terminal has its element).
   */
  attach(element: HTMLElement): void {
    const onMenu = (e: MouseEvent) => {
      const cur = this.#current;
      if (!cur) return;
      e.preventDefault();
      e.stopPropagation();
      this.#host.menu(cur.hit, e);
    };
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      capture = false,
    ) => {
      element.addEventListener(type, fn, capture);
      this.#disposers.push(() =>
        element.removeEventListener(type, fn, capture)
      );
    };
    listen("contextmenu", onMenu, true);
    listen("mousemove", (e) => this.#pointer = e);
    listen("mouseleave", () => this.#pointer = null);
    // Capture: before xterm's own mousedown, while its current link is the one under the pointer.
    listen("mousedown", (e) => this.#modifierDown(e), true);
    // Bubble, on the terminal's root: after xterm's mouseup (on its screen) had its chance.
    listen("mouseup", (e) => this.#modifierUp(e));
  }

  /** What the pointer is over (for the e2e suite). */
  state(): LinkHoverState {
    const cur = this.#current;
    return {
      hovered: cur?.link.text ?? null,
      underline: !!cur?.link.decorations?.underline,
      pointer: !!cur?.link.decorations?.pointerCursor,
    };
  }

  dispose(): void {
    for (const d of this.#disposers.splice(0)) d();
    this.#current = null;
  }

  #held(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
    return linkModifier(e, this.#host.platform);
  }

  /** A modifier-press with the pointer still: have xterm look for the link under it again. */
  #rehover(): void {
    const e = this.#pointer;
    if (!e) return;
    try {
      const lk = (this.#term as unknown as XtermCore)._core?.linkifier;
      if (!lk || typeof lk._handleMouseMove !== "function") return;
      if (!("_lastBufferCell" in lk)) return;
      // xterm only looks again when the pointer enters another cell; make this one new.
      lk._lastBufferCell = undefined;
      lk._handleMouseMove(e);
    } catch {
      /* xterm's internals moved: the link shows again once the pointer moves */
    }
  }

  /** A modifier-mousedown on a cell xterm has no link for: look for one there ourselves. */
  #modifierDown(e: MouseEvent): void {
    this.#pending = null;
    if (e.button !== 0 || !this.#held(e)) return;
    const cell = this.#cellAt(e);
    if (!cell) return;
    const cur = this.#current?.link;
    if (cur && covers(cur, cell, this.#term.cols)) return;
    this.#pending = { cell, link: this.#linkAt(cell) };
  }

  /** The mouseup of such a click: open what was found, unless xterm opened something itself. */
  #modifierUp(e: MouseEvent): void {
    const p = this.#pending;
    this.#pending = null;
    if (!p || this.#activated === e) return;
    const cell = this.#cellAt(e);
    if (cell?.x !== p.cell.x || cell.y !== p.cell.y) return;
    p.link.then((link) => {
      if (link && this.#activated !== e) link.activate(e, link.text);
    });
  }

  /** The buffer cell under a mouse event, from the screen's size in cells. */
  #cellAt(e: MouseEvent): Cell | undefined {
    const term = this.#term;
    const screen = term.element?.querySelector(".xterm-screen");
    const r = screen?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return undefined;
    const col = Math.floor((e.clientX - r.left) / (r.width / term.cols));
    const row = Math.floor((e.clientY - r.top) / (r.height / term.rows));
    if (col < 0 || col >= term.cols || row < 0 || row >= term.rows) {
      return undefined;
    }
    return { x: col + 1, y: row + 1 + term.buffer.active.viewportY };
  }

  /** The link at `cell`, asking the providers in xterm's order (the first with one wins). */
  async #linkAt(cell: Cell): Promise<ILink | undefined> {
    const providers = this.#providers();
    for (const p of providers) {
      const links = await new Promise<ILink[] | undefined>((resolve) =>
        p.provideLinks(cell.y, resolve)
      );
      const link = links?.find((l) => covers(l, cell, this.#term.cols));
      if (link) return link;
    }
    return undefined;
  }

  /** xterm's link providers (OSC 8 first), or just ours if its internals moved. */
  #providers(): ILinkProvider[] {
    try {
      const list = (this.#term as unknown as XtermCore)._core
        ?._linkProviderService?.linkProviders;
      if (Array.isArray(list) && list.includes(this.#provider)) return list;
    } catch {
      /* fall through */
    }
    return [this.#provider];
  }

  /** Show the hovered link as a link exactly while the modifier is held. */
  #sync(): void {
    const d = this.#current?.link.decorations;
    if (!d) return;
    d.underline = modifier.held;
    d.pointerCursor = modifier.held;
  }

  /** A link xterm can show: underline and pointer follow the modifier; activation needs it. */
  #link(
    range: ILink["range"],
    text: string,
    hit: LinkHit,
    activate: (e: MouseEvent) => void,
    inner?: Pick<ILink, "hover" | "leave">,
  ): ILink {
    const link: ILink = {
      range,
      text,
      decorations: { underline: modifier.held, pointerCursor: modifier.held },
      activate: (e) => {
        this.#activated = e;
        activate(e);
      },
      hover: (e, t) => {
        this.#current = { link, hit };
        // xterm read the decorations when the pointer arrived; they may be stale.
        this.#sync();
        inner?.hover?.(e, t);
      },
      leave: (e, t) => {
        if (this.#current?.link === link) this.#current = null;
        inner?.leave?.(e, t);
      },
    };
    return link;
  }

  /**
   * xterm.js's own OSC 8 provider (the first one it registers) underlines on any hover; give its
   * links ours. Internal API, so every step is checked: without it nothing breaks.
   */
  #wrapOsc8(): void {
    try {
      const core = (this.#term as unknown as XtermCore)._core;
      const osc = core?._linkProviderService?.linkProviders?.[0];
      if (!osc || typeof osc.provideLinks !== "function") return;
      const provide = osc.provideLinks.bind(osc);
      osc.provideLinks = (y, cb) =>
        provide(y, (links) =>
          cb(
            links?.map((l) =>
              this.#link(
                l.range,
                l.text,
                { kind: "url", url: l.text, osc8: true },
                (e) => l.activate(e, l.text),
                l,
              )
            ),
          ));
    } catch {
      /* xterm's internals moved: OSC 8 links keep xterm's own hover */
    }
  }

  async #provide(y: number): Promise<ILink[] | undefined> {
    const logical = readLogicalLine(this.#term, y - 1);
    if (!logical || logical.text.trim() === "") return undefined;
    const matches = findLinks(logical.text);
    if (matches.length === 0) return undefined;
    const ctx = this.#host.context();
    const hits = ctx.remote
      ? matches.map((m) => this.#remoteHit(m, ctx.cwd))
      : await this.#localHits(matches, await ctx.cwd());
    const links: ILink[] = [];
    matches.forEach((m, i) => {
      const hit = hits[i];
      if (!hit) return;
      const start = logical.cells[m.start];
      const end = logical.cells[m.end - 1];
      if (!start || !end) return;
      links.push(this.#link(
        { start, end },
        logical.text.slice(m.start, m.end),
        hit,
        (e) => {
          if (this.#held(e)) this.#host.activate(hit, e);
        },
      ));
    });
    return links.length > 0 ? links : undefined;
  }

  #remoteHit(m: LinkMatch, cwd: string | undefined): LinkHit | null {
    if (m.kind === "url") return { kind: "url", url: m.text, osc8: false };
    const path = remotePath(m.path, cwd);
    return path ? { kind: "remote", path, ...lineCol(m) } : null;
  }

  async #localHits(
    matches: LinkMatch[],
    cwd: string | undefined,
  ): Promise<(LinkHit | null)[]> {
    const now = Date.now();
    const key = (p: string) => `${cwd ?? ""}\0${p}`;
    const misses = [
      ...new Set(
        matches.flatMap((m) => {
          if (m.kind !== "path") return [];
          const c = this.#cache.get(key(m.path));
          return c && now - c.at < RESOLVE_TTL_MS ? [] : [m.path];
        }),
      ),
    ];
    if (misses.length > 0) {
      const found = await this.#host.resolve(cwd, misses).catch(() =>
        misses.map(() => null)
      );
      if (this.#cache.size > 500) this.#cache.clear();
      misses.forEach((p, i) =>
        this.#cache.set(key(p), { at: now, value: found[i] ?? null })
      );
    }
    return matches.map((m) => {
      if (m.kind === "url") return { kind: "url", url: m.text, osc8: false };
      const target = this.#cache.get(key(m.path))?.value;
      return target
        ? {
          kind: "local",
          path: target.path,
          isDir: target.kind === "dir",
          ...lineCol(m),
        }
        : null;
    });
  }
}

function lineCol(m: LinkMatch): { line?: number; col?: number } {
  if (m.kind !== "path" || m.line === undefined) return {};
  return m.col === undefined ? { line: m.line } : { line: m.line, col: m.col };
}
