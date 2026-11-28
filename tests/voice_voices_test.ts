// The OS voice list (lib/voice/voices.ts): each voice's tier, kind and language from what macOS
// (AVSpeechSynthesisVoice identifiers, as WebKit reports them), Chromium and Linux give; the
// picker's groups (the user's language, their region first, best first; other languages and the
// character voices on request; the stored voice always shown), the macOS "better voices" check,
// and finding a voice saved by name before ids were stored.
//
// tests/fixtures/voice/macos-voices.json is AVSpeechSynthesisVoice.speechVoices() on a stock
// macOS 27.2 (no voices downloaded): compact, super-compact, Eloquence, the novelty voices, a
// Siri voice, in 40-odd languages. Premium and Enhanced voices are added below by their documented
// ids (`com.apple.voice.premium.<lang>.<Name>`, `com.apple.voice.enhanced.<lang>.<Name>`).

import { assert, assertEquals } from "@std/assert";
import {
  baseLanguage,
  classifyVoice,
  classifyVoices,
  findVoice,
  normalizeLang,
  type RawVoice,
  storedVoiceId,
  voiceDisplayName,
  voiceKind,
  voiceList,
  voiceTier,
} from "../lib/voice/voices.ts";

const MACOS: RawVoice[] = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/voice/macos-voices.json", import.meta.url),
  ),
);

/** A Premium and two Enhanced voices, as macOS lists them once downloaded. */
const DOWNLOADED: RawVoice[] = [
  {
    voiceURI: "com.apple.voice.premium.en-US.Zoe",
    name: "Zoe (Premium)",
    lang: "en-US",
  },
  {
    voiceURI: "com.apple.voice.enhanced.en-US.Evan",
    name: "Evan (Enhanced)",
    lang: "en-US",
  },
  {
    voiceURI: "com.apple.voice.enhanced.en-GB.Serena",
    name: "Serena",
    lang: "en-GB",
  },
  {
    voiceURI: "com.apple.voice.premium.de-DE.Anna",
    name: "Anna",
    lang: "de-DE",
  },
];

/** Chromium on macOS: the id is the name, Eloquence names carry their language. */
const CHROMIUM_MAC: RawVoice[] = [
  { voiceURI: "Samantha", name: "Samantha", lang: "en-US" },
  { voiceURI: "Evan (Enhanced)", name: "Evan (Enhanced)", lang: "en-US" },
  { voiceURI: "Bells", name: "Bells", lang: "en-US" },
  { voiceURI: "Bad News", name: "Bad News", lang: "en-US" },
  {
    voiceURI: "Eddy (English (US))",
    name: "Eddy (English (US))",
    lang: "en-US",
  },
  {
    voiceURI: "Eddy (German (Germany))",
    name: "Eddy (German (Germany))",
    lang: "de-DE",
  },
  { voiceURI: "Google US English", name: "Google US English", lang: "en-US" },
  { voiceURI: "Google Deutsch", name: "Google Deutsch", lang: "de-DE" },
];

/** Chromium on Linux (speech-dispatcher, eSpeak NG). */
const CHROMIUM_LINUX: RawVoice[] = [
  { voiceURI: "English (America)", name: "English (America)", lang: "en-US" },
  {
    voiceURI: "English (Great Britain)",
    name: "English (Great Britain)",
    lang: "en-GB",
  },
  { voiceURI: "German", name: "German", lang: "de" },
  { voiceURI: "French (France)", name: "French (France)", lang: "fr-FR" },
  { voiceURI: "Sandy", name: "Sandy", lang: "en_US" },
  { voiceURI: "Mystery", name: "Mystery", lang: "" },
];

const labels = (list: ReturnType<typeof voiceList>) =>
  list.groups.map((g) => [g.heading, g.voices.map((v) => v.label)]);

Deno.test("tier: premium and enhanced ids, the name suffixes, Siri; the rest standard", () => {
  const tier = (voiceURI: string, name = "X") => voiceTier({ voiceURI, name });
  assertEquals(tier("com.apple.voice.premium.en-US.Zoe"), "premium");
  assertEquals(tier("com.apple.voice.enhanced.en-US.Evan"), "enhanced");
  assertEquals(tier("com.apple.voice.compact.en-US.Samantha"), "standard");
  assertEquals(
    tier("com.apple.voice.super-compact.en-GB.Daniel"),
    "standard",
  );
  assertEquals(tier("com.apple.voice.Aman"), "standard");
  assertEquals(tier("com.apple.speech.synthesis.voice.Fred"), "standard");
  assertEquals(tier("com.apple.eloquence.en-US.Eddy"), "standard");
  assertEquals(tier("com.apple.siri.natural.Aaron"), "enhanced");
  assertEquals(tier("Evan (Enhanced)", "Evan (Enhanced)"), "enhanced");
  assertEquals(tier("Zoe (Premium)", "Zoe (Premium)"), "premium");
  assertEquals(tier("English (America)", "English (America)"), "standard");
  assertEquals(tier("Google US English", "Google US English"), "standard");
});

Deno.test("kind: the novelty voices (old and new ids, by name in Chromium) and Eloquence are characters", () => {
  const kind = (voiceURI: string, name: string) =>
    voiceKind({ voiceURI, name });
  for (
    const id of [
      "Albert",
      "BadNews",
      "Bahh",
      "Bells",
      "Boing",
      "Bubbles",
      "Cellos",
      "Deranged",
      "GoodNews",
      "Hysterical",
      "Organ",
      "Princess",
      "Trinoids",
      "Whisper",
      "Zarvox",
    ]
  ) {
    assertEquals(
      kind(`com.apple.speech.synthesis.voice.${id}`, id),
      "character",
      id,
    );
  }
  for (const id of ["Fred", "Kathy", "Ralph", "Junior"]) {
    assertEquals(kind(`com.apple.speech.synthesis.voice.${id}`, id), "voice");
  }
  assertEquals(kind("com.apple.eloquence.en-US.Eddy", "Eddy"), "character");
  assertEquals(
    kind("com.apple.eloquence.fr-FR.Jacques", "Jacques"),
    "character",
  );
  assertEquals(
    kind("com.apple.voice.compact.en-US.Samantha", "Samantha"),
    "voice",
  );
  // Chromium: by name.
  assertEquals(kind("Bad News", "Bad News"), "character");
  assertEquals(kind("Superstar", "Superstar"), "character");
  assertEquals(kind("Eddy (English (US))", "Eddy (English (US))"), "character");
  // A plain "Sandy" from another engine is not taken for Eloquence.
  assertEquals(kind("Sandy", "Sandy"), "voice");
  assertEquals(kind("Samantha", "Samantha"), "voice");
});

Deno.test("names, languages and labels", () => {
  assertEquals(voiceDisplayName("Evan (Enhanced)"), "Evan");
  assertEquals(voiceDisplayName("Zoe (Premium)"), "Zoe");
  assertEquals(voiceDisplayName("Eddy (English (US))"), "Eddy");
  assertEquals(voiceDisplayName("English (America)"), "English (America)");
  assertEquals(normalizeLang("en_US"), "en-US");
  assertEquals(normalizeLang("not a tag!"), "");
  assertEquals(baseLanguage("yue-HK"), "yue");
  const zoe = classifyVoice(DOWNLOADED[0], "en-US");
  assertEquals(zoe.id, "com.apple.voice.premium.en-US.Zoe");
  assertEquals(zoe.label, "Zoe — Premium · US English");
  assertEquals(zoe.localeName, "English (United States)");
  const eddy = classifyVoice(
    { voiceURI: "com.apple.eloquence.de-DE.Eddy", name: "Eddy", lang: "de-DE" },
    "en-US",
  );
  assertEquals(eddy.label, "Eddy — Character · German (Germany)");
  const majed = classifyVoice(
    {
      voiceURI: "com.apple.voice.compact.ar-001.Maged",
      name: "Majed",
      lang: "ar-001",
    },
    "en-US",
  );
  assertEquals(majed.localeName, "Modern Standard Arabic");
  const none = classifyVoice({ voiceURI: "x", name: "Mystery", lang: "" });
  assertEquals(none.label, "Mystery — Standard");
  assertEquals(storedVoiceId({ voiceURI: "", name: "Bob" }), "Bob");
  assertEquals(
    storedVoiceId({ voiceURI: "u".repeat(129), name: "Bob" }),
    "Bob",
  );
});

Deno.test("macOS: duplicates folded (compact over super-compact, one per id)", () => {
  const voices = classifyVoices([...MACOS, MACOS[0]], "en-US");
  const samantha = voices.filter((v) => v.name === "Samantha");
  assertEquals(samantha.map((v) => v.voiceURI), [
    "com.apple.voice.compact.en-US.Samantha",
  ]);
  // Listed super-compact first, then compact: the compact one stays.
  const lesya = classifyVoices(
    MACOS.filter((v) => v.name === "Lesya").reverse(),
  );
  assertEquals(lesya.length, 1);
  assertEquals(lesya[0].aliases, ["com.apple.voice.super-compact.uk-UA.Lesya"]);
  assertEquals(lesya.map((v) => v.voiceURI), [
    "com.apple.voice.compact.uk-UA.Lesya",
  ]);
  // A folded copy's id still finds its voice (a setting saved with it).
  assertEquals(
    findVoice(voices, "com.apple.voice.super-compact.uk-UA.Lesya")?.voiceURI,
    "com.apple.voice.compact.uk-UA.Lesya",
  );
  assertEquals(
    findVoice(voices, "com.apple.voice.super-compact.en-US.Samantha")?.voiceURI,
    "com.apple.voice.compact.en-US.Samantha",
  );
  // Every Eloquence voice stays: one per language.
  assertEquals(voices.filter((v) => v.name === "Eddy").length, 14);
});

Deno.test("macOS, en-US: the user's language only, their region first, best first, characters hidden", () => {
  const voices = classifyVoices([...MACOS, ...DOWNLOADED], "en-US");
  const list = voiceList(voices, { userLang: "en-US" });
  const groups = labels(list);
  assertEquals(groups[0][0], "English (United States)");
  assertEquals(groups[0][1].slice(0, 3), [
    "Zoe — Premium · US English",
    "Evan — Enhanced · US English",
    "Voice 1 — Enhanced · US English",
  ]);
  // Then standard voices, alphabetical: Fred, Junior, Kathy, Ralph, Samantha.
  assertEquals(groups[0][1].slice(3), [
    "Fred — Standard · US English",
    "Junior — Standard · US English",
    "Kathy — Standard · US English",
    "Ralph — Standard · US English",
    "Samantha — Standard · US English",
  ]);
  // The other English regions, by name; no other language, no character voice.
  assertEquals(groups.slice(1).map((g) => g[0]), [
    "English (Australia)",
    "English (India)",
    "English (Ireland)",
    "English (South Africa)",
    "English (United Kingdom)",
  ]);
  assertEquals(groups.at(-1)![1], [
    "Serena — Enhanced · UK English",
    "Daniel — Standard · UK English",
  ]);
  assert(list.groups.every((g) => g.kind === "voice"));
  assert(
    list.groups.flatMap((g) => g.voices).every((v) => v.language === "en"),
  );
  assertEquals(list.otherLanguages, 46);
  // 15 novelty voices plus 8 Eloquence voices each in en-US and en-GB.
  assertEquals(list.characters, 31);
  assert(list.hasBetterVoice);
});

Deno.test("macOS: a region first even when it is not the US", () => {
  const voices = classifyVoices([...MACOS, ...DOWNLOADED], "en-GB");
  const list = voiceList(voices, { userLang: "en-GB" });
  assertEquals(list.groups[0].heading, "English (United Kingdom)");
  assertEquals(list.groups[1].heading, "English (Australia)");
});

Deno.test("macOS: character voices at the bottom, one group; with all languages, one per language", () => {
  const voices = classifyVoices(MACOS, "en-US");
  const list = voiceList(voices, { userLang: "en-US", showCharacters: true });
  const last = list.groups.at(-1)!;
  assertEquals(last.heading, "Character voices");
  assertEquals(last.kind, "character");
  assertEquals(last.voices.length, 31);
  // Within it: by region, then name.
  assertEquals(last.voices[0].label, "Eddy — Character · UK English");
  assert(last.voices.some((v) => v.name === "Jester"));
  assert(last.voices.some((v) => v.name === "Superstar"));
  assert(!list.groups.slice(0, -1).some((g) => g.kind === "character"));

  const all = voiceList(voices, {
    userLang: "en-US",
    showAll: true,
    showCharacters: true,
  });
  const headings = all.groups.map((g) => g.heading);
  const firstChar = all.groups.findIndex((g) => g.kind === "character");
  assert(all.groups.slice(firstChar).every((g) => g.kind === "character"));
  assertEquals(headings[firstChar], "Character voices · English");
  assert(headings.includes("Character voices · German"));
  assert(headings.includes("Character voices · French"));
  // Other languages: one heading each, after the user's, alphabetical.
  const languages = all.groups.filter((g) => g.key.startsWith("lang:"))
    .map((g) => g.heading);
  assertEquals(languages, [...languages].sort((a, b) => a.localeCompare(b)));
  assert(languages.includes("German"));
  assert(languages.includes("Cantonese"));
  const firstLang = all.groups.findIndex((g) => g.key.startsWith("lang:"));
  assert(
    all.groups.slice(0, firstLang).every((g) => g.key.startsWith("loc:en")),
  );
});

Deno.test("macOS: no Premium or Enhanced voice for the language → no better voice", () => {
  const voices = classifyVoices(MACOS, "fr-FR");
  assert(!voiceList(voices, { userLang: "fr-FR" }).hasBetterVoice);
  // en-US has the Siri voice (AVSpeechSynthesis calls it Enhanced).
  assert(
    voiceList(classifyVoices(MACOS), { userLang: "en-US" }).hasBetterVoice,
  );
  const noSiri = MACOS.filter((v) => !v.voiceURI.startsWith("com.apple.siri."));
  assert(
    !voiceList(classifyVoices(noSiri), { userLang: "en-US" }).hasBetterVoice,
  );
  // A downloaded voice in another language does not count.
  assert(
    !voiceList(classifyVoices([...noSiri, DOWNLOADED[3]]), {
      userLang: "en-US",
    })
      .hasBetterVoice,
  );
});

Deno.test("the stored voice stays visible: another language, a character voice", () => {
  const voices = classifyVoices(MACOS, "en-US");
  const anna = "com.apple.voice.super-compact.de-DE.Anna";
  const list = voiceList(voices, { userLang: "en-US", selected: anna });
  assertEquals(list.selected?.id, anna);
  const german = list.groups.find((g) => g.key === "lang:de")!;
  assertEquals(german.heading, "German");
  assertEquals(german.voices.map((v) => v.id), [anna]);

  const zarvox = "com.apple.speech.synthesis.voice.Zarvox";
  const z = voiceList(voices, { userLang: "en-US", selected: zarvox });
  assertEquals(z.groups.at(-1)!.voices.map((v) => v.id), [zarvox]);
});

Deno.test("a voice saved by name (before ids were stored) is found", () => {
  const voices = classifyVoices(MACOS, "en-US");
  // The first with that name, as speak() picks it.
  assertEquals(
    findVoice(voices, "Eddy")?.voiceURI,
    "com.apple.eloquence.en-US.Eddy",
  );
  assertEquals(
    findVoice(voices, "Samantha")?.voiceURI,
    "com.apple.voice.compact.en-US.Samantha",
  );
  assertEquals(
    findVoice(voices, "com.apple.eloquence.de-DE.Eddy")?.lang,
    "de-DE",
  );
  assertEquals(findVoice(voices, "Nobody"), undefined);
  assertEquals(findVoice(voices, ""), undefined);
  const withZoe = classifyVoices(DOWNLOADED);
  assertEquals(findVoice(withZoe, "Zoe (Premium)")?.name, "Zoe");
});

Deno.test("Chromium on macOS: by name, the language suffix dropped", () => {
  const voices = classifyVoices(CHROMIUM_MAC, "en-US");
  const list = voiceList(voices, { userLang: "en-US", showCharacters: true });
  assertEquals(labels(list), [
    ["English (United States)", [
      "Evan — Enhanced · US English",
      "Google US English — Standard · US English",
      "Samantha — Standard · US English",
    ]],
    ["Character voices", [
      "Bad News — Character · US English",
      "Bells — Character · US English",
      "Eddy — Character · US English",
    ]],
  ]);
  assertEquals(list.otherLanguages, 1);
  assertEquals(list.characters, 3);
});

Deno.test("Chromium on Linux: unknown tiers are Standard, odd tags still sort", () => {
  const voices = classifyVoices(CHROMIUM_LINUX, "en-US");
  assert(voices.every((v) => v.tier === "standard" && v.kind === "voice"));
  const list = voiceList(voices, { userLang: "en-US" });
  assertEquals(labels(list), [
    ["English (United States)", [
      "English (America) — Standard · US English",
      "Sandy — Standard · US English",
    ]],
    ["English (United Kingdom)", [
      "English (Great Britain) — Standard · UK English",
    ]],
  ]);
  assert(!list.hasBetterVoice);
  const all = voiceList(voices, { userLang: "en-US", showAll: true });
  assertEquals(all.groups.map((g) => g.heading), [
    "English (United States)",
    "English (United Kingdom)",
    "French",
    "German",
    "Unknown language",
  ]);
  // A bare language and a missing navigator language.
  assertEquals(
    voiceList(voices, { userLang: "de" }).groups.map((g) => g.heading),
    ["German"],
  );
  assertEquals(
    voiceList(voices, { userLang: "" }).groups[0].heading,
    "English (United States)",
  );
});
