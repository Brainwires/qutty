// The Whisper model's first-use download (lib/voice/model.ts) over a fake file system and fetcher:
// progress, the size and SHA-256 checks, a bad or failed download removed, cancel, and an existing
// file checked once per session.

import { assert, assertEquals } from "@std/assert";
import {
  type DownloadJob,
  formatSize,
  hex,
  type ModelFiles,
  type ModelState,
  ModelStore,
  WHISPER_BASE_EN,
  type WhisperModel,
} from "../lib/voice/model.ts";

const MODEL: WhisperModel = {
  file: "tiny.bin",
  label: "tiny",
  url: "https://example.invalid/tiny.bin",
  sizeBytes: 5,
  sha256: "aaaa",
};

/** An in-memory file system: path → content (its "hash" is the content). */
class MemFiles implements ModelFiles {
  files = new Map<string, string>();
  dirs: string[] = [];
  hashes = 0;
  size(path: string) {
    return Promise.resolve(this.files.get(path)?.length);
  }
  sha256(path: string) {
    this.hashes++;
    return Promise.resolve(this.files.get(path) === "hello" ? "aaaa" : "bbbb");
  }
  ensureDir(path: string) {
    this.dirs.push(path);
  }
  rename(from: string, to: string) {
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
  remove(path: string) {
    this.files.delete(path);
  }
}

/** A fetch the test completes: it writes `body` to the destination in two steps. */
function fakeFetch(files: MemFiles, body: string, ok = true) {
  const calls: { url: string; dest: string }[] = [];
  let finish!: () => void;
  let cancelled = false;
  const fetch = (url: string, dest: string): DownloadJob => {
    calls.push({ url, dest });
    files.files.set(dest, body.slice(0, 2));
    return {
      done: new Promise((resolve) => {
        finish = () => {
          files.files.set(dest, body);
          resolve(ok ? { ok: true } : { ok: false, error: "curl exit 22" });
        };
      }),
      cancel: () => {
        cancelled = true;
        finish();
      },
    };
  };
  return {
    fetch,
    calls,
    finish: () => finish(),
    wasCancelled: () => cancelled,
  };
}

function store(files: MemFiles, fetch: ModelStoreFetch) {
  const states: ModelState[] = [];
  const s = new ModelStore({
    appSupportDir: "/app",
    model: MODEL,
    files,
    fetch,
    onState: (st) => states.push(st),
    pollMs: 5,
  });
  return { s, states };
}
type ModelStoreFetch = (url: string, dest: string) => DownloadJob;

Deno.test("model: missing → download with progress → checked → ready", async () => {
  const files = new MemFiles();
  const f = fakeFetch(files, "hello");
  const { s, states } = store(files, f.fetch);
  assertEquals((await s.check()).state, "missing");
  const done = s.download();
  assertEquals(f.calls, [{
    url: MODEL.url,
    dest: "/app/models/tiny.bin.part",
  }]);
  assertEquals(files.dirs, ["/app", "/app/models"]);
  await new Promise((r) => setTimeout(r, 20));
  assert(
    states.some((st) => st.state === "downloading" && st.received === 2),
    JSON.stringify(states),
  );
  f.finish();
  assertEquals((await done).state, "ready");
  assertEquals(files.files.get("/app/models/tiny.bin"), "hello");
  assert(!files.files.has("/app/models/tiny.bin.part"));
  assert(states.some((st) => st.state === "verifying"));
  // Checked once a session: the next check does not hash again.
  const hashes = files.hashes;
  assertEquals((await s.check()).state, "ready");
  assertEquals(files.hashes, hashes);
});

Deno.test("model: a checksum or size mismatch is removed and reported", async () => {
  const files = new MemFiles();
  const bad = fakeFetch(files, "hellx");
  const a = store(files, bad.fetch);
  const done = a.s.download();
  bad.finish();
  const st = await done;
  assertEquals(st, {
    state: "error",
    error: "the download's checksum does not match",
  });
  assertEquals([...files.files.keys()], []);

  const short = fakeFetch(files, "hell");
  const b = store(files, short.fetch);
  const done2 = b.s.download();
  short.finish();
  assertEquals((await done2).state, "error");
  assertEquals([...files.files.keys()], []);
});

Deno.test("model: a failed download leaves nothing; cancel too", async () => {
  const files = new MemFiles();
  const failed = fakeFetch(files, "hello", false);
  const a = store(files, failed.fetch);
  const done = a.s.download();
  failed.finish();
  assertEquals(await done, { state: "error", error: "curl exit 22" });
  assertEquals([...files.files.keys()], []);

  const slow = fakeFetch(files, "hello");
  const b = store(files, slow.fetch);
  const done2 = b.s.download();
  b.s.cancel();
  await done2;
  assert(slow.wasCancelled());
  assertEquals(b.s.state, { state: "missing" });
  assertEquals([...files.files.keys()], []);
});

Deno.test("model: an existing file is checked, a corrupt one removed", async () => {
  const files = new MemFiles();
  files.files.set("/app/models/tiny.bin", "hellx");
  const { s } = store(files, fakeFetch(files, "").fetch);
  assertEquals((await s.check()).state, "error");
  assert(!files.files.has("/app/models/tiny.bin"));
  files.files.set("/app/models/tiny.bin", "hello");
  assertEquals((await s.check()).state, "ready");
});

Deno.test("model: the default is base.en q5_1 with its Hugging Face checksum", async () => {
  assertEquals(WHISPER_BASE_EN.sizeBytes, 59_721_011);
  assertEquals(WHISPER_BASE_EN.sha256.length, 64);
  assert(WHISPER_BASE_EN.url.startsWith("https://huggingface.co/"));
  assertEquals(formatSize(WHISPER_BASE_EN.sizeBytes), "57 MB");
  assertEquals(formatSize(2048), "2 KB");
  assertEquals(formatSize(3 * 1024 ** 3), "3.0 GB");
  // hex() as the real check computes it.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("abc"),
  );
  assertEquals(
    hex(digest),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
