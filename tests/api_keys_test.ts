// The API keys the desktop extensions keep in their own secure-store namespace
// (lib/secrets/api-keys.ts), over an in-memory fake store (never the OS keychain): what a key may
// look like, set / clear / presence, the store keys the voice and hub extensions use, and that the
// page's view (presence) never carries a key.

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { API_KEY_MAX, ApiKeys, checkApiKey } from "../lib/secrets/api-keys.ts";
import { voiceKeys } from "../lib/voice/client.ts";
import { companionKeys } from "../lib/companion/keys.ts";
import { HubService } from "../desktop/hub.ts";
import { memorySecureStore } from "./session_helpers.ts";

Deno.test("checkApiKey: trimmed, not empty, not too long, no space or control character", () => {
  assertEquals(checkApiKey("  sk-ant-abc123  "), "sk-ant-abc123");
  assertEquals(checkApiKey("k\n"), "k");
  assertThrows(() => checkApiKey(""), Error, "empty");
  assertThrows(() => checkApiKey("   "), Error, "empty");
  assertThrows(() => checkApiKey(42), Error, "text");
  assertThrows(() => checkApiKey("two words"), Error, "space");
  assertThrows(() => checkApiKey("a\nb"), Error, "line break");
  assertThrows(() => checkApiKey("a\u0000b"), Error);
  assertEquals(checkApiKey("x".repeat(API_KEY_MAX)).length, API_KEY_MAX);
  assertThrows(() => checkApiKey("x".repeat(API_KEY_MAX + 1)), Error, "longer");
});

Deno.test("ApiKeys: set, presence, get, clear, in the store under each service's name", async () => {
  const store = memorySecureStore();
  const keys = new ApiKeys(() => store, ["a", "b"] as const, (s) => `t.${s}`);
  assertEquals(await keys.presence(), { a: false, b: false });
  await keys.set("a", " secret-a ");
  assertEquals([...store.items], [["t.a", "secret-a"]]);
  assertEquals(await keys.presence(), { a: true, b: false });
  assertEquals(await keys.get("a"), "secret-a");
  assertEquals(await keys.get("b"), null);
  // A refused key leaves the saved one alone.
  await assertRejects(() => keys.set("a", "bad key"), Error, "space");
  assertEquals(await keys.get("a"), "secret-a");
  await keys.set("a", "secret-2");
  assertEquals(await keys.get("a"), "secret-2");
  await keys.clear("a");
  await keys.clear("a"); // nothing to clear: still fine
  assertEquals(store.items.size, 0);
  // A service outside the list is refused before the store is reached.
  await assertRejects(
    () => keys.set("c" as "a", "k"),
    Error,
    "no key is kept for c",
  );
  // An empty value in the store reads as no key.
  store.items.set("t.b", "");
  assertEquals(await keys.get("b"), null);
});

Deno.test("ApiKeys: without a store every call says the keychain is not available", async () => {
  const keys = new ApiKeys(() => undefined, ["a"] as const, (s) => s);
  await assertRejects(() => keys.presence(), Error, "keychain");
  await assertRejects(() => keys.set("a", "k"), Error, "keychain");
  await assertRejects(() => keys.clear("a"), Error, "keychain");
});

Deno.test("the voice and hub extensions' key names, and what the page may see", async () => {
  const voiceStore = memorySecureStore();
  const voice = voiceKeys(() => voiceStore);
  await voice.set("deepgram", "dg");
  await voice.set("elevenlabs", "el");
  assertEquals([...voiceStore.items.keys()].sort(), [
    "voice.deepgram.apiKey",
    "voice.elevenlabs.apiKey",
  ]);
  const presence = await voice.presence();
  assertEquals(presence, { deepgram: true, elevenlabs: true });
  assertEquals(JSON.stringify(presence).includes("dg"), false);

  const hubStore = memorySecureStore();
  const companion = companionKeys(() => hubStore);
  await companion.set("anthropic", "sk-ant-x");
  assertEquals([...hubStore.items], [[
    "companion.anthropic.apiKey",
    "sk-ant-x",
  ]]);
  assertEquals(await companion.presence(), { anthropic: true });
});

Deno.test("HubService: the companion's key lives in the store it is given", async () => {
  const store = memorySecureStore();
  const hub = new HubService({
    home: "/nonexistent-home",
    socketDir: "/nonexistent-sockets",
    emit: () => {},
    secureStore: () => store,
  });
  assertEquals(await hub.keys.presence(), { anthropic: false });
  await hub.keys.set("anthropic", "sk-ant-test");
  assertEquals(store.items.get("companion.anthropic.apiKey"), "sk-ant-test");
  assertEquals(await hub.keys.presence(), { anthropic: true });
  await hub.keys.clear("anthropic");
  assertEquals(store.items.size, 0);

  // Without a store (the extension is not set up), the key methods say so.
  const bare = new HubService({
    home: "/nonexistent-home",
    socketDir: "/nonexistent-sockets",
    emit: () => {},
  });
  await assertRejects(() => bare.keys.presence(), Error, "keychain");
});
