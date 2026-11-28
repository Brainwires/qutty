// Skins, the pure parts (lib/skins/): skin.json validation, the stylesheet sanitizer (no network,
// no code), the settings sanitize step and the frame options, the colours a skin brings, the
// built-in Classic package, the demo backend's skins, and the skin contract (lib/skins/parts.ts)
// against the docs, the markup and the stylesheet.

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  type AssetResolver,
  buildSkin,
  checkSkin,
  effectiveTheme,
  isSkinAssetPath,
  isSkinId,
  MAX_CSS_SOURCE,
  MAX_MANIFEST_BYTES,
  parseManifest,
  sanitizeSkinCss,
  skinHasColors,
  type SkinManifest,
  validateManifest,
  withSkinFont,
} from "../lib/skins/skin.ts";
import {
  applySkin,
  DEFAULT_SKIN,
  resolveFrame,
  sanitizeSkinSettings,
} from "../lib/skins/settings.ts";
import {
  BUILTIN_SKIN_IDS,
  BUILTIN_SKINS,
  CLASSIC_MANIFEST,
  skinCopy,
} from "../lib/skins/builtin.ts";
import { createDemoSkins } from "../lib/skins/demo.ts";
import { SKIN_PARTS } from "../lib/skins/parts.ts";
import {
  DEFAULT_SETTINGS,
  initialState,
  reduce,
  sanitizeSettings,
} from "../lib/workspace/store.ts";
import { CHROME_TOKENS, themeById } from "../lib/workspace/themes.ts";

const ROOT = join(import.meta.dirname!, "..");
const read = (path: string) => Deno.readTextFile(join(ROOT, path));

/** The error of a result that must have failed. */
function errorOf(r: { ok: boolean; error?: string }): string {
  assertFalse(r.ok, "expected a failure");
  return r.error ?? "";
}

const MINIMAL = { id: "mine", name: "Mine" };

// ---- skin.json ---------------------------------------------------------------------------------

Deno.test("skin.json: a minimal manifest, and one with everything", () => {
  const min = validateManifest(MINIMAL);
  assert(min.ok);
  assertEquals(min.value, {
    id: "mine",
    name: "Mine",
    author: "",
    version: "",
    description: "",
  });
  const full = validateManifest({
    id: "full-1",
    name: " Full ",
    author: "Me",
    version: "1.2.3",
    description: "Everything.",
    theme: {
      base: "paper",
      scheme: "light",
      tokens: { "--panel": "#c0c0c0", "--shadow-a": 0.5 },
    },
    terminal: {
      fontFamily: '"Fira Code", monospace',
      theme: { background: "#000000", cursor: "rgba(0, 255, 0, 0.5)" },
    },
    fonts: [{ family: "Pixel Font", file: "fonts/pixel.woff2", weight: 700 }],
    frame: {
      buttons: "left",
      title: "center",
      buttonOrder: ["close", "minimize", "maximize"],
    },
  }, "full-1");
  assert(full.ok);
  assertEquals(full.value.name, "Full");
  assertEquals(full.value.theme, {
    base: "paper",
    scheme: "light",
    tokens: { "--panel": "#c0c0c0", "--shadow-a": "0.5" },
  });
  assertEquals(full.value.fonts, [
    { family: "Pixel Font", file: "fonts/pixel.woff2", weight: "700" },
  ]);
  assertEquals(full.value.frame?.buttonOrder, [
    "close",
    "minimize",
    "maximize",
  ]);
  // A theme id alone pairs the skin with that theme.
  const paired = validateManifest({ ...MINIMAL, theme: "ember" });
  assert(paired.ok);
  assertEquals(paired.value.theme, { base: "ember", tokens: {} });
});

Deno.test("skin.json: what is refused, with a reason that names the field", () => {
  const bad: [unknown, string][] = [
    [null, "must be an object"],
    [[], "must be an object"],
    [{ name: "No id" }, '"id"'],
    [{ id: "Has Caps", name: "x" }, '"id"'],
    [{ id: "../up", name: "x" }, '"id"'],
    [{ id: "a".repeat(41), name: "x" }, '"id"'],
    [{ id: "mine" }, '"name"'],
    [{ id: "mine", name: "  " }, '"name"'],
    [{ id: "mine", name: "x".repeat(61) }, '"name"'],
    [{ ...MINIMAL, author: 7 }, '"author"'],
    [{ ...MINIMAL, description: "line\nbreak" }, "control characters"],
    [{ ...MINIMAL, theme: "solarized" }, "no theme"],
    [{ ...MINIMAL, theme: { base: "nope" } }, '"theme.base"'],
    [{ ...MINIMAL, theme: { scheme: "sepia" } }, '"theme.scheme"'],
    [{ ...MINIMAL, theme: { tokens: { "--nope": "#000000" } } }, "no token"],
    [
      { ...MINIMAL, theme: { tokens: { "--ink": "red" } } },
      '"theme.tokens.--ink"',
    ],
    [
      { ...MINIMAL, theme: { tokens: { "--ink": "url(https://x)" } } },
      '"theme.tokens.--ink"',
    ],
    [{ ...MINIMAL, theme: { tokens: { "--shadow-a": 2 } } }, "--shadow-a"],
    [
      { ...MINIMAL, terminal: { fontFamily: "x; } body { display: none" } },
      '"terminal.fontFamily"',
    ],
    [{ ...MINIMAL, terminal: { theme: { nope: "#000000" } } }, "no colour"],
    [
      { ...MINIMAL, terminal: { theme: { background: "black" } } },
      '"terminal.theme.background"',
    ],
    [{ ...MINIMAL, fonts: {} }, '"fonts"'],
    [
      { ...MINIMAL, fonts: [{ family: 'a"; x', file: "a.woff2" }] },
      '"fonts[0].family"',
    ],
    [
      { ...MINIMAL, fonts: [{ family: "A", file: "../a.woff2" }] },
      '"fonts[0].file"',
    ],
    [
      { ...MINIMAL, fonts: [{ family: "A", file: "https://x/a.woff2" }] },
      '"fonts[0].file"',
    ],
    [
      { ...MINIMAL, fonts: [{ family: "A", file: "a.png" }] },
      "woff2, woff, ttf or otf",
    ],
    [
      { ...MINIMAL, fonts: [{ family: "A", file: "a.ttf", weight: "heavy" }] },
      '"fonts[0].weight"',
    ],
    [
      {
        ...MINIMAL,
        fonts: Array.from({ length: 9 }, () => ({
          family: "A",
          file: "a.ttf",
        })),
      },
      "more than 8",
    ],
    [{ ...MINIMAL, frame: { buttons: "top" } }, '"frame.buttons"'],
    [{ ...MINIMAL, frame: { title: "middle" } }, '"frame.title"'],
    [
      { ...MINIMAL, frame: { buttonOrder: ["close", "close", "minimize"] } },
      '"frame.buttonOrder"',
    ],
    [{ ...MINIMAL, frame: { buttonOrder: ["close"] } }, '"frame.buttonOrder"'],
  ];
  for (const [raw, why] of bad) {
    assertStringIncludes(
      errorOf(validateManifest(raw)),
      why,
      JSON.stringify(raw),
    );
  }
  // The id must be the folder's name.
  assertStringIncludes(
    errorOf(validateManifest(MINIMAL, "other")),
    "folder's name",
  );
  // The text form: size and syntax.
  assertStringIncludes(errorOf(parseManifest("{nope")), "not valid JSON");
  assertStringIncludes(
    errorOf(
      parseManifest(
        JSON.stringify({ ...MINIMAL, pad: "x".repeat(MAX_MANIFEST_BYTES) }),
      ),
    ),
    "larger than",
  );
  assert(parseManifest(JSON.stringify(MINIMAL), "mine").ok);
});

Deno.test("skin ids and asset paths", () => {
  for (const id of ["a", "classic", "my-skin-2", "0day"]) assert(isSkinId(id));
  for (const id of ["", "-a", "A", "a_b", "a b", "a/b", "..", 7, null]) {
    assertFalse(isSkinId(id), String(id));
  }
  for (
    const p of ["a.png", "img/a.png", "fonts/My Font.woff2", "a-b_c.1.svg"]
  ) {
    assert(isSkinAssetPath(p), p);
  }
  for (
    const p of [
      "",
      "/etc/passwd",
      "../a.png",
      "img/../../a.png",
      "./a.png",
      "img//a.png",
      "img/",
      "http://x/a.png",
      "//x/a.png",
      "a.png?x=1",
      "a.png#frag",
      "C:\\a.png",
      "data:image/png;base64,AA",
      "a%2e%2e/b.png",
    ]
  ) {
    assertFalse(isSkinAssetPath(p), p);
  }
});

// ---- The stylesheet ----------------------------------------------------------------------------

const DOT = "data:image/png;base64,iVBORw0KGgo=";
const assets: AssetResolver = (path) =>
  path === "img/dot.png" || path === "fonts/pixel.woff2"
    ? { url: DOT }
    : { error: `"${path}" was not found in the skin folder` };

Deno.test("skin.css: plain rules pass, comments go, relative url()s are inlined", () => {
  const css =
    `/* a comment with url(https://evil.example/x) and @import in it */
:root[data-skin="mine"] [data-part="tile"] {
  border: 2px solid #ff00ff;
  background: url(img/dot.png) no-repeat, url( "img/dot.png" ), url('img/dot.png');
  filter: url(#glow);
  content: "a string with url(https://example.com) and @import \\"inside\\" it";
}
@media (min-width: 600px) { .menu { color: rgba(0, 0, 0, 0.5); } }
@font-face { font-family: "Pixel"; src: url(fonts/pixel.woff2) format("woff2"); }
@keyframes spin { to { transform: rotate(360deg); } }
@supports (display: grid) { .menu { display: grid; } }
@layer skin { .menu-item:hover { color: red; } }
`;
  const r = sanitizeSkinCss(css, assets);
  assert(r.ok, r.ok ? "" : r.error);
  // The comment's text is gone; a string's text is data and stays.
  assertFalse(r.value.includes("evil.example"));
  assertStringIncludes(r.value, "url(https://example.com) and @import");
  // Every relative url() became the asset's data: URL, quoted.
  assertEquals(r.value.split(`url("${DOT}")`).length - 1, 4);
  assertFalse(r.value.includes("img/dot.png"));
  assertStringIncludes(r.value, 'url("#glow")');
  assertStringIncludes(r.value, "@media (min-width: 600px)");
  assertStringIncludes(r.value, "@keyframes spin");
  // Sanitizing is stable: what passed passes again with no assets to resolve (the page's check).
  const again = sanitizeSkinCss(r.value);
  assert(again.ok);
  assertEquals(again.value, r.value);
  // An empty stylesheet is a skin of colours and frame options only.
  assertEquals(sanitizeSkinCss(""), { ok: true, value: "" });
});

Deno.test("skin.css: data: URLs of image and font types only", () => {
  for (
    const url of [
      "data:image/png;base64,AAAA",
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
      "data:font/woff2;base64,AAAA",
      "data:image/gif;charset=utf-8;base64,AAAA",
    ]
  ) {
    const r = sanitizeSkinCss(`a { background: url("${url}"); }`);
    assert(r.ok, `${url}: ${r.ok ? "" : r.error}`);
  }
  for (
    const url of [
      "data:text/html,<script>alert(1)</script>",
      "data:text/css,body{}",
      "data:application/javascript,alert(1)",
      "data:,plain",
      "data:image/png",
    ]
  ) {
    assertStringIncludes(
      errorOf(sanitizeSkinCss(`a { background: url("${url}"); }`)),
      "data:",
      url,
    );
  }
});

Deno.test("skin.css: nothing that reaches the network or runs code", () => {
  const refused: [string, string][] = [
    ['@import "other.css";', "@import is not allowed"],
    ["@import url(https://example.com/a.css);", "@import is not allowed"],
    ["@IMPORT url(a.css);", "@import is not allowed"],
    ["a { color: red; } @import 'late.css';", "@import is not allowed"],
    ['@namespace svg url("http://www.w3.org/2000/svg");', "@namespace"],
    ["@charset 'utf-8';", "@charset"],
    ["@page { margin: 0; }", "@page"],
    ["a { background: url(https://example.com/a.png); }", "is not allowed"],
    ['a { background: url("http://example.com/a.png"); }', "is not allowed"],
    ["a { background: URL(//example.com/a.png); }", "is not allowed"],
    ["a { background: url(/etc/passwd); }", "is not allowed"],
    ["a { background: url(../other-skin/a.png); }", "is not allowed"],
    ["a { background: url(img/../../a.png); }", "is not allowed"],
    ["a { background: url(file:///etc/passwd); }", "is not allowed"],
    ["a { background: url(javascript:alert(1)); }", "malformed"],
    ['a { background: url("javascript:alert(1)"); }', "is not allowed"],
    ["a { background: url(blob:https://x/1); }", "is not allowed"],
    ["a { background: url(img/dot.png?track=1); }", "is not allowed"],
    ["a { background: url(notes.txt); }", "only image and font files"],
    ["a { background: url(img/missing.png); }", "was not found"],
    // URLs that are not spelled `url(`.
    ['a { background: image-set("https://x/a.png" 1x); }', "image-set()"],
    ['a { background: -webkit-image-set("a.png" 1x); }', "-webkit-image-set()"],
    ['a { background: image("https://x/a.png"); }', "image()"],
    ['@font-face { src: src("https://x/a.woff2"); }', "src()"],
    ["a { width: expression(alert(1)); }", "expression()"],
    ["a { behavior: url(a.htc); }", "behavior"],
    ["a { -moz-binding: url(a.xml#x); }", "-moz-binding"],
    ["a { background: element(#x); }", "element()"],
    // Escapes that would hide any of the above.
    ["@\\69mport 'a.css';", "backslash"],
    ["a { background: \\75rl(https://x/a.png); }", "backslash"],
    ["a { background: u\\72l(https://x/a.png); }", "backslash"],
    ['a { background: url("https\\3a //x/a.png"); }', "backslash"],
    ["a { background: url(img\\/dot.png); }", "backslash"],
    // Things left open.
    ["a { background: url(img/dot.png; }", "not closed"],
    ['a { content: "never closed; }', "not closed"],
    ["a { color: red; } /* never closed", "not closed"],
    ['a { background: url("img/dot.png" x); }', "not closed"],
    ["a { color: red; }\0", "NUL"],
  ];
  for (const [css, why] of refused) {
    assertStringIncludes(errorOf(sanitizeSkinCss(css, assets)), why, css);
  }
  // The reason names the line.
  assertStringIncludes(
    errorOf(sanitizeSkinCss("a { color: red; }\n\n@import 'x.css';")),
    "line 3",
  );
  // A comment cannot split a keyword back together: it becomes a space.
  const split = sanitizeSkinCss("a { background: u/**/rl(https://x/a.png); }");
  assert(split.ok);
  assertStringIncludes(split.value, "u rl(https");
  // With no resolver (the page's second check) a relative path is refused too.
  assertStringIncludes(
    errorOf(sanitizeSkinCss("a { background: url(img/dot.png); }")),
    "not available",
  );
});

Deno.test("buildSkin: the manifest's fonts become @font-face rules; sizes are capped", () => {
  const manifest = JSON.stringify({
    ...MINIMAL,
    fonts: [{ family: "Pixel", file: "fonts/pixel.woff2", style: "italic" }],
  });
  const r = buildSkin({ manifest, css: "a { color: red; }" }, {
    folder: "mine",
    resolve: assets,
    source: "user",
  });
  assert(r.ok, r.ok ? "" : r.error);
  assertStringIncludes(
    r.value.css,
    `@font-face { font-family: "Pixel"; src: url("${DOT}"); font-weight: normal; font-style: italic;`,
  );
  assertStringIncludes(r.value.css, "a { color: red; }");
  assertEquals(r.value.source, "user");
  // A font file that is not there fails the skin.
  assertStringIncludes(
    errorOf(
      buildSkin({
        manifest: JSON.stringify({
          ...MINIMAL,
          fonts: [{ family: "Gone", file: "fonts/gone.woff2" }],
        }),
        css: "",
      }, { source: "user", resolve: assets }),
    ),
    "was not found",
  );
  assertStringIncludes(
    errorOf(
      buildSkin({
        manifest: JSON.stringify(MINIMAL),
        css: "a{}".repeat(MAX_CSS_SOURCE),
      }, { source: "user" }),
    ),
    "larger than",
  );
  // What crossed the bridge is checked again: a stylesheet with a remote URL never applies.
  const good = checkSkin({ manifest: r.value.manifest, css: r.value.css });
  assert(good.ok);
  assertStringIncludes(
    errorOf(
      checkSkin({
        manifest: r.value.manifest,
        css: "a { background: url(https://example.com/a.png); }",
      }),
    ),
    "is not allowed",
  );
  assertStringIncludes(
    errorOf(checkSkin({ manifest: { id: "BAD" }, css: "" })),
    '"id"',
  );
  assertEquals(errorOf(checkSkin("nope")), "not a skin");
});

// ---- Settings and the frame --------------------------------------------------------------------

Deno.test("skin settings: sanitized field by field", () => {
  assertEquals(sanitizeSkinSettings(undefined), DEFAULT_SKIN);
  assertEquals(sanitizeSkinSettings("classic"), DEFAULT_SKIN);
  assertEquals(
    sanitizeSkinSettings({
      id: "classic",
      colors: false,
      frameButtons: "left",
      frameTitle: "center",
    }),
    {
      id: "classic",
      colors: false,
      frameButtons: "left",
      frameTitle: "center",
    },
  );
  // Junk falls back field by field; an id that is not an id is Qutty's own look.
  assertEquals(
    sanitizeSkinSettings({
      id: "../../etc/passwd",
      colors: "yes",
      frameButtons: "top",
      frameTitle: 7,
      extra: true,
    }),
    DEFAULT_SKIN,
  );
  // A patch goes over the current settings.
  const base = { ...DEFAULT_SKIN, id: "classic", frameTitle: "right" as const };
  assertEquals(sanitizeSkinSettings({ frameButtons: "left" }, base), {
    ...base,
    frameButtons: "left",
  });
  // A user skin's id is kept though it is not known here (it may be gone at run time).
  assertEquals(sanitizeSkinSettings({ id: "my-classic" }).id, "my-classic");
});

Deno.test("skin settings: in the workspace store", () => {
  assertEquals(DEFAULT_SETTINGS.skin, DEFAULT_SKIN);
  // Settings saved before skins existed get the defaults.
  assertEquals(sanitizeSettings({ theme: "plum" }).skin, DEFAULT_SKIN);
  assertEquals(
    sanitizeSettings({ skin: { id: "classic", frameButtons: "nope" } }).skin,
    { ...DEFAULT_SKIN, id: "classic" },
  );
  assertEquals(sanitizeSettings({ skin: "classic" }).skin, DEFAULT_SKIN);
  // The stored defaults are not shared with a sanitized copy.
  const s = sanitizeSettings({});
  s.skin.id = "changed";
  assertEquals(DEFAULT_SETTINGS.skin.id, "qutty");

  let state = initialState();
  state = reduce(state, { type: "setSkin", patch: { id: "classic" } });
  assertEquals(state.settings.skin, { ...DEFAULT_SKIN, id: "classic" });
  state = reduce(state, {
    type: "setSkin",
    patch: { frameButtons: "left", frameTitle: "center" },
  });
  assertEquals(state.settings.skin, {
    id: "classic",
    colors: true,
    frameButtons: "left",
    frameTitle: "center",
  });
  // No change, same state; junk changes nothing.
  assertEquals(
    reduce(state, { type: "setSkin", patch: { id: "classic" } }),
    state,
  );
  assertEquals(
    reduce(state, {
      type: "setSkin",
      patch: { frameButtons: "top" as "left" },
    }),
    state,
  );
  // It hydrates with the rest of the settings (another window changed it).
  state = reduce(state, {
    type: "hydrateSettings",
    settings: { skin: { ...DEFAULT_SKIN, id: "blueprint" } },
  });
  assertEquals(state.settings.skin.id, "blueprint");
});

Deno.test("frame: the user's choice over the skin's default over Qutty's", () => {
  const follow = { frameButtons: "skin", frameTitle: "skin" } as const;
  // Qutty's own: buttons right, title left, Close outermost.
  assertEquals(resolveFrame(undefined, follow), {
    buttons: "right",
    title: "left",
    buttonOrder: ["minimize", "maximize", "close"],
  });
  // The skin's defaults.
  const skin = {
    buttons: "left",
    title: "center",
    buttonOrder: ["close", "maximize", "minimize"],
  } as const;
  assertEquals(
    resolveFrame({ ...skin, buttonOrder: [...skin.buttonOrder] }, follow),
    {
      buttons: "left",
      title: "center",
      buttonOrder: ["close", "maximize", "minimize"],
    },
  );
  // The user's options win, each on its own.
  assertEquals(
    resolveFrame({ buttons: "left", title: "center" }, {
      frameButtons: "skin",
      frameTitle: "right",
    }),
    {
      buttons: "left",
      title: "right",
      buttonOrder: ["close", "minimize", "maximize"],
    },
  );
  // Moved to the other side, the buttons take that side's usual order, not the skin's.
  assertEquals(
    resolveFrame({ ...skin, buttonOrder: [...skin.buttonOrder] }, {
      frameButtons: "right",
      frameTitle: "skin",
    }),
    {
      buttons: "right",
      title: "center",
      buttonOrder: ["minimize", "maximize", "close"],
    },
  );
  // Chosen explicitly on the skin's own side, the skin's order holds.
  assertEquals(
    resolveFrame({ ...skin, buttonOrder: [...skin.buttonOrder] }, {
      frameButtons: "left",
      frameTitle: "left",
    }).buttonOrder,
    ["close", "maximize", "minimize"],
  );
});

Deno.test("applySkin: data-skin, the frame attributes and the buttons' order on the root", () => {
  const attrs: Record<string, string> = {};
  const props: Record<string, string> = {};
  const el = {
    style: { setProperty: (k: string, v: string) => void (props[k] = v) },
    setAttribute: (k: string, v: string) => void (attrs[k] = v),
  };
  applySkin(el, "classic", {
    buttons: "left",
    title: "center",
    buttonOrder: ["close", "minimize", "maximize"],
  });
  assertEquals(attrs, {
    "data-skin": "classic",
    "data-frame-buttons": "left",
    "data-frame-title": "center",
  });
  assertEquals(props, {
    "--frame-order-close": "1",
    "--frame-order-minimize": "2",
    "--frame-order-maximize": "3",
  });
});

// ---- Colours -----------------------------------------------------------------------------------

Deno.test("colours: a skin's theme, the user's when it brings none or is told not to", () => {
  const user = themeById("ember");
  const plain: SkinManifest = { ...CLASSIC_MANIFEST };
  delete plain.theme;
  assertFalse(skinHasColors(plain));
  assert(skinHasColors(CLASSIC_MANIFEST));
  assertEquals(effectiveTheme(user, null, true), user);
  assertEquals(effectiveTheme(user, plain, true), user);
  assertEquals(effectiveTheme(user, CLASSIC_MANIFEST, false), user);

  const classic = effectiveTheme(user, CLASSIC_MANIFEST, true);
  assertEquals(classic.id, "paper");
  assertEquals(classic.scheme, "light");
  assertEquals(classic.chrome["--panel"], "#c0c0c0");
  // The terminal follows the tokens as a built-in theme's does; its ANSI colours are the base's.
  assertEquals(classic.terminal.background, "#ffffff");
  assertEquals(classic.terminal.foreground, "#000000");
  assertEquals(classic.terminal.cursor, "#000080");
  assertEquals(classic.terminal.selectionBackground, "rgba(0, 0, 128, 0.3)");
  assertEquals(classic.terminal.green, themeById("paper").terminal.green);
  // Every token is still there (the skin's set is over a whole theme).
  for (const t of CHROME_TOKENS) assert(classic.chrome[t], t);

  // Terminal colours alone go over the user's theme; the skin's own colours win over its tokens.
  const term = effectiveTheme(user, {
    ...plain,
    terminal: { theme: { background: "#101010" } },
  }, true);
  assertEquals(term.id, "ember");
  assertEquals(term.terminal.background, "#101010");
  assertEquals(term.chrome, user.chrome);

  assertEquals(withSkinFont("Menlo, monospace", undefined), "Menlo, monospace");
  assertEquals(
    withSkinFont("Menlo, monospace", '"Fira Code"'),
    '"Fira Code", Menlo, monospace',
  );
});

// ---- The built-ins -----------------------------------------------------------------------------

Deno.test("built-ins: Qutty and Classic; Classic's package is a valid skin with no assets", async () => {
  assertEquals(BUILTIN_SKIN_IDS, ["qutty", "classic"]);
  for (const s of BUILTIN_SKINS) {
    const r = validateManifest(s.manifest);
    assert(r.ok, r.ok ? "" : r.error);
    assertEquals(r.value, s.manifest);
  }
  // The package the page links and "Start from Classic" copies: the same manifest, and a
  // stylesheet that passes the checks every user skin gets, with nothing to inline.
  const manifest = await read("public/skins/classic/skin.json");
  const css = await read("public/skins/classic/skin.css");
  const built = buildSkin({ manifest, css }, {
    folder: "classic",
    source: "builtin",
  });
  assert(built.ok, built.ok ? "" : built.error);
  assertEquals(built.value.manifest, CLASSIC_MANIFEST);
  assertFalse(
    /url\(/i.test(built.value.css),
    "Classic draws everything in CSS",
  );
  // Every rule is scoped to the skin.
  const selectors = built.value.css.match(/(^|\})\s*[^@{}\s][^{}]*\{/g) ?? [];
  assert(selectors.length > 50);
  for (const s of selectors) {
    assertStringIncludes(s, ':root[data-skin="classic"]', s);
  }
  // It is linked after the app's own stylesheet.
  const layout = await read("app/layout.tsx");
  assert(
    layout.indexOf('href="/styles.css"') <
      layout.indexOf('href="/skins/classic/skin.css"'),
  );
  // Nothing in the package names another company's product.
  for (const text of [manifest, css]) {
    assertFalse(/windows 9|win9|microsoft|tahoma|ms sans|segoe/i.test(text));
  }
});

Deno.test("Start from Classic: a copy under a free id, pointed at itself", async () => {
  const req = {
    id: "my-classic",
    name: "My Classic",
    from: "classic",
    manifest: await read("public/skins/classic/skin.json"),
    css: await read("public/skins/classic/skin.css"),
  };
  const first = skinCopy(req, () => false);
  assertEquals(first.id, "my-classic");
  const m = JSON.parse(first.files.manifest);
  assertEquals([m.id, m.name], ["my-classic", "My Classic"]);
  assertEquals(m.theme, JSON.parse(req.manifest).theme);
  assertFalse(first.files.css.includes('data-skin="classic"'));
  assertStringIncludes(first.files.css, ':root[data-skin="my-classic"]');
  // A taken id gets a number; a built-in's id is never given out.
  const taken = new Set(["my-classic", "my-classic-2"]);
  const third = skinCopy(req, (id) => taken.has(id));
  assertEquals(third.id, "my-classic-3");
  assertEquals(JSON.parse(third.files.manifest).name, "My Classic 3");
  assertEquals(
    skinCopy({ ...req, id: "classic" }, () => false).id,
    "classic-2",
  );
  // What is not a skin is not written.
  assertThrows(() => skinCopy({ ...req, id: "Bad Id" }, () => false));
  assertThrows(
    () => skinCopy({ ...req, manifest: "{nope" }, () => false),
    Error,
    "not valid JSON",
  );
  assertThrows(
    () => skinCopy({ ...req, css: "@import 'x.css';" }, () => false),
    Error,
    "@import",
  );
});

Deno.test("demo skins: one usable, one refused, copies kept in memory", async () => {
  const demo = createDemoSkins();
  const list = await demo.list();
  assertEquals(list.skins.map((m) => m.id), ["blueprint"]);
  assertEquals(list.problems.map((p) => p.folder), ["remote-import"]);
  assertStringIncludes(list.problems[0].error, "@import is not allowed");
  const skin = await demo.get("blueprint");
  assert(checkSkin(skin).ok);
  assertEquals(skin.manifest.frame, { buttons: "left", title: "center" });
  let failed = "";
  await demo.get("remote-import").catch((e) => failed = e.message);
  assertStringIncludes(failed, "@import");
  const copy = await demo.template({
    id: "blueprint",
    name: "Copy",
    from: "blueprint",
    manifest: JSON.stringify(skin.manifest),
    css: skin.css,
  });
  assertEquals(copy.id, "blueprint-2");
  assertEquals((await demo.list()).skins.map((m) => m.id), [
    "blueprint",
    "blueprint-2",
  ]);
  assertStringIncludes(
    (await demo.get("blueprint-2")).css,
    'data-skin="blueprint-2"',
  );
  await demo.openFolder();
});

// ---- The contract ------------------------------------------------------------------------------

Deno.test("contract: every part is in the docs, the markup and the stylesheet", async () => {
  const docs = await read("docs/skins.md");
  const styles = await read("public/styles.css");
  let markup = "";
  for (const dir of ["app", "app/companion"]) {
    for await (const e of Deno.readDir(join(ROOT, dir))) {
      if (e.isFile && e.name.endsWith(".tsx")) {
        markup += await read(`${dir}/${e.name}`);
      }
    }
  }
  const selectors = SKIN_PARTS.map((p) => p.selector);
  assertEquals(new Set(selectors).size, selectors.length, "no duplicates");
  for (const { selector } of SKIN_PARTS) {
    assertStringIncludes(docs, `\`${selector}\``, `docs/skins.md: ${selector}`);
    const part = /^\[data-part="([a-z-]+)"\]$/.exec(selector)?.[1];
    if (part) {
      assertStringIncludes(markup, `data-part="${part}"`, selector);
    } else {
      const name = selector.slice(1);
      assert(
        new RegExp(`\\.${name}(?![\\w-])`).test(styles),
        `public/styles.css has no ${selector}`,
      );
      assert(
        new RegExp(`class=(\\{\`|")[^"\`]*\\b${name}\\b`).test(markup),
        `no markup has class ${name}`,
      );
    }
  }
  // And the other way: no data-part in the markup the contract does not list.
  for (const m of markup.matchAll(/data-part="([a-z-]+)"/g)) {
    assert(selectors.includes(`[data-part="${m[1]}"]`), `unlisted: ${m[1]}`);
  }
  // The root attributes skins and the frame options go by are documented too.
  for (
    const attr of [
      "data-skin",
      "data-frame-buttons",
      "data-frame-title",
      "--frame-order-close",
      "data-chat-size",
      "--chat-size",
      "--chat-text-sm",
      "--chat-text-xs",
      "--chat-code-size",
    ]
  ) {
    assertStringIncludes(docs, attr);
    assert(
      styles.includes(attr) || attr === "data-skin",
      `public/styles.css: ${attr}`,
    );
  }
});
