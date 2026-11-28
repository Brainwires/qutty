// Kokoro, the on-device voice (lib/voice/kokoro.ts): the pinned files, their download as one set
// over a fake file system and fetcher (one progress, each file's own check, only what is missing
// fetched, a bad file reported, cancel), the library's voices as Settings lists them, and whether
// it can speak.

import { assert, assertEquals } from "@std/assert";
import {
  combineStates,
  groupKokoroVoices,
  KOKORO_FILES,
  KOKORO_MODEL,
  KOKORO_VOICES,
  kokoroReady,
  type KokoroVoice,
  kokoroVoiceLabel,
  ModelSet,
  parseKokoroVoices,
  pickKokoroVoice,
} from "../lib/voice/kokoro.ts";
import {
  type DownloadJob,
  type ModelFile,
  type ModelFiles,
  type ModelState,
} from "../lib/voice/model.ts";
import { KOKORO_BYTES } from "../lib/voice/client.ts";

Deno.test("kokoro: the files are pinned by URL, size and SHA-256", () => {
  assertEquals(KOKORO_FILES.length, 2);
  for (const f of KOKORO_FILES) {
    assert(f.url.startsWith("https://"), f.url);
    assert(/^[0-9a-f]{64}$/.test(f.sha256), f.file);
    assert(f.sizeBytes > 1_000_000, f.file);
  }
  // The model comes from a Hugging Face commit, not from a branch that can move.
  assert(
    /^https:\/\/huggingface\.co\/onnx-community\/Kokoro-82M-v1\.0-ONNX\/resolve\/[0-9a-f]{40}\/onnx\/model\.onnx$/
      .test(KOKORO_MODEL.url),
    KOKORO_MODEL.url,
  );
  assert(KOKORO_VOICES.url.endsWith("/model-files-v1.0/voices-v1.0.bin"));
  assertEquals(new Set(KOKORO_FILES.map((f) => f.file)).size, 2);
  assertEquals(KOKORO_BYTES, 353_746_630);
});

const A: ModelFile = {
  file: "a.bin",
  label: "A",
  url: "https://example.invalid/a",
  sizeBytes: 5,
  sha256: "aaaa",
};
const B: ModelFile = {
  file: "b.bin",
  label: "B",
  url: "https://example.invalid/b",
  sizeBytes: 3,
  sha256: "bbbb",
};
/** What each good file holds; a file's "hash" follows from its content. */
const GOOD: Record<string, string> = { [A.url]: "hello", [B.url]: "abc" };

class MemFiles implements ModelFiles {
  files = new Map<string, string>();
  hashes = 0;
  size(path: string) {
    return Promise.resolve(this.files.get(path)?.length);
  }
  sha256(path: string) {
    this.hashes++;
    const body = this.files.get(path);
    return Promise.resolve(
      body === "hello" ? "aaaa" : body === "abc" ? "bbbb" : "????",
    );
  }
  ensureDir() {}
  rename(from: string, to: string) {
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
  remove(path: string) {
    this.files.delete(path);
  }
}

/** A fetcher that writes `bodies[url]` at once, or holds the URLs in `hold` until finished. */
function fetcher(
  files: MemFiles,
  bodies: Record<string, string> = GOOD,
  hold: string[] = [],
) {
  const calls: string[] = [];
  const cancelled: string[] = [];
  const held = new Map<string, () => void>();
  const fetch = (url: string, dest: string): DownloadJob => {
    calls.push(url);
    if (!hold.includes(url)) {
      files.files.set(dest, bodies[url]);
      return { done: Promise.resolve({ ok: true }), cancel() {} };
    }
    files.files.set(dest, bodies[url].slice(0, 2));
    let settle!: (r: { ok: boolean; error?: string }) => void;
    const done = new Promise<{ ok: boolean; error?: string }>((r) =>
      settle = r
    );
    held.set(url, () => {
      files.files.set(dest, bodies[url]);
      settle({ ok: true });
    });
    return {
      done,
      cancel() {
        cancelled.push(url);
        settle({ ok: false, error: "cancelled" });
      },
    };
  };
  return { fetch, calls, cancelled, finish: (url: string) => held.get(url)!() };
}

function set(
  files: MemFiles,
  fetch: (url: string, dest: string) => DownloadJob,
) {
  const states: ModelState[] = [];
  const s = new ModelSet({
    appSupportDir: "/app",
    models: [A, B],
    files,
    fetch,
    onState: (st) => states.push(st),
    pollMs: 5,
  });
  return { s, states };
}

Deno.test("model set: both files fetched in order, one progress, each checked", async () => {
  const files = new MemFiles();
  const f = fetcher(files);
  const { s, states } = set(files, f.fetch);
  assertEquals(s.totalBytes, 8);
  assertEquals(s.paths, ["/app/models/a.bin", "/app/models/b.bin"]);
  assertEquals((await s.check()).state, "missing");
  assertEquals(states, []);

  assertEquals(await s.download(), { state: "ready" });
  assertEquals(f.calls, [A.url, B.url]);
  assertEquals(states, [
    { state: "downloading", received: 0, total: 8 },
    { state: "downloading", received: 5, total: 8 },
    { state: "downloading", received: 8, total: 8 },
    { state: "ready" },
  ]);
  assertEquals([...files.files.keys()].sort(), s.paths);
  assertEquals(s.state, { state: "ready" });

  // Ready: nothing more is fetched or hashed this session.
  const hashes = files.hashes;
  assertEquals((await s.check()).state, "ready");
  assertEquals((await s.download()).state, "ready");
  assertEquals([f.calls.length, files.hashes], [2, hashes]);
});

Deno.test("model set: only what is missing is fetched, and progress counts what is there", async () => {
  const files = new MemFiles();
  files.files.set("/app/models/a.bin", "hello");
  const f = fetcher(files, GOOD, [B.url]);
  const { s, states } = set(files, f.fetch);
  // One of two is not "ready".
  assertEquals((await s.check()).state, "missing");
  const done = s.download();
  await new Promise((r) => setTimeout(r, 30));
  assertEquals(f.calls, [B.url]);
  // The first file's 5 bytes and the 2 that have arrived of the second.
  assert(
    states.some((st) => st.state === "downloading" && st.received === 7),
    JSON.stringify(states),
  );
  // A second download while one runs is the same one.
  assertEquals((await s.download()).state, "downloading");
  f.finish(B.url);
  assertEquals((await done).state, "ready");
  assertEquals(f.calls, [B.url]);
});

Deno.test("model set: a bad file is reported and removed; the good one is kept", async () => {
  const files = new MemFiles();
  const bad = fetcher(files, { ...GOOD, [B.url]: "abX" });
  const { s, states } = set(files, bad.fetch);
  assertEquals(await s.download(), {
    state: "error",
    error: "the download's checksum does not match",
  });
  assertEquals(states.at(-1)?.state, "error");
  assertEquals([...files.files.keys()], ["/app/models/a.bin"]);
  assert(!kokoroReady({ available: true, files: { ...s.state, size: "" } }));

  // Trying again fetches the bad one only.
  const good = fetcher(files);
  const retry = set(files, good.fetch);
  assertEquals((await retry.s.download()).state, "ready");
  assertEquals(good.calls, [B.url]);
});

Deno.test("model set: cancel stops the download and keeps nothing partial", async () => {
  const files = new MemFiles();
  const f = fetcher(files, GOOD, [A.url]);
  const { s, states } = set(files, f.fetch);
  const done = s.download();
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(s.state.state, "downloading");
  s.cancel();
  assertEquals(s.state, { state: "missing" });
  assertEquals((await done).state, "missing");
  assertEquals(f.cancelled, [A.url]);
  assertEquals(f.calls, [A.url]);
  assertEquals([...files.files.keys()], []);
  assertEquals(states.at(-1), { state: "missing" });
  // Cancelling with nothing running changes nothing.
  s.cancel();
  assertEquals(s.state, { state: "missing" });
});

Deno.test("model set: the states of the files, as one", () => {
  const part = (state: ModelState, sizeBytes = 10) => ({ state, sizeBytes });
  const ready = part({ state: "ready" });
  const missing = part({ state: "missing" });
  assertEquals(combineStates([ready, ready], false), { state: "ready" });
  assertEquals(combineStates([ready, missing], false), { state: "missing" });
  assertEquals(combineStates([ready, part({ state: "verifying" })], false), {
    state: "verifying",
  });
  // While a download runs, what is not there yet is still to come.
  assertEquals(combineStates([ready, missing], true), {
    state: "downloading",
    received: 10,
    total: 20,
  });
  // More bytes than the file's size (a redirect page, a wrong file) never pass 100%.
  assertEquals(
    combineStates([
      part({ state: "downloading", received: 99, total: 10 }),
      missing,
    ], true),
    { state: "downloading", received: 10, total: 20 },
  );
  const failed = part({ state: "error", error: "no network" });
  assertEquals(combineStates([ready, failed], true), failed.state);
  assertEquals(combineStates([], false), { state: "ready" });
});

/** What `rla_tts_list_voices` answers (a few of the 28). */
const LIBRARY_JSON = JSON.stringify([
  ["af_bella", "Bella", "en-US", "American English", "female", false],
  ["af_heart", "Heart", "en-US", "American English", "female", true],
  ["am_adam", "Adam", "en-US", "American English", "male", false],
  ["bf_emma", "Emma", "en-GB", "British English", "female", false],
  ["bm_george", "George", "en-GB", "British English", "male", false],
].map(([id, name, lang, language, gender, d]) => ({
  id,
  name,
  lang,
  language,
  gender,
  default: d,
})));

Deno.test("kokoro voices: parsed, grouped by accent, named for Settings", () => {
  const voices = parseKokoroVoices(LIBRARY_JSON);
  assertEquals(voices.length, 5);
  assertEquals(voices[1], {
    id: "af_heart",
    name: "Heart",
    lang: "en-US",
    language: "American English",
    gender: "female",
    default: true,
  });
  assertEquals(
    kokoroVoiceLabel(voices[1]),
    "American English — Heart (female)",
  );
  // British listed first by the library here: American still leads.
  assertEquals(groupKokoroVoices([...voices].reverse()), [
    {
      language: "American English",
      voices: [
        { id: "af_bella", label: "American English — Bella (female)" },
        { id: "af_heart", label: "American English — Heart (female)" },
        { id: "am_adam", label: "American English — Adam (male)" },
      ],
    },
    {
      language: "British English",
      voices: [
        { id: "bf_emma", label: "British English — Emma (female)" },
        { id: "bm_george", label: "British English — George (male)" },
      ],
    },
  ]);
  assertEquals(groupKokoroVoices([]), []);
});

Deno.test("kokoro voices: junk from the library is dropped, not shown", () => {
  assertEquals(parseKokoroVoices("not json"), []);
  assertEquals(parseKokoroVoices('{"id":"af_heart"}'), []);
  const mixed = parseKokoroVoices(JSON.stringify([
    null,
    "af_heart",
    { id: "af_heart" },
    {
      id: "AF Heart!",
      name: "x",
      lang: "en-US",
      language: "x",
      gender: "female",
    },
    {
      id: "af_sky",
      name: "Sky",
      lang: "en-US",
      language: "American English",
      gender: "robot",
    },
    {
      id: "af_sky",
      name: "Sky",
      lang: "en-US",
      language: "American English",
      gender: "female",
    },
  ]));
  assertEquals(mixed.map((v) => [v.id, v.default]), [["af_sky", false]]);
});

Deno.test("kokoro voices: the picked one, else the library's default", () => {
  const voices: KokoroVoice[] = parseKokoroVoices(LIBRARY_JSON);
  assertEquals(pickKokoroVoice("bm_george", voices), "bm_george");
  assertEquals(pickKokoroVoice("", voices), "af_heart");
  // A voice that is not in this voices file (an older pick): the default.
  assertEquals(pickKokoroVoice("af_gone", voices), "af_heart");
  assertEquals(
    pickKokoroVoice("", voices.filter((v) => !v.default)),
    "af_bella",
  );
  assertEquals(pickKokoroVoice("af_heart", []), undefined);
});

Deno.test("kokoro: ready only with the library's speech and the checked files", () => {
  const files = (state: ModelState) => ({ ...state, size: "337 MB" });
  assert(kokoroReady({ available: true, files: files({ state: "ready" }) }));
  assert(!kokoroReady({ available: false, files: files({ state: "ready" }) }));
  assert(!kokoroReady({ available: true, files: files({ state: "missing" }) }));
  assert(
    !kokoroReady({ available: true, files: files({ state: "verifying" }) }),
  );
  assert(!kokoroReady(undefined));
});
