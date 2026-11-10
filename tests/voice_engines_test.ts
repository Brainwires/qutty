// The page's engines behind the adapters (lib/voice/engines.ts) and the demo voice backend
// (lib/voice/client.ts): why native push-to-talk cannot run (no library, no model, no key), cloud
// keys that the page can set, clear and ask about but never read back, Web Speech only where it
// exists, and the demo's timed TTS.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  backendKeys,
  cloudTts,
  demoTts,
  type KeyStore,
  nativeStt,
  webRecognition,
  webSpeechStt,
} from "../lib/voice/engines.ts";
import {
  cloudKeyName,
  createDemoVoice,
  demoVoiceScript,
  type VoiceBackend,
  type VoiceStatus,
} from "../lib/voice/client.ts";
import { memorySecureStore } from "./session_helpers.ts";

const okStatus: VoiceStatus = {
  lib: { ok: true, version: "rullama-audio-ffi 0.1.0", path: "/x" },
  model: { state: "ready", label: "Whisper", size: "57 MB" },
};

function fakeVoice(
  status: VoiceStatus,
  kind: "desktop" | "demo" = "desktop",
): VoiceBackend & { started: string[] } {
  const started: string[] = [];
  return {
    ...createDemoVoice(),
    kind,
    started,
    status: () => Promise.resolve(status),
    sttStart: (engine) => {
      started.push(engine);
      return Promise.resolve();
    },
  };
}

/** A key store with a Deepgram key or none (the page's view: set or not). */
const keys = (deepgram: string | null): KeyStore => ({
  has: (s) => Promise.resolve(s === "deepgram" && deepgram !== null),
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

Deno.test("native STT: a cloud engine needs a key; the page never passes it", async () => {
  const voice = fakeVoice(okStatus);
  const dg = nativeStt(voice, "deepgram", keys("dg-key"));
  assertEquals(await dg.probe(), { ok: true });
  await dg.start();
  // Only the engine: the extension reads the key from its own keychain entry.
  assertEquals(voice.started, ["deepgram"]);
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
  // Without a key store nothing is set.
  assertEquals(
    (await nativeStt(voice, "deepgram").probe()).ok,
    false,
  );
  assertEquals(cloudKeyName("deepgram"), "voice.deepgram.apiKey");
});

Deno.test("cloud keys: the demo backend sets, clears and reports keys, never returns them", async () => {
  const store = memorySecureStore();
  const voice = createDemoVoice(demoVoiceScript(), store);
  const page = backendKeys(voice);
  assertEquals(await voice.keyStatus(), { deepgram: false, elevenlabs: false });
  await page.set("deepgram", "  dg-secret  ");
  assertEquals(store.items.get("voice.deepgram.apiKey"), "dg-secret");
  assertEquals(await page.has("deepgram"), true);
  assertEquals(await page.has("elevenlabs"), false);
  // What the page can learn is a yes or no per service.
  assertEquals(await voice.keyStatus(), { deepgram: true, elevenlabs: false });
  assert(!JSON.stringify(await voice.keyStatus()).includes("dg-secret"));
  await assertRejects(
    () => page.set("elevenlabs", "two words"),
    Error,
    "space",
  );
  await page.remove("deepgram");
  assertEquals(store.items.size, 0);
  assertEquals(await page.has("deepgram"), false);
});

Deno.test("cloud TTS: needs a saved Deepgram key, and sends no key with the text", async () => {
  const said: [string, unknown][] = [];
  const voice: VoiceBackend = {
    ...createDemoVoice(),
    kind: "desktop",
    speak: (text, opts) => {
      said.push([text, opts]);
      return Promise.resolve();
    },
  };
  await assertRejects(
    () => cloudTts(voice, keys(null)).speak("hi", {}),
    Error,
    "no Deepgram key",
  );
  await cloudTts(voice, keys("k")).speak("hello", { voice: "aura-luna-en" });
  assertEquals(said, [["hello", { model: "aura-luna-en" }]]);
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
  await assertRejects(() => voice.speak("x", {}));

  script.msPerChar = 1000;
  const tts = demoTts(script);
  const said = tts.speak("a long sentence", {});
  await tts.stop();
  await said;
  assertEquals(script.spoken, ["a long sentence"]);
  assertEquals(script.stops, 1);
});
