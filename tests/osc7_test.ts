// lib/osc7.ts: the shell's working-directory report. Run: deno test -A tests/

import { assertEquals } from "@std/assert";
import { parseOsc7 } from "../lib/osc7.ts";

Deno.test("parseOsc7: file URLs with and without a host, percent-decoding", () => {
  assertEquals(parseOsc7("file://web-1/home/deploy/app"), {
    host: "web-1",
    path: "/home/deploy/app",
  });
  assertEquals(parseOsc7("file:///Users/me"), { host: "", path: "/Users/me" });
  assertEquals(parseOsc7("file://h/My%20Docs/caf%C3%A9"), {
    host: "h",
    path: "/My Docs/café",
  });
  assertEquals(parseOsc7("FILE://h/x"), { host: "h", path: "/x" });
  assertEquals(parseOsc7(" file://h/x\n"), { host: "h", path: "/x" });
  // A malformed escape is left as sent rather than dropped.
  assertEquals(parseOsc7("file://h/bad%zz"), { host: "h", path: "/bad%zz" });
  assertEquals(parseOsc7("file://h/"), { host: "h", path: "/" });
});

Deno.test("parseOsc7: anything else is undefined", () => {
  for (
    const bad of [
      "",
      "file://h",
      "file:h/x",
      "kitty-shell-cwd://h/x",
      "http://h/x",
      "/x",
      "file://h/%00",
    ]
  ) {
    assertEquals(parseOsc7(bad), undefined, JSON.stringify(bad));
  }
});
