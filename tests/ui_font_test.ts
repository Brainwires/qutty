import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  CUSTOM_FAMILY_MAX,
  DEFAULT_FONT_SETTINGS,
  detectInstalledFonts,
  FONT_IDS,
  FONT_OPTIONS,
  fontStack,
  isFamilyInstalled,
  sanitizeCustomFamily,
  sanitizeFont,
  sortByInstalled,
  stepFontSize,
  terminalFontOptions,
} from "../lib/workspace/fonts.ts";
import {
  DEFAULT_SETTINGS,
  initialState,
  reduce,
  sanitizeSettings,
} from "../lib/workspace/store.ts";

Deno.test("font: the curated list and defaults", () => {
  assertEquals(FONT_OPTIONS.map((f) => f.label), [
    "SF Mono",
    "Menlo",
    "Monaco",
    "JetBrains Mono",
    "Fira Code",
    "Cascadia Code",
    "Source Code Pro",
    "IBM Plex Mono",
    "Hack",
    "Iosevka",
    "Courier New",
  ]);
  assertEquals(FONT_IDS.at(-1), "custom");
  assertEquals(new Set(FONT_IDS).size, FONT_IDS.length, "ids are unique");
  assertEquals(DEFAULT_SETTINGS.fontFamily, "sf-mono");
  assertEquals(DEFAULT_SETTINGS.fontSize, 13);
  assertEquals(DEFAULT_SETTINGS.lineHeight, 1.15);
  assertEquals(DEFAULT_SETTINGS.fontWeight, "normal");
  assertEquals(DEFAULT_SETTINGS.fontFamilyCustom, "");
});

Deno.test("fontStack: the family then monospace, custom quoted, fallbacks", () => {
  const s = (fontFamily: string, fontFamilyCustom = "") =>
    fontStack({ fontFamily, fontFamilyCustom });
  assertEquals(s("sf-mono"), 'ui-monospace, "SF Mono", Menlo, monospace');
  assertEquals(s("menlo"), "Menlo, monospace");
  assertEquals(s("jetbrains-mono"), '"JetBrains Mono", monospace');
  assertEquals(s("courier-new"), '"Courier New", monospace');
  assertEquals(s("custom", "Berkeley Mono"), '"Berkeley Mono", monospace');
  assertEquals(
    s("custom", 'Evil", serif; } body { x'),
    '"Evil serif body x", monospace',
    "a custom name cannot break out of its quotes",
  );
  assertEquals(s("custom", "   "), s("sf-mono"), "empty custom → default");
  assertEquals(s("nope"), s("sf-mono"), "unknown id → default");
  for (const id of FONT_IDS) {
    assert(s(id, "X").endsWith(", monospace"), `${id} ends in monospace`);
  }
  assertEquals(terminalFontOptions(DEFAULT_FONT_SETTINGS), {
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    fontWeight: "normal",
  });
});

Deno.test("sanitizeCustomFamily: trims, collapses, strips CSS punctuation, caps length", () => {
  assertEquals(sanitizeCustomFamily("  Fira   Mono  "), "Fira Mono");
  assertEquals(sanitizeCustomFamily('"Quoted"'), "Quoted");
  assertEquals(sanitizeCustomFamily("a\\b;c{d}e<f>"), "abcdef");
  assertEquals(sanitizeCustomFamily("line\nbreak"), "line break");
  assertEquals(sanitizeCustomFamily(42), "");
  assertEquals(sanitizeCustomFamily(null), "");
  assertEquals(sanitizeCustomFamily("x".repeat(200)).length, CUSTOM_FAMILY_MAX);
});

Deno.test("sanitizeFont / sanitizeSettings: bad family, custom, clamping, missing fields", () => {
  const b = DEFAULT_FONT_SETTINGS;
  assertEquals(
    sanitizeFont(b, { fontFamily: "comic-sans" }).fontFamily,
    "sf-mono",
  );
  assertEquals(sanitizeFont(b, { fontFamily: 7 }).fontFamily, "sf-mono");
  assertEquals(sanitizeFont(b, { fontFamily: "hack" }).fontFamily, "hack");
  const custom = sanitizeFont(b, {
    fontFamily: "custom",
    fontFamilyCustom: '  My "Font"  ',
  });
  assertEquals(custom.fontFamily, "custom");
  assertEquals(custom.fontFamilyCustom, "My Font");
  assertEquals(sanitizeFont(b, { fontSize: 100 }).fontSize, 32);
  assertEquals(sanitizeFont(b, { fontSize: 2 }).fontSize, 9);
  assertEquals(sanitizeFont(b, { fontSize: 14.6 }).fontSize, 15, "integer");
  assertEquals(
    sanitizeFont(b, { fontSize: "20" }).fontSize,
    13,
    "not a number",
  );
  assertEquals(sanitizeFont(b, { fontSize: NaN }).fontSize, 13);
  assertEquals(sanitizeFont(b, { lineHeight: 3 }).lineHeight, 1.6);
  assertEquals(sanitizeFont(b, { lineHeight: 0.2 }).lineHeight, 1);
  assertEquals(sanitizeFont(b, { lineHeight: 1.234 }).lineHeight, 1.23);
  assertEquals(sanitizeFont(b, { fontWeight: 500 }).fontWeight, "500");
  assertEquals(sanitizeFont(b, { fontWeight: "bold" }).fontWeight, "normal");
  assertEquals(sanitizeFont(b, {}), b, "absent fields keep the base");

  // Old stored settings (no font fields) load the defaults.
  const old = sanitizeSettings({
    layout: { pattern: "grid" },
    barPosition: "left",
    barOrder: "mru",
  });
  assertEquals(old.fontFamily, "sf-mono");
  assertEquals(old.fontSize, 13);
  assertEquals(old.lineHeight, 1.15);
  assertEquals(old.fontWeight, "normal");
  assertEquals(old.fontFamilyCustom, "");
  assertEquals(old.barPosition, "left");

  const junk = sanitizeSettings({
    fontFamily: { evil: true },
    fontFamilyCustom: 12,
    fontSize: 1e9,
    lineHeight: "tall",
    fontWeight: "900",
  });
  assertEquals(junk.fontFamily, "sf-mono");
  assertEquals(junk.fontFamilyCustom, "");
  assertEquals(junk.fontSize, 32);
  assertEquals(junk.lineHeight, 1.15);
  assertEquals(junk.fontWeight, "normal");
});

Deno.test("store: setFont, stepFontSize clamps, resetFontSize; no-ops keep identity", () => {
  let s = initialState();
  s = reduce(s, { type: "stepFontSize", dir: 1 });
  assertEquals(s.settings.fontSize, 14);
  s = reduce(s, { type: "setFont", patch: { fontSize: 32 } });
  assertStrictEquals(reduce(s, { type: "stepFontSize", dir: 1 }), s, "at max");
  s = reduce(s, { type: "resetFontSize" });
  assertEquals(s.settings.fontSize, 13);
  assertStrictEquals(reduce(s, { type: "resetFontSize" }), s);
  s = reduce(s, { type: "setFont", patch: { fontSize: 9 } });
  assertStrictEquals(reduce(s, { type: "stepFontSize", dir: -1 }), s, "at min");
  s = reduce(s, {
    type: "setFont",
    patch: { fontFamily: "bogus", lineHeight: 1.4 },
  });
  assertEquals(s.settings.fontFamily, "sf-mono");
  assertEquals(s.settings.lineHeight, 1.4);
  assertEquals(stepFontSize(13, -1), 12);
  assertEquals(stepFontSize(9, -1), 9);
  assertEquals(stepFontSize(32, 1), 32);
  // The font fields do not disturb the layout ones.
  assertEquals(s.settings.layout, DEFAULT_SETTINGS.layout);
});

Deno.test("detection: canvas widths decide when document.fonts.check is unreliable", () => {
  // A fake world where only Menlo and JetBrains Mono exist; `check` says yes to everything
  // (as Chromium does for any non-web font), so measuring must be used.
  const present = new Set(["Menlo", '"JetBrains Mono"']);
  const measure = (font: string) => {
    const families = font.replace(/^\d+px /, "").split(", ");
    const hit = families.find((f) => present.has(f));
    // The generic monospace is as wide as Menlo; serif and sans-serif differ.
    const width: Record<string, number> = {
      Menlo: 100,
      '"JetBrains Mono"': 104,
      monospace: 100,
      serif: 80,
      "sans-serif": 85,
    };
    return width[hit ?? families.at(-1)!];
  };
  const env = { check: () => true, measure };
  assert(isFamilyInstalled(env, "Menlo"), "same width as monospace, not serif");
  assert(isFamilyInstalled(env, '"JetBrains Mono"'));
  assert(!isFamilyInstalled(env, "Hack"));
  const installed = detectInstalledFonts(env);
  assertEquals(installed.menlo, true);
  assertEquals(installed["jetbrains-mono"], true);
  assertEquals(installed.hack, false);
  assertEquals(installed["sf-mono"], false);
  const order = sortByInstalled(installed).map((f) => f.id);
  assertEquals(order.slice(0, 2), ["menlo", "jetbrains-mono"]);
  assertEquals(order.length, FONT_OPTIONS.length);

  // A trustworthy `check` (it rejects a made-up family) is used directly.
  const checked = detectInstalledFonts({
    check: (f) => f.includes("Hack"),
    measure: () => 1,
  });
  assertEquals(checked.hack, true);
  assertEquals(checked.menlo, false);

  // No probe at all (no DOM): nothing is greyed out.
  assert(Object.values(detectInstalledFonts({})).every((v) => v));
});
