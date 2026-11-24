// A web tile's download list (lib/web/downloads.ts): the entries kept from the engine's
// `download` events, a download refused at the save panel dropped, dismissing, the limit, which
// buttons each state shows, and what an entry says.

import { assert, assertEquals } from "@std/assert";
import {
  applyDownload,
  dismissDownload,
  downloadButtons,
  downloadFraction,
  downloadStatus,
  formatBytes,
  MAX_DOWNLOADS,
  revealLabel,
  type WebDownload,
} from "../lib/web/downloads.ts";

const step = (patch: Partial<WebDownload> = {}): WebDownload => ({
  id: 1,
  url: "https://example.com/a.zip",
  filename: "a.zip",
  receivedBytes: 0,
  state: "requested",
  paused: false,
  canResume: false,
  ...patch,
});

Deno.test("downloads: a download is added once and follows its steps", () => {
  let list = applyDownload([], step());
  assertEquals(list.length, 1);
  list = applyDownload(
    list,
    step({
      state: "progressing",
      receivedBytes: 10,
      totalBytes: 100,
      path: "/d/a.zip",
    }),
  );
  assertEquals(list.length, 1);
  assertEquals(list[0].receivedBytes, 10);
  list = applyDownload(list, step({ id: 2, filename: "b.pdf" }));
  assertEquals(list.map((d) => d.id), [1, 2], "newest last");
  list = applyDownload(
    list,
    step({
      state: "completed",
      receivedBytes: 100,
      totalBytes: 100,
      path: "/d/a.zip",
    }),
  );
  assertEquals(list[0].state, "completed");
});

Deno.test("downloads: one refused at the save panel is dropped, a started one shows as cancelled", () => {
  let list = applyDownload([], step());
  list = applyDownload(list, step({ state: "cancelled" }));
  assertEquals(list, [], "the save panel was dismissed");
  // Cancelled before it was ever seen: nothing to show either.
  assertEquals(applyDownload([], step({ state: "cancelled" })), []);
  list = applyDownload([], step({ state: "progressing", path: "/d/a.zip" }));
  list = applyDownload(list, step({ state: "cancelled", path: "/d/a.zip" }));
  assertEquals(list.map((d) => d.state), ["cancelled"]);
  list = applyDownload([], step({ state: "progressing" }));
  list = applyDownload(list, step({ state: "cancelled" }));
  assertEquals(list.map((d) => d.state), ["cancelled"], "it had started");
});

Deno.test("downloads: only a finished entry is dismissed", () => {
  const running = applyDownload(
    [],
    step({ state: "progressing", path: "/x" }),
  );
  assertEquals(dismissDownload(running, 1), running);
  const done = applyDownload(running, step({ state: "completed", path: "/x" }));
  assertEquals(dismissDownload(done, 1), []);
  assertEquals(dismissDownload(done, 9), done, "an unknown id changes nothing");
});

Deno.test("downloads: past the limit the oldest finished entries go, running ones stay", () => {
  let list: readonly WebDownload[] = [];
  list = applyDownload(list, step({ id: 0, state: "progressing", path: "/0" }));
  for (let i = 1; i <= MAX_DOWNLOADS + 2; i++) {
    list = applyDownload(
      list,
      step({ id: i, state: "completed", path: `/${i}` }),
    );
  }
  assertEquals(list.length, MAX_DOWNLOADS);
  assertEquals(list[0].id, 0, "the running one stays");
  assertEquals(list[list.length - 1].id, MAX_DOWNLOADS + 2);
});

Deno.test("downloads: the buttons each state shows", () => {
  const b = (d: WebDownload, pause = true) => downloadButtons(d, pause);
  assertEquals(b(step()), {
    pause: false,
    resume: false,
    cancel: true,
    reveal: false,
    dismiss: false,
  });
  const running = step({ state: "progressing", path: "/x" });
  assertEquals(b(running), {
    pause: true,
    resume: false,
    cancel: true,
    reveal: false,
    dismiss: false,
  });
  assertEquals(
    b(running, false).pause,
    false,
    "no Pause where the runtime cannot",
  );
  const paused = { ...running, paused: true };
  assertEquals([b(paused).pause, b(paused).resume], [false, true]);
  assertEquals(b(paused, false).resume, false);
  assertEquals(b(step({ state: "completed", path: "/x" })), {
    pause: false,
    resume: false,
    cancel: false,
    reveal: true,
    dismiss: true,
  });
  assertEquals(
    b(step({ state: "completed" })).reveal,
    false,
    "no path, nothing to show",
  );
  assertEquals(b(step({ state: "cancelled", path: "/x" })).reveal, false);
  const broken = step({ state: "interrupted", canResume: true, path: "/x" });
  assertEquals(
    [b(broken).resume, b(broken).cancel, b(broken).dismiss],
    [true, true, true],
  );
  const dead = step({ state: "interrupted", path: "/x" });
  assertEquals(
    [b(dead).resume, b(dead).cancel, b(dead).dismiss],
    [false, false, true],
  );
});

Deno.test("downloads: progress, bytes and words", () => {
  assertEquals(
    downloadFraction(step({ state: "progressing", receivedBytes: 5 })),
    null,
    "no size: indeterminate",
  );
  assertEquals(
    downloadFraction(
      step({ state: "progressing", receivedBytes: 25, totalBytes: 100 }),
    ),
    0.25,
  );
  assertEquals(downloadFraction(step({ state: "completed" })), 1);
  assertEquals(formatBytes(512), "512 B");
  assertEquals(formatBytes(1536), "1.5 KB");
  assertEquals(formatBytes(20 * 1024 * 1024), "20 MB");
  assertEquals(
    downloadStatus(
      step({ state: "progressing", receivedBytes: 1536, totalBytes: 4096 }),
    ),
    "1.5 KB of 4.0 KB",
  );
  assertEquals(
    downloadStatus(
      step({ state: "progressing", receivedBytes: 512, paused: true }),
    ),
    "Paused, 512 B",
  );
  assertEquals(
    downloadStatus(step({ state: "interrupted", reason: "network" })),
    "Failed: network error",
  );
  assertEquals(downloadStatus(step({ state: "cancelled" })), "Cancelled");
  assert(downloadStatus(step()).startsWith("Choosing"));
  assertEquals(revealLabel("mac"), "Show in Finder");
  assertEquals(revealLabel("other"), "Show in file manager");
});
