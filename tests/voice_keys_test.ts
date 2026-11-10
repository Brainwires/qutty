// The voice extension (desktop/voice.ts) keeps the cloud keys in its own secure store: its key
// methods over an in-memory fake store (never the OS keychain), and a cloud capture or Deepgram
// speech refused before anything else happens when no key is saved. No audio library, microphone
// or network is touched.

import { assertEquals, assertRejects } from "@std/assert";
import type { DesktopExtensionHost } from "denext/desktop";
import voice from "../desktop/voice.ts";
import { fakeExtensionHost, memorySecureStore } from "./session_helpers.ts";
import { schemaTesters } from "./schema_helpers.ts";

const m = voice.methods;

Deno.test("voice extension: keys go to its own store; the page learns only whether one is set", async () => {
  const store = memorySecureStore();
  const fake = fakeExtensionHost();
  voice.setup!({ ...fake.host, secureStore: store } as DesktopExtensionHost);

  assertEquals(await m.keyStatus.handler(), {
    deepgram: false,
    elevenlabs: false,
  });
  // Without a key, a cloud engine is refused before the library or the microphone is reached.
  await assertRejects(
    () => m.sttStart.handler({ engine: "deepgram" }),
    Error,
    "no Deepgram key (Settings → Voice)",
  );
  await assertRejects(
    () => m.speak.handler({ text: "hello" }),
    Error,
    "no Deepgram key",
  );

  await m.keySet.handler({ service: "deepgram", key: " dg-secret " });
  assertEquals([...store.items], [["voice.deepgram.apiKey", "dg-secret"]]);
  assertEquals(await m.keyStatus.handler(), {
    deepgram: true,
    elevenlabs: false,
  });
  // A malformed key is refused with a message the page can show; the saved one stays.
  await assertRejects(
    () => m.keySet.handler({ service: "deepgram", key: "two words" }),
    Error,
    "space",
  );
  assertEquals(store.items.get("voice.deepgram.apiKey"), "dg-secret");

  await m.keyClear.handler({ service: "deepgram" });
  assertEquals(store.items.size, 0);
  assertEquals(await m.keyStatus.handler(), {
    deepgram: false,
    elevenlabs: false,
  });
});

Deno.test("voice extension: the key methods take only a known service; a capture takes no key", () => {
  const { ok, bad } = schemaTesters(voice);
  bad("keySet", { service: "openai", key: "k" }, ["service"]);
  bad("keySet", { service: "deepgram" }, ["key"]);
  ok("keySet", { service: "elevenlabs", key: "k" });
  bad("keyClear", {}, ["service"]);
  ok("keyClear", { service: "deepgram" });
  ok("keyStatus", {});
  assertEquals(ok("sttStart", { engine: "deepgram", key: "ignored" }), {
    engine: "deepgram",
  });
  assertEquals(ok("speak", { text: "hi", key: "ignored" }), { text: "hi" });
});
