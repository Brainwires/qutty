// lib/terminal-links.ts against a fake xterm.js terminal (a buffer of plain rows, the link
// provider list, `options`): the OSC 8 handler and its wrapped provider (decorations follow the
// modifier, activation needs it, only the URL schemes Qutty opens), and the text provider (local
// paths only when they exist, remote paths in an SSH tile, wrapped rows, the existence cache),
// and the modifier-click / modifier-press after xterm forgot the link under a still pointer.

import { assertEquals } from "@std/assert";
import {
  type LinkHit,
  linkModifier,
  TerminalLinks,
  type TerminalLinksHost,
} from "../lib/terminal-links.ts";
import type { ILink, ILinkProvider, Terminal } from "../lib/xterm.ts";
import type { LinkTarget } from "../lib/links.ts";

type Handler = {
  activate(e: MouseEvent, uri: string): void;
  allowNonHttpProtocols?: boolean;
};

/** A terminal whose rows are `rows` (a row starting with `\t` is wrapped onto the one before). */
function fakeTerm(rows: string[], oscLinks: ILink[] = []) {
  const providers: ILinkProvider[] = [{
    provideLinks: (_y, cb) => cb(oscLinks.length ? oscLinks : undefined),
  }];
  const lines = rows.map((r) => ({
    isWrapped: r.startsWith("\t"),
    text: r.replace(/^\t/, ""),
  }));
  const term = {
    options: {} as { linkHandler?: Handler },
    registerLinkProvider(p: ILinkProvider) {
      providers.push(p);
      return { dispose: () => providers.splice(providers.indexOf(p), 1) };
    },
    buffer: {
      active: {
        length: lines.length,
        getLine: (y: number) => {
          const l = lines[y];
          return l && {
            isWrapped: l.isWrapped,
            length: l.text.length,
            getCell: (x: number) => ({
              getChars: () => l.text[x],
              getWidth: () => 1,
            }),
          };
        },
      },
    },
    _core: {
      _linkProviderService: { linkProviders: providers },
      linkifier: undefined as
        | { _lastBufferCell?: unknown; _handleMouseMove(e: MouseEvent): void }
        | undefined,
    },
  };
  return { term: term as unknown as Terminal, raw: term, providers };
}

const mouse = (meta: boolean) =>
  ({ metaKey: meta, ctrlKey: false, clientX: 1, clientY: 2 }) as MouseEvent;

function host(over: Partial<TerminalLinksHost> = {}) {
  const opened: LinkHit[] = [];
  const asked: string[][] = [];
  const fs: Record<string, LinkTarget> = {
    "notes.md": { path: "/Users/me/notes.md", kind: "file" },
    "src/a.ts": { path: "/p/src/a.ts", kind: "file" },
    "~/Source": { path: "/Users/me/Source", kind: "dir" },
  };
  const h: TerminalLinksHost = {
    platform: "mac",
    context: () => ({ remote: false, cwd: () => Promise.resolve("/p") }),
    resolve: (_cwd, paths) => {
      asked.push(paths);
      return Promise.resolve(paths.map((p) => fs[p] ?? null));
    },
    activate: (hit) => opened.push(hit),
    menu: () => {},
    ...over,
  };
  return { h, opened, asked };
}

const provide = (p: ILinkProvider, y: number) =>
  new Promise<ILink[] | undefined>((resolve) => p.provideLinks(y, resolve));

Deno.test("linkModifier: ⌘ on macOS, Ctrl elsewhere", () => {
  assertEquals(linkModifier({ metaKey: true, ctrlKey: false }, "mac"), true);
  assertEquals(linkModifier({ metaKey: false, ctrlKey: true }, "mac"), false);
  assertEquals(linkModifier({ metaKey: false, ctrlKey: true }, "other"), true);
  assertEquals(linkModifier({ metaKey: true, ctrlKey: false }, "other"), false);
});

Deno.test("OSC 8: the handler needs the modifier and an openable scheme", () => {
  const { term, raw } = fakeTerm([""]);
  const { h, opened } = host();
  const links = new TerminalLinks(term, h);
  const handler = raw.options.linkHandler!;
  assertEquals(handler.allowNonHttpProtocols, true);
  handler.activate(mouse(false), "https://a.example/");
  handler.activate(mouse(true), "javascript:alert(1)");
  handler.activate(mouse(true), "vscode://file/x");
  handler.activate(mouse(true), "https://a.example/");
  handler.activate(mouse(true), "file:///Users/me/notes.md");
  assertEquals(opened, [
    { kind: "url", url: "https://a.example/", osc8: true },
    { kind: "url", url: "file:///Users/me/notes.md", osc8: true },
  ]);
  links.dispose();
});

Deno.test("OSC 8: the wrapped provider's links follow the modifier and are tracked", async () => {
  const activated: string[] = [];
  const osc: ILink = {
    range: { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } },
    text: "https://osc.example/",
    activate: (_e, t) => activated.push(t),
  };
  const { term, providers } = fakeTerm(["hello"], [osc]);
  const { h } = host();
  const links = new TerminalLinks(term, h);
  const [wrapped] = (await provide(providers[0], 1))!;
  assertEquals(wrapped.text, "https://osc.example/");
  assertEquals(wrapped.decorations, { underline: false, pointerCursor: false });
  wrapped.hover!(mouse(false), wrapped.text);
  assertEquals(links.state(), {
    hovered: "https://osc.example/",
    underline: false,
    pointer: false,
  });
  // The modifier, observed on the window, shows it as a link; letting go hides it again.
  const key = (type: string, meta: boolean) => {
    const e = new Event(type);
    Object.defineProperty(e, "metaKey", { value: meta });
    Object.defineProperty(e, "ctrlKey", { value: false });
    globalThis.dispatchEvent(e);
  };
  key("keydown", true);
  assertEquals(links.state().underline, true);
  assertEquals(links.state().pointer, true);
  key("keyup", false);
  assertEquals(links.state().underline, false);
  wrapped.activate(mouse(true), wrapped.text);
  assertEquals(activated, ["https://osc.example/"]);
  wrapped.leave!(mouse(false), wrapped.text);
  assertEquals(links.state().hovered, null);
  links.dispose();
});

Deno.test("text links: URLs, existing local paths only, ranges in cells", async () => {
  const { term, providers } = fakeTerm([
    "see https://deno.com/. and notes.md, src/a.ts:3:4 missing.ts 1.2.3",
  ]);
  const { h, opened, asked } = host();
  const links = new TerminalLinks(term, h);
  const found = (await provide(providers[1], 1))!;
  assertEquals(found.map((l) => [l.text, l.range.start.x, l.range.end.x]), [
    ["https://deno.com/", 5, 21],
    ["notes.md", 28, 35],
    ["src/a.ts:3:4", 38, 49],
  ]);
  assertEquals(asked, [["notes.md", "src/a.ts", "missing.ts"]]);
  // A plain click does nothing; the modifier-click hands over what it is.
  found[2].activate(mouse(false), found[2].text);
  found[2].activate(mouse(true), found[2].text);
  found[0].activate(mouse(true), found[0].text);
  assertEquals(opened, [
    { kind: "local", path: "/p/src/a.ts", isDir: false, line: 3, col: 4 },
    { kind: "url", url: "https://deno.com/", osc8: false },
  ]);
  // Asked again soon: the existence answers are cached.
  await provide(providers[1], 1);
  assertEquals(asked.length, 1);
  links.dispose();
});

Deno.test("text links: a path wrapped over two rows is one link", async () => {
  const { term, providers } = fakeTerm(["ls ~/Sou", "\trce now"]);
  const { h } = host();
  const links = new TerminalLinks(term, h);
  const [link] = (await provide(providers[1], 2))!;
  assertEquals(link.text, "~/Source");
  assertEquals(link.range, { start: { x: 4, y: 1 }, end: { x: 3, y: 2 } });
  links.dispose();
});

Deno.test("text links: an SSH tile's paths are remote, resolved against OSC 7, unchecked", async () => {
  const { term, providers } = fakeTerm([
    "logs/app.log /var/log/x ~/y.txt https://a.example/",
  ]);
  const { h, opened, asked } = host({
    context: () => ({ remote: true, cwd: "/home/me/proj" }),
  });
  const links = new TerminalLinks(term, h);
  const found = (await provide(providers[1], 1))!;
  for (const l of found) l.activate(mouse(true), l.text);
  assertEquals(opened, [
    { kind: "remote", path: "/home/me/proj/logs/app.log" },
    { kind: "remote", path: "/var/log/x" },
    { kind: "remote", path: "~/y.txt" },
    { kind: "url", url: "https://a.example/", osc8: false },
  ]);
  assertEquals(asked, [], "no local existence check");
  links.dispose();
});

// ---------------------------------------------------------------------------------------------
// After xterm forgot the link under a still pointer (a resize: e.g. a tile growing into place)
// ---------------------------------------------------------------------------------------------

/** A fake attached terminal: 30×3 cells of 10×10 px at the viewport's origin. */
function attached(rows: string[], oscLinks: ILink[] = []) {
  const fake = fakeTerm(rows, oscLinks);
  const element = new EventTarget() as EventTarget & {
    querySelector(sel: string): unknown;
  };
  element.querySelector = (sel) =>
    sel === ".xterm-screen"
      ? {
        getBoundingClientRect: () => ({
          left: 0,
          top: 0,
          width: 300,
          height: 30,
        }),
      }
      : null;
  Object.assign(fake.raw, { cols: 30, rows: 3, element });
  Object.assign(fake.raw.buffer.active, { viewportY: 0 });
  const { h, opened } = host();
  const links = new TerminalLinks(fake.term, h);
  links.attach(element as unknown as HTMLElement);
  return { ...fake, element, links, opened, h };
}

/** A mouse event at the middle of cell (`x`, `y`), 1-based. */
function at(type: string, x: number, y: number, meta: boolean): MouseEvent {
  const e = new Event(type);
  for (
    const [k, v] of Object.entries({
      clientX: (x - 1) * 10 + 5,
      clientY: (y - 1) * 10 + 5,
      button: 0,
      metaKey: meta,
      ctrlKey: false,
    })
  ) Object.defineProperty(e, k, { value: v });
  return e as MouseEvent;
}

function key(type: string, meta: boolean): void {
  const e = new Event(type);
  Object.defineProperty(e, "metaKey", { value: meta });
  Object.defineProperty(e, "ctrlKey", { value: false });
  globalThis.dispatchEvent(e);
}

const settle = () => new Promise((r) => setTimeout(r, 0));

Deno.test("modifier-click with no link from xterm: opens the link under the pointer", async () => {
  const { element, links, opened } = attached(["see https://deno.com/ now"]);
  element.dispatchEvent(at("mousedown", 8, 1, true));
  element.dispatchEvent(at("mouseup", 8, 1, true));
  await settle();
  assertEquals(opened, [{
    kind: "url",
    url: "https://deno.com/",
    osc8: false,
  }]);
  // Not over a link, released on another cell, or a plain click: nothing.
  for (
    const [down, up] of [
      [at("mousedown", 2, 1, true), at("mouseup", 2, 1, true)],
      [at("mousedown", 8, 1, true), at("mouseup", 9, 2, true)],
      [at("mousedown", 8, 1, false), at("mouseup", 8, 1, false)],
    ]
  ) {
    element.dispatchEvent(down);
    element.dispatchEvent(up);
  }
  await settle();
  assertEquals(opened.length, 1);
  links.dispose();
});

Deno.test("modifier-click with no link from xterm: OSC 8 first, and never twice", async () => {
  const osc: ILink = {
    range: { start: { x: 1, y: 1 }, end: { x: 3, y: 1 } },
    text: "https://osc.example/",
    activate: (e, t) => handler().activate(e, t),
  };
  const { element, links, opened, raw } = attached(["abc https://deno.com/"], [
    osc,
  ]);
  const handler = () => raw.options.linkHandler!;
  element.dispatchEvent(at("mousedown", 2, 1, true));
  element.dispatchEvent(at("mouseup", 2, 1, true));
  await settle();
  assertEquals(opened, [{
    kind: "url",
    url: "https://osc.example/",
    osc8: true,
  }]);
  // xterm found the link after all and opened it on this mouseup: not again.
  element.dispatchEvent(at("mousedown", 8, 1, true));
  const up = at("mouseup", 8, 1, true);
  handler().activate(up, "https://xterm.example/");
  element.dispatchEvent(up);
  await settle();
  assertEquals(opened.map((o) => o.kind === "url" && o.url), [
    "https://osc.example/",
    "https://xterm.example/",
  ]);
  links.dispose();
});

Deno.test("modifier-click on the link xterm has: left to xterm", async () => {
  const { element, links, opened, providers } = attached([
    "see https://deno.com/ now",
  ]);
  const [link] = (await provide(providers[1], 1))!;
  link.hover!(at("mousemove", 8, 1, false), link.text);
  element.dispatchEvent(at("mousedown", 8, 1, true));
  element.dispatchEvent(at("mouseup", 8, 1, true));
  await settle();
  assertEquals(opened, []);
  links.dispose();
});

Deno.test("modifier press with a still pointer and no link: xterm looks again", () => {
  const { element, links, raw } = attached(["see https://deno.com/ now"]);
  const moves: MouseEvent[] = [];
  const linkifier = {
    _lastBufferCell: { x: 8, y: 1 } as unknown,
    _handleMouseMove: (e: MouseEvent) => moves.push(e),
  };
  raw._core.linkifier = linkifier;
  const move = at("mousemove", 8, 1, false);
  element.dispatchEvent(move);
  key("keydown", true);
  key("keyup", false);
  assertEquals(moves, [move]);
  assertEquals(linkifier._lastBufferCell, undefined);
  // Pointer gone: nothing to look at.
  element.dispatchEvent(new Event("mouseleave"));
  key("keydown", true);
  key("keyup", false);
  assertEquals(moves.length, 1);
  links.dispose();
});
