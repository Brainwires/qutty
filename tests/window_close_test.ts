// The window's close button (lib/workspace/windows.ts): the setting, what a close request does
// with it, and the guard that runs the question or the end and lets a second click through.

import { assertEquals } from "@std/assert";
import {
  closeDecision,
  createCloseGuard,
  DEFAULT_WINDOW_CLOSE,
  sanitizeWindowClose,
  WINDOW_CLOSE_CHOICES,
  type WindowClose,
} from "../lib/workspace/windows.ts";

Deno.test("window close: the setting's choices, its default and junk", () => {
  assertEquals(WINDOW_CLOSE_CHOICES, ["ask", "keep", "end"]);
  assertEquals(DEFAULT_WINDOW_CLOSE, "ask");
  for (const c of WINDOW_CLOSE_CHOICES) assertEquals(sanitizeWindowClose(c), c);
  for (const junk of [undefined, null, "", "detach", "Keep", 0, {}, []]) {
    assertEquals(sanitizeWindowClose(junk), "ask");
  }
});

Deno.test("window close: what a close request does, for every setting and reason", () => {
  const table: [WindowClose, "close" | "quit", boolean, string][] = [
    // A quit is never held here: the app's quit guard asks about busy agents.
    ["ask", "quit", false, "allow"],
    ["keep", "quit", false, "allow"],
    ["end", "quit", false, "allow"],
    ["ask", "quit", true, "allow"],
    // The close button.
    ["ask", "close", false, "ask"],
    ["keep", "close", false, "allow"],
    ["end", "close", false, "end"],
    // A second click while the page is asking or ending: it closes (and detaches) as before.
    ["ask", "close", true, "allow"],
    ["end", "close", true, "allow"],
    ["keep", "close", true, "allow"],
  ];
  for (const [setting, reason, busy, want] of table) {
    assertEquals(
      closeDecision(setting, reason, busy),
      want,
      `${setting} / ${reason}${busy ? " (busy)" : ""}`,
    );
  }
  assertEquals(closeDecision("ask", "close"), "ask", "not busy by default");
});

/** A guard over a fake page: what it asked and ended, and the end's resolution. */
function fakeGuard(setting: WindowClose) {
  const log: string[] = [];
  let finish: () => void = () => {};
  const state = { setting };
  const guard = createCloseGuard({
    setting: () => state.setting,
    ask: () => log.push("ask"),
    end: () => {
      log.push("end");
      return new Promise<void>((r) => finish = r);
    },
  });
  return { guard, log, state, finish: () => finish() };
}

Deno.test("window close guard: keep lets the window close; quits always go through", () => {
  const { guard, log } = fakeGuard("keep");
  assertEquals(guard.request("close"), true);
  assertEquals(guard.request("quit"), true);
  assertEquals(log, []);
});

Deno.test("window close guard: ask holds the window and asks once; a second click closes it", () => {
  const { guard, log, state } = fakeGuard("ask");
  assertEquals(guard.request("close"), false);
  assertEquals(log, ["ask"]);
  // While the question is up: another click lets the window close (detached), asks nothing.
  assertEquals(guard.request("close"), true);
  assertEquals(log, ["ask"]);
  // A quit while asking is not held either.
  assertEquals(guard.request("quit"), true);
  // Answered (or cancelled): the next click asks again, with the setting as it is now.
  guard.settle();
  assertEquals(guard.request("close"), false);
  assertEquals(log, ["ask", "ask"]);
  guard.settle();
  state.setting = "keep";
  assertEquals(guard.request("close"), true);
  assertEquals(log, ["ask", "ask"]);
});

Deno.test("window close guard: end holds the window and ends its shells; busy until done", async () => {
  const { guard, log, finish } = fakeGuard("end");
  assertEquals(guard.request("close"), false);
  assertEquals(log, ["end"]);
  // The busy-agent box may be up: a second click closes the window as before.
  assertEquals(guard.request("close"), true);
  assertEquals(log, ["end"]);
  // Declined (the window stayed): the next click ends again.
  finish();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(guard.request("close"), false);
  assertEquals(log, ["end", "end"]);
});

Deno.test("window close guard: a failed end does not leave the guard busy", async () => {
  const log: string[] = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    const guard = createCloseGuard({
      setting: () => "end",
      ask: () => log.push("ask"),
      end: () => (log.push("end"), Promise.reject(new Error("gone"))),
    });
    assertEquals(guard.request("close"), false);
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(guard.request("close"), false);
    assertEquals(log, ["end", "end"]);
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    console.warn = warn;
  }
});
