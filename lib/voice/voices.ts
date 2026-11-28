/**
 * The OS voice list for Settings → Voice: each `speechSynthesis` voice classified (quality tier,
 * whether it is a novelty "character" voice, its language and region), then filtered and ordered
 * for the picker: the user's language first (their region, then the language's other regions),
 * the best voices first within a region, other languages and character voices only on request.
 *
 * What macOS reports (AVSpeechSynthesisVoice identifiers, which WebKit passes on as `voiceURI`):
 *
 * - `com.apple.voice.premium.<lang>.<Name>`: Premium (downloaded in System Settings).
 * - `com.apple.voice.enhanced.<lang>.<Name>`: Enhanced. Chromium names these "Name (Enhanced)".
 * - `com.apple.voice.compact.<lang>.<Name>`, `com.apple.voice.super-compact.<lang>.<Name>`,
 *   `com.apple.voice.<Name>`, `com.apple.speech.synthesis.voice.<Name>` (Fred, Kathy, Ralph,
 *   Junior): Standard. A compact and a super-compact copy of one voice show as one.
 * - `com.apple.siri.natural.<Name>` ("Voice 1"…): AVSpeechSynthesis reports these as Enhanced.
 * - `com.apple.speech.synthesis.voice.<Id>` for the novelty voices, some under an older id than
 *   their name: Albert, BadNews, Bahh, Bells, Boing, Bubbles, Cellos, Deranged (Wobble), GoodNews,
 *   Hysterical (Jester), Organ, Princess (Superstar), Trinoids, Whisper, Zarvox: characters.
 * - `com.apple.eloquence.<lang>.<Name>` (Eddy, Flo, Grandma, Grandpa, Reed, Rocko, Sandy,
 *   Shelley), listed once per language: characters.
 *
 * Elsewhere (Chromium, Windows, Linux) a voice's tier is unknown and counts as Standard.
 *
 * Pure: the voices and locales are passed in.
 *
 * @module
 */

/** A voice as `speechSynthesis.getVoices()` describes it. */
export interface RawVoice {
  name: string;
  voiceURI: string;
  lang: string;
  default?: boolean;
}

/** How good a voice sounds: Premium and Enhanced are the downloadable neural/large voices. */
export type VoiceTier = "premium" | "enhanced" | "standard";

/** A real voice, or a novelty one (macOS's Bells, Zarvox, the Eloquence voices). */
export type VoiceKind = "voice" | "character";

/** A classified voice. */
export interface VoiceInfo {
  /** What to store and pass to `speak()`: its `voiceURI` (its name when that is unusable). */
  id: string;
  /** The name to show (without "(Enhanced)" or a language suffix). */
  name: string;
  /** The name as reported. */
  rawName: string;
  voiceURI: string;
  /** The ids of copies folded into this one (a super-compact copy of a compact voice). */
  aliases: string[];
  /** The BCP 47 tag (`en-US`), or `""` when the engine gives none. */
  lang: string;
  /** The language subtag (`en`), or `""`. */
  language: string;
  tier: VoiceTier;
  kind: VoiceKind;
  /** The language's name: "English". */
  languageName: string;
  /** The language and region: "English (United States)". */
  localeName: string;
  /** The short form: "US English". */
  shortLocale: string;
  /** The option's label: "Zoe — Premium · US English". */
  label: string;
}

/** A heading in the picker and its voices, in order. */
export interface VoiceGroup {
  /** Stable: `loc:en-US`, `lang:de`, `char:en`. */
  key: string;
  heading: string;
  kind: VoiceKind;
  voices: VoiceInfo[];
}

/** What the picker shows. */
export interface VoiceList {
  groups: VoiceGroup[];
  /** The stored voice, found (by `voiceURI`, or by name for settings saved before). */
  selected: VoiceInfo | undefined;
  /** Voices of other languages (characters not counted), hidden unless `showAll`. */
  otherLanguages: number;
  /** Character voices in scope (the user's language, or all with `showAll`). */
  characters: number;
  /** Whether a Premium or Enhanced voice speaks the user's language. */
  hasBetterVoice: boolean;
}

export interface VoiceListOptions {
  /** The user's language (`navigator.language`): `en-US`. */
  userLang: string;
  /** Show every language, grouped by language. */
  showAll?: boolean;
  /** Show the character voices (a group at the bottom). */
  showCharacters?: boolean;
  /** The stored voice (`voiceURI` or name); always shown. */
  selected?: string;
}

/** The settings field's longest value (lib/voice/settings.ts). */
const MAX_ID = 128;

/** macOS's novelty voices by the last part of their `com.apple.speech.synthesis.voice.` id. */
const NOVELTY_IDS = new Set([
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
]);

/** The same voices by name (current names, and the names older macOS gave them). */
const NOVELTY_NAMES = new Set([
  "Albert",
  "Bad News",
  "Bahh",
  "Bells",
  "Boing",
  "Bubbles",
  "Cellos",
  "Good News",
  "Jester",
  "Organ",
  "Superstar",
  "Trinoids",
  "Whisper",
  "Wobble",
  "Zarvox",
  "Deranged",
  "Hysterical",
  "Pipe Organ",
  "Princess",
]);

/** The Eloquence voices (`com.apple.eloquence.<lang>.<Name>`). */
const ELOQUENCE_NAMES = new Set([
  "Eddy",
  "Flo",
  "Grandma",
  "Grandpa",
  "Reed",
  "Rocko",
  "Sandy",
  "Shelley",
]);

const SPEECH_SYNTHESIS_VOICE = "com.apple.speech.synthesis.voice.";

/** "Eddy (English (US))" (Chromium on macOS): the language suffix. */
const LANG_SUFFIX = /\s+\([^()]*\([^()]*\)\)$/;
/** "Evan (Enhanced)", "Zoe (Premium)". */
const TIER_SUFFIX = /\s+\((enhanced|premium)\)$/i;

/** `lang` as a canonical BCP 47 tag (`en_US` → `en-US`), or `""`. */
export function normalizeLang(lang: string): string {
  const tag = lang.trim().replace(/_/g, "-");
  if (!tag) return "";
  try {
    return new Intl.Locale(tag).toString();
  } catch {
    return "";
  }
}

/** The language subtag of a tag (`en-US` → `en`), or `""`. */
export function baseLanguage(lang: string): string {
  const tag = normalizeLang(lang);
  if (!tag) return "";
  try {
    return new Intl.Locale(tag).language;
  } catch {
    return "";
  }
}

/** A voice's quality tier. */
export function voiceTier(v: Pick<RawVoice, "name" | "voiceURI">): VoiceTier {
  const uri = v.voiceURI;
  if (uri.startsWith("com.apple.voice.premium.")) return "premium";
  if (uri.startsWith("com.apple.voice.enhanced.")) return "enhanced";
  if (uri.startsWith("com.apple.siri.")) return "enhanced";
  const tier = TIER_SUFFIX.exec(v.name.replace(LANG_SUFFIX, ""))?.[1];
  if (tier) return tier.toLowerCase() as VoiceTier;
  return "standard";
}

/** Whether a voice is a novelty (character) voice. */
export function voiceKind(v: Pick<RawVoice, "name" | "voiceURI">): VoiceKind {
  const uri = v.voiceURI;
  if (uri.startsWith("com.apple.eloquence.")) return "character";
  if (uri.startsWith(SPEECH_SYNTHESIS_VOICE)) {
    return NOVELTY_IDS.has(uri.slice(SPEECH_SYNTHESIS_VOICE.length))
      ? "character"
      : "voice";
  }
  // Chromium on macOS: the id is the name ("Bells", "Eddy (English (US))").
  if (uri === v.name || uri === "") {
    const name = v.name.replace(LANG_SUFFIX, "");
    if (NOVELTY_NAMES.has(name)) return "character";
    if (LANG_SUFFIX.test(v.name) && ELOQUENCE_NAMES.has(name)) {
      return "character";
    }
  }
  return "voice";
}

/** The name to show: no tier or language suffix. */
export function voiceDisplayName(name: string): string {
  const shown = name.replace(LANG_SUFFIX, "").replace(TIER_SUFFIX, "").trim();
  return shown || name;
}

/** What to store for a voice: its `voiceURI` where usable, else its name. */
export function storedVoiceId(v: Pick<RawVoice, "name" | "voiceURI">): string {
  return v.voiceURI && v.voiceURI.length <= MAX_ID ? v.voiceURI : v.name;
}

const TIER_LABEL: Record<VoiceTier, string> = {
  premium: "Premium",
  enhanced: "Enhanced",
  standard: "Standard",
};

const TIER_RANK: Record<VoiceTier, number> = {
  premium: 0,
  enhanced: 1,
  standard: 2,
};

interface Names {
  standard: Intl.DisplayNames | undefined;
  short: Intl.DisplayNames | undefined;
  region: Intl.DisplayNames | undefined;
}

function displayNames(locale: string): Names {
  const make = (o: Intl.DisplayNamesOptions) => {
    try {
      return new Intl.DisplayNames([locale || "en", "en"], o);
    } catch {
      return undefined;
    }
  };
  return {
    standard: make({ type: "language", languageDisplay: "standard" }),
    short: make({ type: "language", style: "short" }),
    region: make({ type: "region" }),
  };
}

function nameOf(dn: Intl.DisplayNames | undefined, code: string): string {
  try {
    return dn?.of(code) ?? code;
  } catch {
    return code;
  }
}

const NUMERIC = /\d{3}/;

/**
 * "English (United States)"; for a numeric region (`ar-001`, `es-419`) the dialect's name
 * ("Modern Standard Arabic", "Latin American Spanish"), else the region's, else the language's.
 */
function localeNameOf(names: Names, lang: string): string {
  if (!lang) return "Unknown language";
  const named = nameOf(names.standard, lang);
  if (!NUMERIC.test(named)) return named;
  const short = nameOf(names.short, lang);
  if (!NUMERIC.test(short)) return short;
  const locale = new Intl.Locale(lang);
  const language = nameOf(names.standard, locale.language);
  const region = locale.region ? nameOf(names.region, locale.region) : "";
  return region && !NUMERIC.test(region) ? `${language} (${region})` : language;
}

/** Classify one voice (`displayLocale` names the languages). */
export function classifyVoice(v: RawVoice, displayLocale = "en"): VoiceInfo {
  return classify(v, displayNames(displayLocale));
}

function classify(v: RawVoice, names: Names): VoiceInfo {
  const lang = normalizeLang(v.lang);
  const language = baseLanguage(lang);
  const tier = voiceTier(v);
  const kind = voiceKind(v);
  const name = voiceDisplayName(v.name);
  const languageName = language
    ? nameOf(names.standard, language)
    : "Unknown language";
  const localeName = localeNameOf(names, lang);
  const shortLocale = lang ? nameOf(names.short, lang) : languageName;
  const what = kind === "character" ? "Character" : TIER_LABEL[tier];
  return {
    id: storedVoiceId(v),
    name,
    rawName: v.name,
    aliases: [],
    voiceURI: v.voiceURI,
    lang,
    language,
    tier,
    kind,
    languageName,
    localeName,
    shortLocale,
    label: lang ? `${name} — ${what} · ${shortLocale}` : `${name} — ${what}`,
  };
}

/**
 * Every voice classified, in the order given, with duplicates dropped: the same voice listed
 * twice (one `voiceURI`), or a compact and a super-compact copy (one name, language and tier;
 * the compact one is kept).
 */
export function classifyVoices(
  voices: readonly RawVoice[],
  displayLocale = "en",
): VoiceInfo[] {
  const names = displayNames(displayLocale);
  const out: VoiceInfo[] = [];
  const byUri = new Set<string>();
  const byKey = new Map<string, number>();
  for (const raw of voices) {
    if (!raw || typeof raw.name !== "string") continue;
    const v = classify({
      name: raw.name,
      voiceURI: typeof raw.voiceURI === "string" ? raw.voiceURI : raw.name,
      lang: typeof raw.lang === "string" ? raw.lang : "",
    }, names);
    if (v.voiceURI && byUri.has(v.voiceURI)) continue;
    byUri.add(v.voiceURI);
    const key = `${v.rawName}\u0000${v.lang}\u0000${v.tier}\u0000${v.kind}`;
    const at = byKey.get(key);
    if (at !== undefined) {
      const kept = out[at];
      if (isSuperCompact(kept) && !isSuperCompact(v)) {
        out[at] = { ...v, aliases: [...kept.aliases, kept.id] };
      } else kept.aliases.push(v.id);
      continue;
    }
    byKey.set(key, out.length);
    out.push(v);
  }
  return out;
}

function isSuperCompact(v: VoiceInfo): boolean {
  return v.voiceURI.startsWith("com.apple.voice.super-compact.");
}

/** The stored voice among `voices`: by id or `voiceURI`, else (settings saved before) by name. */
export function findVoice(
  voices: readonly VoiceInfo[],
  stored: string | undefined,
): VoiceInfo | undefined {
  if (!stored) return undefined;
  return voices.find((v) => v.id === stored || v.voiceURI === stored) ??
    voices.find((v) => v.aliases.includes(stored)) ??
    voices.find((v) => v.rawName === stored) ??
    voices.find((v) => v.name === stored);
}

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

function byName(a: VoiceInfo, b: VoiceInfo): number {
  return collator.compare(a.name, b.name) || collator.compare(a.id, b.id);
}

function byTierThenName(a: VoiceInfo, b: VoiceInfo): number {
  return TIER_RANK[a.tier] - TIER_RANK[b.tier] || byName(a, b);
}

/**
 * The picker's groups for `voices` (as from {@linkcode classifyVoices}):
 *
 * - The user's language, one group per region: their region first, then the others by name;
 *   within a region Premium, Enhanced, Standard, then by name.
 * - With `showAll`, then one group per other language, by name (within it by region, tier, name).
 * - With `showCharacters`, then the character voices: one group, or one per language with
 *   `showAll`.
 *
 * The selected voice is always shown, in its own group, even when that group is filtered out.
 */
export function voiceList(
  voices: readonly VoiceInfo[],
  opts: VoiceListOptions,
): VoiceList {
  const userLang = normalizeLang(opts.userLang) || "en-US";
  const userLanguage = baseLanguage(userLang);
  const showAll = opts.showAll === true;
  const showCharacters = opts.showCharacters === true;
  const selected = findVoice(voices, opts.selected);
  const mine = (v: VoiceInfo) => v.language === userLanguage;

  const groups = new Map<string, VoiceGroup & { rank: number[] }>();
  const groupOf = (v: VoiceInfo) => {
    let key: string;
    let heading: string;
    let rank: number[];
    if (v.kind === "character") {
      key = `char:${v.language}`;
      heading = showAll || !mine(v)
        ? `Character voices · ${v.languageName}`
        : "Character voices";
      rank = [2, mine(v) ? 0 : 1];
    } else if (mine(v)) {
      key = `loc:${v.lang}`;
      heading = v.localeName;
      rank = [0, v.lang === userLang ? 0 : v.lang === userLanguage ? 2 : 1];
    } else {
      key = `lang:${v.language}`;
      heading = v.language ? v.languageName : "Unknown language";
      rank = [1, v.language ? 0 : 1];
    }
    let g = groups.get(key);
    if (!g) {
      g = { key, heading, kind: v.kind, voices: [], rank };
      groups.set(key, g);
    }
    return g;
  };

  let otherLanguages = 0;
  let characters = 0;
  let hasBetterVoice = false;
  for (const v of voices) {
    if (v.kind === "voice" && mine(v) && v.tier !== "standard") {
      hasBetterVoice = true;
    }
    if (v.kind === "voice" && !mine(v)) otherLanguages++;
    if (v.kind === "character" && (showAll || mine(v))) characters++;
    const inLanguage = showAll || mine(v);
    const inKind = v.kind === "voice" || showCharacters;
    if ((inLanguage && inKind) || v === selected) groupOf(v).voices.push(v);
  }

  const ordered = [...groups.values()].sort((a, b) => {
    for (let i = 0; i < Math.max(a.rank.length, b.rank.length); i++) {
      const d = (a.rank[i] ?? 0) - (b.rank[i] ?? 0);
      if (d) return d;
    }
    return collator.compare(a.heading, b.heading);
  });
  for (const g of ordered) {
    if (g.key.startsWith("loc:")) g.voices.sort(byTierThenName);
    else {
      g.voices.sort((a, b) =>
        collator.compare(a.localeName, b.localeName) ||
        (g.kind === "voice" ? byTierThenName(a, b) : byName(a, b))
      );
    }
  }
  return {
    groups: ordered.map(({ key, heading, kind, voices }) => ({
      key,
      heading,
      kind,
      voices,
    })),
    selected,
    otherLanguages,
    characters,
    hasBetterVoice,
  };
}
