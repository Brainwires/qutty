// `QUTTY_PTY_SELFTEST=webview`: a check of the native web view in the packaged app, without the
// UI's web tiles (desktop.ts runs it once the app is up). In the main window it opens a hidden web
// view on https://example.com (`win.createWebView`, the call behind the page's `createWebView`
// that lib/web/native-engine.ts uses, with the same partition and policies), waits for the page
// to load, reads its title through `state()` and through `evaluate()`, types into a field of the
// page with dictation's script, reads the page and types into a field with the companion's web
// tools' scripts (lib/web/page-script.ts: `read_page`'s numbered elements, `web_type`), and tries a
// snapshot (`capture()`, what a web tile shows while a
// menu is over it). The view is given every key a web tile forwards (`forwardAccelerators`), so a
// spelling the runtime refuses fails here.
//
// It logs `webview self-test: OK <title>` and the app exits (1 on failure). It needs the network.
// Run it under a temporary HOME, so the user's app folder and saved windows are untouched:
//
//   HOME=$(mktemp -d) QUTTY_PTY_SELFTEST=webview Qutty.app/Contents/MacOS/laufey_webview

import type { DesktopRuntime } from "denext/desktop";
import { insertTextScript, WEB_PARTITION } from "../lib/web/native-engine.ts";
import { forwardAccelerators } from "../lib/workspace/keys.ts";
import {
  pageScript,
  parsePageAction,
  parsePageRead,
} from "../lib/web/page-script.ts";

const TIMEOUT_MS = 45_000;
const PAGE = "https://example.com/";

/** `p`, or a failure naming `what` after {@linkcode TIMEOUT_MS}. */
function within<T>(what: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no ${what} in ${TIMEOUT_MS} ms`)),
      TIMEOUT_MS,
    );
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export async function webviewSelfTest(app: DesktopRuntime): Promise<void> {
  const log = (m: string) => console.error(`webview self-test: ${m}`);
  const deadline = Date.now() + TIMEOUT_MS;
  let win = app.windows.get("main");
  while (!win) {
    if (Date.now() > deadline) throw new Error("no main window");
    await new Promise((r) => setTimeout(r, 100));
    win = app.windows.get("main");
  }
  log("main window is up");
  // The engine's keyboard features the native engine follows (lib/web/native-engine.ts).
  const caps = await (Deno as unknown as {
    desktop?: { webViewCapabilities?(): Promise<Record<string, unknown>> };
  }).desktop?.webViewCapabilities?.();
  log(
    `capabilities: ${
      ["blur", "keyUp", "forwardKeysBeforeMenu"].map((k) =>
        `${k}=${caps?.[k] === true}`
      ).join(" ")
    }`,
  );
  // Every key a web tile may forward: all three talk-key choices on top of the shortcuts.
  const platform = Deno.build.os === "darwin" ? "mac" : "other";
  const keys = [
    ...new Set([
      ...forwardAccelerators(
        { pttKey: "Mod+Shift+M", dictateKey: "Mod+Shift+K" },
        platform,
      ),
      ...forwardAccelerators(
        { pttKey: "Mod+Shift+Space", dictateKey: "off" },
        platform,
      ),
    ]),
  ];
  const view = await within(
    "web view",
    win.createWebView({
      url: PAGE,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: false,
      partition: WEB_PARTITION,
      allowPopups: "deny",
      downloads: "ask",
      permissions: "deny",
      forwardKeys: keys,
    }),
  );
  log(`created view ${view.id} on ${PAGE} with ${keys.length} forward keys`);
  await within("setForwardKeys", view.setForwardKeys(keys));
  const loaded = new Promise<void>((resolve, reject) => {
    view.on("load", (e) => {
      log(`load: ${e.state} ${e.url}`);
      if (e.state === "complete") resolve();
      if (e.state === "failed") {
        reject(new Error(`the page failed: ${e.error?.message ?? "?"}`));
      }
    });
  });
  loaded.catch(() => {});
  // The load may have finished before the listener was added.
  const first = await view.state();
  if (first.load !== "complete" || !first.title) await within("load", loaded);
  const state = await view.state();
  log(`state: ${JSON.stringify(state)}`);
  const title = await within(
    "evaluate",
    view.evaluate<string>("document.title"),
  );
  if (!state.title || title !== state.title) {
    throw new Error(
      `titles differ: state ${JSON.stringify(state.title)}, evaluate ${
        JSON.stringify(title)
      }`,
    );
  }
  // The companion's read_page: the page's text and its numbered elements.
  const read = parsePageRead(
    await within(
      "read_page",
      view.evaluate(pageScript({ op: "read", maxChars: 4000 })),
    ),
    4000,
  );
  log(
    `read_page: ${read.elements.length} elements, ${read.text.length} chars; ${
      JSON.stringify(read.elements.slice(0, 3))
    }`,
  );
  if (read.elements.length === 0 || read.text.trim() === "") {
    throw new Error(`read_page: ${JSON.stringify(read).slice(0, 400)}`);
  }
  // Dictation: nothing editable has the focus, then a focused field takes the text.
  const idle = await within(
    "insertText",
    view.evaluate<boolean>(insertTextScript("nobody")),
  );
  await view.evaluate(
    `(() => { const i = document.createElement("input"); i.id = "qutty-selftest"; ` +
      `document.body.append(i); i.focus(); })()`,
  );
  const typed = await view.evaluate<boolean>(
    insertTextScript("typed by Qutty"),
  );
  const value = await view.evaluate<string>(
    `document.getElementById("qutty-selftest").value`,
  );
  if (idle !== false || typed !== true || value !== "typed by Qutty") {
    throw new Error(
      `dictation: idle ${idle}, typed ${typed}, value ${JSON.stringify(value)}`,
    );
  }
  log(`insertText: ${JSON.stringify(value)}`);
  // The companion's web_type: the field emptied, then typed into.
  const typedByTool = parsePageAction(
    await within(
      "web_type",
      view.evaluate(pageScript({
        op: "type",
        target: { selector: "#qutty-selftest" },
        text: "typed by web_type",
        clear: true,
        submit: false,
      })),
    ),
  );
  if (typedByTool.value !== "typed by web_type") {
    throw new Error(`web_type: ${JSON.stringify(typedByTool)}`);
  }
  log(`web_type: ${JSON.stringify(typedByTool.value)}`);
  // What a web tile shows while a menu is over it. The view is hidden here, which an engine may
  // refuse to picture: reported, not required.
  await within("capture", view.capture({ format: "jpeg", scale: 1 })).then(
    (shot) => log(`capture: ${shot.type}, ${shot.size} bytes`),
    (e) => log(`capture of the hidden view: ${e?.message ?? e}`),
  );
  await view.close();
  log(`OK ${state.title}`);
}
