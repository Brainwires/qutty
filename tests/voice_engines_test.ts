// The page's engines behind the adapters (lib/voice/engines.ts) and the demo voice backend
// (lib/voice/client.ts): why native push-to-talk cannot run (no library, no model, no key), cloud
// keys only in the desktop app, Web Speech only where it exists, and the demo's timed TTS.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  cloudKeyName,
  demoTts,
  type KeyStore,
  nativeStt,
  webRecognition,
  webSpeechStt,
} from "../lib/voice/engines.ts";
import {
  createDemoVoice,
  demoVoiceScript,
  type VoiceBackend,
  type VoiceStatus,
} from "../lib/voice/client.ts";

const okStatus: VoiceStatus = {
  lib: { ok: true, version: "rullama-audio-ffi 0.1.0", path: "/x" },
  model: { state: "ready", label: "Whisper", size: "57 MB" },
};

function fakeVoice(
  status: VoiceStatus,
  kind: "desktop" | "demo" = "desktop",
): VoiceBackend & { started: [string, string | undefined][] } {
  const started: [string, string | undefined][] = [];
  return {
    ...createDemoVoice(),
    kind,
    started,
    status: () => Promise.resolve(status),
    sttStart: (engine, key) => {
      started.push([engine, key]);
      return Promise.resolve();
    },
  };
}

const keys = (deepgram: string | null): KeyStore => ({
  get: (s) => Promise.resolve(s === "deepgram" ? deepgram : null),
  set: () => Promise.resolve(),
  remove: () => Promise.resolve(),
});

Deno.test("native STT: says what is missing", async () => {
  const noLib = nativeStt(
    fakeVoice({
      ...okStatus,
      lib: { ok: false, reason: "not found", searched: [] },
    }),
    "local",
  );
  assertEquals(await noLib.probe(), {
    ok: false,
    reason: "the on-device audio library is not installed (not found)",
    fix: "build-lib",
  });
  const noModel = nativeStt(
    fakeVoice({ ...okStatus, model: { ...okStatus.model, state: "missing" } }),
    "local",
  );
  assertEquals(await noModel.probe(), {
    ok: false,
    reason: "the speech model (57 MB) is not downloaded yet",
    fix: "download-model",
  });
  assertEquals(
    (await nativeStt(fakeVoice(okStatus), "local").probe()).ok,
    true,
  );
});

Deno.test("native STT: a cloud engine needs a key, read from the keychain on the desktop only", async () => {
  const voice = fakeVoice(okStatus);
  const dg = nativeStt(voice, "deepgram", keys("dg-key"));
  assertEquals(await dg.probe(), { ok: true });
  await dg.start();
  assertEquals(voice.started, [["deepgram", "dg-key"]]);
  // A cloud engine does not need the model.
  const noModel = fakeVoice({
    ...okStatus,
    model: { ...okStatus.model, state: "missing" },
  });
  assertEquals(
    (await nativeStt(noModel, "deepgram", keys("k")).probe()).ok,
    true,
  );
  assertEquals(
    await nativeStt(voice, "elevenlabs", keys("dg-key")).probe(),
    {
      ok: false,
      reason: "no ElevenLabs key (Settings → Voice)",
      fix: "set-key",
    },
  );
  // The demo (a browser) never reads keys.
  const demo = nativeStt(
    fakeVoice(okStatus, "demo"),
    "deepgram",
    keys("dg-key"),
  );
  assertEquals((await demo.probe()).ok, false);
  assertEquals(cloudKeyName("deepgram"), "voice.deepgram.apiKey");
});

Deno.test("Web Speech: only where the window has it", async () => {
  assertEquals(webRecognition({}), undefined);
  assertEquals((await webSpeechStt(undefined).probe()).ok, false);
  class Rec {
    lang = "";
    continuous = false;
    interimResults = true;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    start() {}
    stop() {
      this.onresult?.({
        results: [[{ transcript: "hello" }], [{ transcript: "world" }]],
      });
      this.onend?.();
    }
    abort() {}
  }
  const ctor = webRecognition({ webkitSpeechRecognition: Rec });
  assert(ctor);
  const stt = webSpeechStt(ctor);
  assertEquals(await stt.probe(), { ok: true });
  await stt.start();
  assertEquals(await stt.stop(), "hello world");
});

Deno.test("demo voice: scripted transcripts, one capture at a time, a stoppable TTS", async () => {
  const script = demoVoiceScript();
  script.transcripts.push("first");
  const voice = createDemoVoice(script);
  await voice.sttStart("local");
  await assertRejects(() => voice.sttStart("local"));
  assertEquals(await voice.sttStop(), "first");
  await voice.sttStart("local");
  assertEquals(await voice.sttStop(), "what's going on?");
  await voice.sttStart("local");
  await voice.sttCancel();
  assertEquals(script.cancels, 1);
  assertEquals(script.starts, ["local", "local", "local"]);
  await assertRejects(() => voice.speak("x", { key: "k" }));

  script.msPerChar = 1000;
  const tts = demoTts(script);
  const said = tts.speak("a long sentence", {});
  await tts.stop();
  await said;
  assertEquals(script.spoken, ["a long sentence"]);
  assertEquals(script.stops, 1);
});
