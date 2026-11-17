// The companion's web tools end to end. Against the demo backend the companion's tools are called
// as its brain would call them (`window.__e2eCompanionTool`, the demo hub's in-process call):
// open_web opens a web tile beside the focused one on a local page, web_navigate and web_go drive
// it through the page's control channel and answer once the frame has loaded, the iframe engine
// explains that it cannot read its (cross-origin) page, and the acting calls are in Settings →
// Companion activity. The page scripts the desktop app's native view runs (read_page, web_click,
// web_type, web_scroll; lib/web/page-script.ts) are run here in Chromium on a test page: the
// numbered elements, a click by number and by text that navigates, a typed and submitted form.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";
import { tileSel } from "./ssh_helpers.ts";
import {
  formatPageRead,
  type PageRequest,
  pageScript,
  parsePageAction,
  parsePageRead,
  REF_ATTR,
} from "../../lib/web/page-script.ts";
import { IFRAME_CANNOT_READ } from "../../lib/web/web-control.ts";

const PAGE_HEAD =
  '<!doctype html><meta charset="utf-8"><style>.tall{height:3000px}</style>';

/** The test site: a shop page with text, a list, links and a search form. */
async function serveShop() {
  const ac = new AbortController();
  let resolvePort: (port: number) => void;
  const port = new Promise<number>((r) => resolvePort = r);
  const html = (body: string) =>
    new Response(PAGE_HEAD + body, {
      headers: { "content-type": "text/html", "cache-control": "no-store" },
    });
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: ac.signal,
    onListen: (addr) => resolvePort(addr.port),
  }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/shop") {
      return html(
        `<title>Shop</title><h1>Shop</h1><p>Socks and <b>more</b>.</p>` +
          `<ul><li>wool</li><li>cotton</li></ul>` +
          `<div style="display:none">secret text</div>` +
          `<a href="/next">Next page</a>` +
          `<form action="/results"><label>Search <input name="q"></label>` +
          `<label><input type="checkbox" name="agree"> Agree</label>` +
          `<select name="size" aria-label="Size"><option>S</option>` +
          `<option selected>M</option></select>` +
          `<button>Go</button></form><div class="tall"></div>`,
      );
    }
    if (url.pathname === "/next") {
      return html(`<title>Next</title><h1>Next</h1><a href="/shop">back</a>`);
    }
    if (url.pathname === "/results") {
      return html(
        `<title>Results</title><p>You searched for ${
          (url.searchParams.get("q") ?? "").replace(/[<&]/g, "")
        } in ${url.searchParams.get("size")}</p>`,
      );
    }
    return new Response("not found", { status: 404 });
  });
  return {
    origin: `http://localhost:${await port}`,
    close: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

/** Call web tool `name` as the companion; its text and whether it failed. */
function tool(
  app: App,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  return app.eval(
    (n: string, a: Record<string, unknown>) =>
      (globalThis as unknown as {
        __e2eCompanionTool(
          n: string,
          a: Record<string, unknown>,
        ): Promise<{ text: string; isError: boolean }>;
      }).__e2eCompanionTool(n, a),
    name,
    args,
  );
}

/** A tool call that must succeed, its JSON. */
async function toolJson(
  app: App,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = await tool(app, name, args);
  assert(!r.isError, `${name}: ${r.text}`);
  return JSON.parse(r.text);
}

/** The `src` of the frame in the web tile with workspace id `id`. */
const frameSrc = (app: App, id: string) =>
  app.attr(`${tileSel(id)} [data-testid=web-frame]`, "src");

/** Run a page script in the test page (as the native view's `evaluate` would). */
function inPage(app: App, request: PageRequest): Promise<unknown> {
  return app.page.evaluate(pageScript(request));
}

suite("companion web tools", (test) => {
  test("the companion opens a web tile, navigates it, goes back; the iframe says it cannot read the page", async (app) => {
    const shop = await serveShop();
    try {
      const terminal = (await app.focusedId())!;
      const opened = await toolJson(app, "open_web", {
        url: `${shop.origin}/shop`,
      });
      assertEquals(opened.tile, "web-1");
      assertEquals(opened.name, "browser");
      assertEquals(opened.url, `${shop.origin}/shop`);
      // A new web tile, focused, beside the terminal.
      const web = await waitFor(
        () =>
          app.eval(() =>
            document.querySelector<HTMLElement>(
              "[data-testid=tile][data-web=true][data-focused=true]",
            )?.dataset.id ?? null
          ),
        5000,
        "the web tile",
      );
      assert(web !== terminal);
      assertEquals(await frameSrc(app, web), `${shop.origin}/shop`);

      const next = await toolJson(app, "web_navigate", {
        tile: "browser",
        url: `${shop.origin}/next`,
      });
      assertEquals(next.url, `${shop.origin}/next`);
      assertEquals(next.loaded, true);
      assertEquals(await frameSrc(app, web), `${shop.origin}/next`);

      const back = await toolJson(app, "web_go", {
        tile: "web-1",
        action: "back",
      });
      assertEquals(back.url, `${shop.origin}/shop`);
      assertEquals(await frameSrc(app, web), `${shop.origin}/shop`);

      // The demo's iframe cannot look inside a cross-origin page: a clear answer.
      const read = await tool(app, "read_page", { tile: "web-1" });
      assert(read.isError);
      assertEquals(read.text, IFRAME_CANNOT_READ);
      const pty = await app.eval(
        (id: string) =>
          (globalThis as unknown as {
            __e2e: { terminal(id: string): { ptyId: string | null } | null };
          }).__e2e.terminal(id)?.ptyId ?? "",
        terminal,
      );
      const notWeb = await tool(app, "web_click", { tile: pty, ref: 1 });
      assert(notWeb.isError);
      assertStringIncludes(notWeb.text, "is a terminal, not a web tile");
      // A public site is not shown by the iframe: the tile still opens, and the answer says why.
      const google = await toolJson(app, "open_web", { url: "deno web views" });
      assertEquals(google.tile, "web-2");
      assertStringIncludes(String(google.note), "shows only local pages");

      // The acting calls are in Settings → Companion → activity.
      await app.openSettings("companion");
      const rows = await waitFor(
        () =>
          app.eval(() =>
            [
              ...document.querySelectorAll(
                "[data-testid=companion-activity-row]",
              ),
            ].map((r) => r.textContent ?? "").join("\n") || null
          ),
        3000,
        "activity rows",
      );
      for (const name of ["open_web", "web_navigate", "web_go", "web_click"]) {
        assertStringIncludes(rows, name);
      }
    } finally {
      await shop.close();
    }
  });

  test("the page scripts in Chromium: read numbers the elements; a click and a submitted form navigate", async (app) => {
    const shop = await serveShop();
    try {
      await app.page.goto(`${shop.origin}/shop`, { waitUntil: "load" });
      const read = parsePageRead(
        await inPage(app, { op: "read", maxChars: 4000 }),
        4000,
      );
      assertEquals(read.title, "Shop");
      assertEquals(read.url, `${shop.origin}/shop`);
      assertStringIncludes(read.text, "# Shop");
      assertStringIncludes(read.text, "Socks and more.");
      assertStringIncludes(read.text, "- wool\n- cotton");
      assert(!read.text.includes("secret"), read.text);
      assertEquals(
        read.elements.map((e) => [e.ref, e.role, e.name]),
        [
          [1, "link", "Next page"],
          [2, "textbox", "Search"],
          [3, "checkbox", "Agree"],
          [4, "combobox", "Size"],
          [5, "button", "Go"],
        ],
      );
      assertEquals(read.elements[0].href, `${shop.origin}/next`);
      assertEquals(read.elements[2].checked, false);
      assertEquals(read.elements[3].value, "M");
      assertStringIncludes(read.text, "[#1 link: Next page]");
      assertEquals(
        await app.page.evaluate(
          `document.querySelectorAll("[${REF_ATTR}]").length`,
        ),
        5,
      );
      assertStringIncludes(formatPageRead(read), '#4 combobox "Size" = "M"');

      // Scroll: the page is tall.
      const down = parsePageAction(
        await inPage(app, { op: "scroll", to: "bottom" }),
      );
      assert((down.scroll?.y ?? 0) > 1000, JSON.stringify(down));
      // A field by number: checked, picked, typed and submitted (its form goes to /results).
      parsePageAction(
        await inPage(app, { op: "click", target: { ref: 3 } }),
      );
      assertEquals(
        await app.page.evaluate(
          `document.querySelector("[name=agree]").checked`,
        ),
        true,
      );
      parsePageAction(
        await inPage(app, {
          op: "type",
          target: { ref: 4 },
          text: "S",
          clear: false,
          submit: false,
        }),
      );
      const typed = parsePageAction(
        await inPage(app, {
          op: "type",
          target: { ref: 2 },
          text: "wool socks",
          clear: true,
          submit: true,
        }),
      );
      assertEquals(typed.value, "wool socks");
      assertEquals(typed.submitted, "form");
      await waitFor(
        async () =>
          String(await app.page.evaluate("document.body?.innerText ?? ''"))
            .includes("You searched for wool socks in S"),
        5000,
        "the results page",
      );

      // A click by visible text follows the link.
      await app.page.goto(`${shop.origin}/shop`, { waitUntil: "load" });
      const clicked = parsePageAction(
        await inPage(app, { op: "click", target: { text: "next PAGE" } }),
      );
      assertEquals(clicked.element?.name, "Next page");
      await waitFor(
        async () =>
          String(await app.page.evaluate("location.pathname")) === "/next",
        5000,
        "the next page",
      );
      // A stale number is explained.
      const stale = await inPage(app, { op: "click", target: { ref: 9 } });
      assertStringIncludes(
        JSON.stringify(stale),
        "numbers come from the last read_page",
      );
    } finally {
      await shop.close();
    }
  });
});
