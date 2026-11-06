// The binding to rullama-hardware's audio library (lib/voice/ffi.ts): the symbol table against the
// C header, the typed wrapper over a fake library (error codes, buffers, the async transcribe),
// where the library is looked for — and, where the real library and the Whisper model are present
// (a developer's Mac; not Linux CI), a real transcription of a `say`-generated WAV. No test opens
// the microphone.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  AUDIO_SYMBOLS,
  AudioCode,
  AudioError,
  AudioLib,
  audioLibCandidates,
  audioLibFile,
  type AudioSymbols,
  CaptureState,
} from "../lib/voice/ffi.ts";
import { WHISPER_BASE_EN } from "../lib/voice/model.ts";
import { appSupportDir } from "../scripts/build-audio-lib.ts";

/** rullama_audio.h's declarations, as (name, C result, C parameter types). */
const HEADER: [string, string, string[]][] = [
  ["rla_version", "pointer", []],
  ["rla_last_error", "i32", ["buffer", "usize"]],
  ["rla_stt_load", "i32", ["buffer"]],
  ["rla_stt_loaded", "i32", []],
  ["rla_capture_start", "i32", []],
  ["rla_capture_stop", "i32", []],
  ["rla_capture_stop_wav", "i32", ["buffer"]],
  ["rla_cancel", "i32", []],
  ["rla_state", "i32", []],
  ["rla_level", "f32", []],
  ["rla_captured_ms", "u32", []],
  ["rla_take_transcript", "i32", ["buffer", "usize"]],
  ["rla_transcribe_wav", "i32", ["buffer", "buffer", "usize"]],
  ["rla_play_wav", "i32", ["buffer"]],
  ["rla_play_stop", "i32", []],
  ["rla_playing", "i32", []],
];

Deno.test("audio FFI: the symbol table matches the C ABI", () => {
  assertEquals(
    Object.keys(AUDIO_SYMBOLS).sort(),
    HEADER.map(([n]) => n).sort(),
  );
  for (const [name, result, params] of HEADER) {
    const sym = AUDIO_SYMBOLS[name as keyof typeof AUDIO_SYMBOLS];
    assertEquals(sym.result, result, name);
    assertEquals([...sym.parameters], params, name);
  }
  // Only Whisper on a file runs on the blocking pool.
  const nonblocking = Object.entries(AUDIO_SYMBOLS)
    .filter(([, s]) => "nonblocking" in s && s.nonblocking).map(([n]) => n);
  assertEquals(nonblocking, ["rla_transcribe_wav"]);
});

/** Where the Rullama header is when the worktree is checked out next to Qutty. */
const HEADER_FILE = new URL(
  "../../rullama-audio-ffi/crates/rullama-audio-ffi/include/rullama_audio.h",
  new URL("../", import.meta.url),
);

Deno.test("audio FFI: every symbol is declared in rullama_audio.h (when checked out)", async (t) => {
  let header: string;
  try {
    header = await Deno.readTextFile(HEADER_FILE);
  } catch {
    return void await t.step({
      name: "skipped: no Rullama checkout beside Qutty",
      ignore: true,
      fn: () => {},
    });
  }
  for (const [name] of HEADER) {
    assert(new RegExp(`\\b${name}\\s*\\(`).test(header), name);
  }
});

const enc = new TextEncoder();

/** A fake library: scripted return codes and texts. */
function fakeLib(over: Partial<Record<keyof AudioSymbols, unknown>> = {}) {
  const calls: string[] = [];
  const write = (buf: Uint8Array, text: string) => {
    const bytes = enc.encode(text);
    buf.set(bytes.subarray(0, buf.length - 1));
    buf[Math.min(bytes.length, buf.length - 1)] = 0;
    return bytes.length;
  };
  const base = {
    rla_version: () => "VERSION",
    rla_last_error: (buf: Uint8Array) => write(buf, "model file is corrupt"),
    rla_stt_load: () => -1,
    rla_stt_loaded: () => 0,
    rla_capture_start: () => AudioCode.noDevice,
    rla_capture_stop: () => AudioCode.noModel,
    rla_capture_stop_wav: () => 1500,
    rla_cancel: () => (calls.push("cancel"), 0),
    rla_state: () => CaptureState.done,
    rla_level: () => 0.25,
    rla_captured_ms: () => 900,
    rla_take_transcript: (buf: Uint8Array) => write(buf, "  run the tests  "),
    rla_transcribe_wav: (_p: Uint8Array, buf: Uint8Array) =>
      Promise.resolve(write(buf, "hello there")),
    rla_play_wav: () => AudioCode.wrongState,
    rla_play_stop: () => (calls.push("play_stop"), 0),
    rla_playing: () => 1,
    ...over,
  };
  return {
    lib: new AudioLib(base as unknown as AudioSymbols, (p) => String(p)),
    calls,
  };
}

Deno.test("audio FFI: the wrapper checks every call and says why", async () => {
  const { lib, calls } = fakeLib();
  assertEquals(lib.version(), "VERSION");
  const load = assertThrows(() => lib.loadModel("/m.bin"), AudioError);
  assertEquals(load.message, "loading the model: model file is corrupt");
  assertEquals(load.code, AudioCode.error);
  assertThrows(() => lib.startCapture(), AudioError, "no microphone was found");
  assertThrows(
    () => lib.stopCapture(),
    AudioError,
    "no speech model is loaded",
  );
  assertThrows(() => lib.playWav("/x.wav"), AudioError, "not now");
  assertEquals(lib.stopCaptureToWav("/tmp/x.wav"), 1500);
  assertEquals(lib.take(), "run the tests");
  assertEquals(await lib.transcribeWav("/x.wav"), "hello there");
  assertEquals(lib.level(), 0.25);
  assertEquals(lib.capturedMs(), 900);
  assertEquals(lib.state(), CaptureState.done);
  assert(lib.playing() && !lib.modelLoaded());
  lib.cancel();
  lib.stopPlayback();
  assertEquals(calls, ["cancel", "play_stop"]);
});

Deno.test("audio FFI: a transcript longer than the buffer is cut, an async error is thrown", async () => {
  const { lib } = fakeLib({
    rla_take_transcript: (buf: Uint8Array) => {
      buf.fill(97);
      buf[buf.length - 1] = 0;
      return buf.length + 10;
    },
    rla_transcribe_wav: () => Promise.resolve(AudioCode.noModel),
  });
  assertEquals(lib.take().length, 64 * 1024 - 1);
  await assertRejects(
    () => lib.transcribeWav("/x.wav"),
    AudioError,
    "no speech model",
  );
});

Deno.test("audio FFI: where the library is looked for", () => {
  assertEquals(audioLibFile("darwin"), "librullama_audio_ffi.dylib");
  assertEquals(audioLibFile("linux"), "librullama_audio_ffi.so");
  assertEquals(
    audioLibCandidates({
      os: "darwin",
      env: "/dev/lib.dylib",
      execPath: "/Applications/Qutty.app/Contents/MacOS/Qutty",
      appSupportDir: "/Users/u/Library/Application Support/org.qutty.Qutty",
    }),
    [
      "/dev/lib.dylib",
      "/Applications/Qutty.app/Contents/Frameworks/librullama_audio_ffi.dylib",
      "/Users/u/Library/Application Support/org.qutty.Qutty/audio/librullama_audio_ffi.dylib",
    ],
  );
  assertEquals(
    audioLibCandidates({
      os: "linux",
      execPath: "/opt/qutty/qutty",
      appSupportDir: "/d",
    }),
    [
      "/opt/qutty/lib/librullama_audio_ffi.so",
      "/d/audio/librullama_audio_ffi.so",
    ],
  );
  assertEquals(
    appSupportDir("darwin", "/Users/u", () => undefined),
    "/Users/u/Library/Application Support/org.qutty.Qutty",
  );
  assertEquals(
    appSupportDir(
      "linux",
      "/home/u",
      (n) => n === "XDG_DATA_HOME" ? "/x" : undefined,
    ),
    "/x/org.qutty.Qutty",
  );
});

// ---------------------------------------------------------------------------------------------
// The real library (skipped where it is not built)
// ---------------------------------------------------------------------------------------------

const home = Deno.env.get("HOME") ?? "";
const support = appSupportDir(Deno.build.os, home, (n) => Deno.env.get(n));

function firstExisting(paths: (string | undefined)[]): string | undefined {
  for (const p of paths) {
    if (!p) continue;
    try {
      Deno.statSync(p);
      return p;
    } catch { /* next */ }
  }
  return undefined;
}

const realLib = firstExisting([
  Deno.env.get("QUTTY_AUDIO_LIB"),
  `${support}/audio/${audioLibFile(Deno.build.os)}`,
  new URL(
    `../../rullama-audio-ffi/target/release/${audioLibFile(Deno.build.os)}`,
    new URL("../", import.meta.url),
  ).pathname,
]);
const realModel = firstExisting([
  Deno.env.get("QUTTY_WHISPER_MODEL"),
  `${support}/models/${WHISPER_BASE_EN.file}`,
]);

Deno.test({
  name: "audio FFI (real library): loads, and transcribes a spoken WAV",
  ignore: !realLib || !realModel,
  async fn() {
    const dl = Deno.dlopen(realLib!, AUDIO_SYMBOLS);
    try {
      const lib = new AudioLib(dl.symbols);
      assert(lib.version().startsWith("rullama-audio-ffi"), lib.version());
      assertEquals(lib.state(), CaptureState.idle);
      lib.loadModel(realModel!);
      assert(lib.modelLoaded());
      const wav =
        new URL("./fixtures/voice/phrase.wav", import.meta.url).pathname;
      const text = await lib.transcribeWav(wav);
      console.log(`  transcript: ${JSON.stringify(text)}`);
      const plain = text.toLowerCase().replace(/[^a-z ]/g, "");
      assert(plain.includes("run the tests"), text);
      assert(plain.includes("second tile"), text);
      // Stopping a capture that never started is a state error, not a crash.
      assertThrows(() => lib.stopCapture(), AudioError);
    } finally {
      dl.close();
    }
  },
});
