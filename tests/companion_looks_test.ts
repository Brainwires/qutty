// Companion looks (lib/companion/looks.ts, lib/companion/look-build.ts, desktop/companion-looks.ts):
// look.json checked, the fallback chain of every mood and state, the mouth frames, look.css made
// safe and scoped, the setting sanitized, and the looks folder read from a temp folder holding the
// test look tests/fixtures/looks/pixel-blob (which is not built in), with links, broken looks and
// twins skipped, and "Create a look…"'s starter look.

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import {
  BUILTIN_LOOK_ID,
  fallbackChain,
  isLookImageName,
  LOOK_IMAGES,
  LOOK_LIMITS,
  parseLookManifest,
  pickLookImage,
  sanitizeLookCss,
  speakFrame,
  speakFrameCount,
} from "../lib/companion/looks.ts";
import { buildLook } from "../lib/companion/look-build.ts";
import { starterFiles } from "../lib/companion/look-template.ts";
import { LookStore } from "../desktop/companion-looks.ts";
import {
  type FaceMood,
  type FaceState,
  MOODS,
} from "../lib/companion/face-machine.ts";
import { LEVEL_STEPS } from "../lib/companion/lip-sync.ts";
import {
  DEFAULT_COMPANION,
  sanitizeCompanion,
} from "../lib/companion/settings.ts";

const FIXTURE = fromFileUrl(
  new URL("./fixtures/looks/pixel-blob", import.meta.url),
);
const STATES: FaceState[] = [
  "hidden",
  "appear",
  "idle",
  "blink",
  "think",
  "point",
  "celebrate",
  "dismiss",
];
const encoder = new TextEncoder();

/** A temp looks folder with a copy of the test look in it. */
async function looksDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "qutty-looks-" });
  await copy(FIXTURE, join(dir, "pixel-blob"));
  return dir;
}

/** The test look read through the desktop's own code. */
async function pixelBlob() {
  const dir = await looksDir();
  try {
    const got = await new LookStore(dir).get("pixel-blob");
    assert("look" in got, JSON.stringify(got));
    return got.look;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Pictures named `names`, each a distinct fake data: URL. */
const pics = (...names: string[]) =>
  Object.fromEntries(names.map((n) => [n, `data:image/svg+xml,${n}`]));

Deno.test("look.json: a valid manifest, trimmed, with its size", () => {
  const r = parseLookManifest({
    id: "pixel-blob",
    name: "  Pixel   Blob ",
    author: "Me",
    version: "1.0",
    description: "x",
    size: { w: 96.4, h: 120 },
  });
  assert(r.ok);
  assertEquals(r.manifest, {
    id: "pixel-blob",
    name: "Pixel Blob",
    author: "Me",
    version: "1.0",
    description: "x",
    size: { w: 96, h: 120 },
  });
  const bare = parseLookManifest({ id: "a", name: "A" });
  assert(bare.ok);
  assertEquals(bare.manifest.author, "");
  assertEquals("size" in bare.manifest, false);
});

Deno.test("look.json: bad manifests say why", () => {
  const bad: [unknown, RegExp][] = [
    [null, /not a JSON object/],
    [[], /not a JSON object/],
    [{ name: "x" }, /"id"/],
    [{ id: "Has Caps", name: "x" }, /"id"/],
    [{ id: "../up", name: "x" }, /"id"/],
    [{ id: "-dash", name: "x" }, /"id"/],
    [{ id: BUILTIN_LOOK_ID, name: "x" }, /built-in/],
    [{ id: "a" }, /"name"/],
    [{ id: "a", name: "   " }, /"name"/],
    [{ id: "a", name: "A", size: { w: 10, h: 100 } }, /"size"/],
    [{ id: "a", name: "A", size: { w: 100, h: 1000 } }, /"size"/],
    [{ id: "a", name: "A", size: "big" }, /"size"/],
  ];
  for (const [raw, why] of bad) {
    const r = parseLookManifest(raw);
    assert(!r.ok, JSON.stringify(raw));
    assertMatch(r.error, why);
  }
});

Deno.test("the fallback chain: every mood and extra ends at idle, as documented", () => {
  for (const spec of LOOK_IMAGES) {
    const chain = fallbackChain(spec.id);
    assertEquals(chain[0], spec.id);
    assertEquals(chain.at(-1), "idle", spec.id);
    assert(chain.length <= 3, `${spec.id}: ${chain}`);
  }
  // Every mood a message can carry has a picture name.
  for (const mood of MOODS) assert(isLookImageName(mood), mood);
  assertEquals(fallbackChain("idle"), ["idle"]);
  assertEquals(fallbackChain("neutral"), ["neutral", "idle"]);
  assertEquals(fallbackChain("confused"), ["confused", "thinking", "idle"]);
  assertEquals(fallbackChain("attention"), ["attention", "surprised", "idle"]);
  assertEquals(fallbackChain("shocked"), ["shocked", "surprised", "idle"]);
  assertEquals(fallbackChain("wow"), ["wow", "surprised", "idle"]);
  assertEquals(fallbackChain("success"), ["success", "happy", "idle"]);
  assertEquals(fallbackChain("excited"), ["excited", "happy", "idle"]);
  assertEquals(fallbackChain("love"), ["love", "happy", "idle"]);
  assertEquals(fallbackChain("blush"), ["blush", "happy", "idle"]);
  assertEquals(fallbackChain("mad"), ["mad", "sad", "idle"]);
  assertEquals(fallbackChain("sleeping"), ["sleeping", "sleepy", "idle"]);
  assertEquals(fallbackChain("nope"), []);
  assert(isLookImageName("speak-0"));
  assert(isLookImageName(`speak-${LOOK_LIMITS.speakFrames - 1}`));
  assert(!isLookImageName(`speak-${LOOK_LIMITS.speakFrames}`));
  assert(!isLookImageName("look"));
});

Deno.test("a look with only idle shows it in every state, mood and voice turn", () => {
  const images = pics("idle");
  for (const state of STATES) {
    for (const mood of MOODS) {
      for (
        const voice of [undefined, "listening", "thinking", "speaking"] as const
      ) {
        const p = pickLookImage(images, {
          state,
          mood,
          ...(voice ? { voice } : {}),
          level: 2,
          hot: true,
          asleep: true,
        });
        assertEquals(p.name, "idle", `${state} ${mood} ${voice}`);
        assertEquals(p.src, images.idle);
        // Talking with no mouth frames: the picture bobs.
        assertEquals(p.bob, voice === "speaking");
      }
    }
  }
});

Deno.test("every mood in every state finds its picture through the chain", async () => {
  const look = await pixelBlob();
  const expect: Record<FaceMood, string> = {
    neutral: "idle",
    thinking: "thinking",
    attention: "surprised",
    success: "happy",
    confused: "thinking",
    mad: "sad",
    sad: "sad",
    excited: "happy",
    sleepy: "sleepy",
    love: "happy",
    surprised: "surprised",
    shocked: "surprised",
    wow: "surprised",
    blush: "happy",
  };
  for (const state of STATES) {
    for (const mood of MOODS) {
      const p = pickLookImage(look.images, { state, mood });
      assertEquals(p.name, expect[mood], `${state} ${mood}`);
      assertEquals(p.src, look.images[expect[mood]]);
      assertEquals(p.bob, false);
    }
  }
  // Hot and asleep, without their own pictures: idle and sleepy.
  assertEquals(
    pickLookImage(look.images, { state: "idle", hot: true }).name,
    "idle",
  );
  assertEquals(
    pickLookImage(look.images, { state: "idle", mood: "sleepy", asleep: true })
      .name,
    "sleepy",
  );
  // The hot face is only over the neutral mood.
  const withHot = pics("idle", "hot", "sad");
  assertEquals(
    pickLookImage(withHot, { state: "idle", hot: true }).name,
    "hot",
  );
  assertEquals(
    pickLookImage(withHot, { state: "idle", mood: "sad", hot: true }).name,
    "sad",
  );
  assertEquals(
    pickLookImage(pics("idle", "sleeping"), {
      state: "idle",
      mood: "sleepy",
      asleep: true,
    }).name,
    "sleeping",
  );
});

Deno.test("blink, listening and thinking pictures are used where they belong", () => {
  const images = pics("idle", "blink", "sad", "listening", "thinking");
  assertEquals(pickLookImage(images, { state: "blink" }).name, "blink");
  // A blink over another mood keeps that mood's picture (the CSS squish blinks it).
  assertEquals(
    pickLookImage(images, { state: "blink", mood: "sad" }).name,
    "sad",
  );
  assertEquals(
    pickLookImage(images, { state: "idle", voice: "listening" }).name,
    "listening",
  );
  assertEquals(
    pickLookImage(images, { state: "idle", mood: "sad", voice: "thinking" })
      .name,
    "thinking",
  );
  assertEquals(
    pickLookImage(pics("idle", "sad"), {
      state: "idle",
      mood: "sad",
      voice: "listening",
    }).name,
    "sad",
  );
});

Deno.test("speak frames: the lip-sync steps spread over however many frames there are", () => {
  const steps = [...Array(LEVEL_STEPS + 1).keys()];
  assertEquals(steps.map((s) => speakFrame(s, 0)), [0, 0, 0, 0, 0]);
  assertEquals(steps.map((s) => speakFrame(s, 1)), [0, 0, 0, 0, 0]);
  assertEquals(steps.map((s) => speakFrame(s, 2)), [0, 0, 1, 1, 1]);
  assertEquals(steps.map((s) => speakFrame(s, 3)), [0, 1, 1, 2, 2]);
  assertEquals(steps.map((s) => speakFrame(s, 5)), [0, 1, 2, 3, 4]);
  assertEquals(speakFrame(-3, 3), 0);
  assertEquals(speakFrame(99, 3), 2);
  for (let frames = 2; frames <= LOOK_LIMITS.speakFrames; frames++) {
    assertEquals(speakFrame(0, frames), 0);
    assertEquals(speakFrame(LEVEL_STEPS, frames), frames - 1);
  }
  // Frames count from speak-0 up to the first gap.
  assertEquals(
    speakFrameCount(pics("idle", "speak-0", "speak-1", "speak-3")),
    2,
  );
  assertEquals(speakFrameCount(pics("idle", "speak-1")), 0);
});

Deno.test("speaking: mouth frames, else the speaking picture, else the mood's, bobbing", async () => {
  const look = await pixelBlob();
  assertEquals(speakFrameCount(look.images), 3);
  const names = [...Array(LEVEL_STEPS + 1).keys()].map((level) =>
    pickLookImage(look.images, { state: "idle", voice: "speaking", level })
  );
  assertEquals(names.map((p) => p.name), [
    "speak-0",
    "speak-1",
    "speak-1",
    "speak-2",
    "speak-2",
  ]);
  assert(names.every((p) => !p.bob && p.src === look.images[p.name]));
  const one = pickLookImage(pics("idle", "speak-0", "speaking"), {
    state: "idle",
    voice: "speaking",
    level: 3,
  });
  assertEquals([one.name, one.bob], ["speaking", true]);
  const none = pickLookImage(pics("idle", "sad"), {
    state: "idle",
    mood: "mad",
    voice: "speaking",
    level: 3,
  });
  assertEquals([none.name, none.bob], ["sad", true]);
});

Deno.test("look.css is scoped to the look and kept from reaching out", () => {
  const files = { "idle.png": "data:image/png;base64,AAAA" };
  const ok = sanitizeLookCss(
    `/* hi */ @import url("https://evil.example/x.css");
.bubble { border-color: red; background: url(idle.png) }
.a { background-image: url("https://evil.example/p.png") }
.b { background: url('../../secret.png') }
.c { background: url(file:///etc/passwd) }
.d { content: "{ not a brace }"; }`,
    "my-look",
    files,
  );
  assert(ok.ok, JSON.stringify(ok));
  assert(ok.css.startsWith('[data-look="my-look"] {\n'));
  assert(ok.css.trimEnd().endsWith("}"));
  assertStringIncludes(ok.css, 'url("data:image/png;base64,AAAA")');
  assert(!/@import|evil|secret|file:|hi \*/.test(ok.css), ok.css);
  assertEquals(ok.css.match(/\bnone\b/g)?.length, 3);
  assert(ok.notes.length >= 4);
  assertEquals(sanitizeLookCss("   ", "my-look"), {
    ok: true,
    css: "",
    notes: [],
  });

  const refused: [string, RegExp][] = [
    ["} body { display: none }", /extra \}/],
    [".a { color: red", /unclosed/],
    [".a { color: red }}", /extra \}/],
    ['.a { content: "x }', /string/],
    [".a { width: expression(alert(1)) }", /script/],
    [".a { behavior: url(x.htc) }", /script/],
    [".a { background: \\75 rl(https://e.example/x) }", /escapes/],
    ["@\\69mport 'x.css';", /escapes/],
    [".a { background: image-set('https://e.example/x' 1x) }", /image/],
    ["</style><script>alert(1)</script>", /HTML/],
  ];
  for (const [css, why] of refused) {
    const r = sanitizeLookCss(css, "my-look");
    assert(!r.ok, css);
    assertMatch(r.error, why, css);
  }
  assert(!sanitizeLookCss("x".repeat(LOOK_LIMITS.cssBytes + 1), "a").ok);
});

Deno.test("buildLook: pictures checked against their format and the limits", () => {
  const manifest = encoder.encode(JSON.stringify({ id: "t", name: "T" }));
  const svg = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const png = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    1,
  ]);
  const build = (files: Record<string, Uint8Array>) =>
    buildLook(new Map(Object.entries(files)));

  const good = build({
    "look.json": manifest,
    "idle.svg": svg,
    "happy.png": png,
    "notes.txt": encoder.encode("ignored"),
    "Idle.SVG": svg,
    "wobble.png": png,
  });
  assert(good.ok, JSON.stringify(good));
  assertEquals(Object.keys(good.look.images).sort(), ["happy", "idle"]);
  assertMatch(good.look.images.idle, /^data:image\/svg\+xml;base64,/);
  assertMatch(good.look.images.happy, /^data:image\/png;base64,/);

  const bad: [Record<string, Uint8Array>, RegExp][] = [
    [{ "idle.svg": svg }, /no look\.json/],
    [{ "look.json": encoder.encode("{nope"), "idle.svg": svg }, /valid JSON/],
    [{ "look.json": manifest, "happy.svg": svg }, /no idle picture/],
    [{ "look.json": manifest, "idle.png": svg }, /not a PNG/],
    [
      {
        "look.json": manifest,
        "idle.svg": encoder.encode("<svg><script>x</script></svg>"),
      },
      /script/,
    ],
    [{ "look.json": manifest, "idle.gif": png }, /not a GIF/],
    [
      {
        "look.json": manifest,
        "idle.png": new Uint8Array(LOOK_LIMITS.imageBytes + 1),
      },
      /bigger than/,
    ],
    [
      {
        "look.json": manifest,
        "idle.svg": svg,
        "look.css": encoder.encode("} x {"),
      },
      /extra \}/,
    ],
  ];
  for (const [files, why] of bad) {
    const r = build(files);
    assert(!r.ok, Object.keys(files).join());
    assertMatch(r.error, why);
  }
});

Deno.test("the looks folder: the test look listed and read whole", async () => {
  const dir = await looksDir();
  try {
    const store = new LookStore(dir);
    const listing = await store.list();
    assertEquals(listing.dir, dir);
    assertEquals(listing.problems, []);
    assertEquals(listing.looks.map((l) => l.id), ["pixel-blob"]);
    const [summary] = listing.looks;
    assertEquals(summary.name, "Pixel Blob");
    assertEquals(summary.size, { w: 96, h: 96 });
    assertMatch(summary.thumbnail, /^data:image\/svg\+xml;base64,/);

    const got = await store.get("pixel-blob");
    assert("look" in got);
    assertEquals(Object.keys(got.look.images).sort(), [
      "happy",
      "idle",
      "sad",
      "sleepy",
      "speak-0",
      "speak-1",
      "speak-2",
      "surprised",
      "thinking",
    ]);
    assertEquals(got.look.images.idle, summary.thumbnail);
    for (const src of Object.values(got.look.images)) {
      assert(src.startsWith("data:"), "only data: URLs reach the page");
    }
    assertStringIncludes(got.look.css, '[data-look="pixel-blob"] {');
    assertStringIncludes(got.look.css, "#2a5f7a");

    assertEquals(await store.get("missing"), {
      error: `no look "missing" in ${dir}`,
    });
    assertEquals(await store.get("../etc"), { error: "not a look id" });
    // No folder at all: nothing listed.
    assertEquals(
      (await new LookStore(join(dir, "nowhere")).list()).looks,
      [],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the looks folder: links, broken looks and twins are skipped, with why", async () => {
  const dir = await looksDir();
  const outside = await Deno.makeTempDir({ prefix: "qutty-outside-" });
  try {
    // A picture that is a link to a file outside the look: never read.
    await Deno.writeTextFile(join(outside, "secret.svg"), "<svg>secret</svg>");
    await Deno.symlink(
      join(outside, "secret.svg"),
      join(dir, "pixel-blob", "love.svg"),
    );
    // A look folder that is a link: not listed.
    await Deno.symlink(join(dir, "pixel-blob"), join(dir, "linked"));
    // A sub-folder in a look: ignored.
    await Deno.mkdir(join(dir, "pixel-blob", "idle.svg.d"));
    // A look without an idle picture, one with a bad look.json, and a twin of pixel-blob.
    await Deno.mkdir(join(dir, "no-idle"));
    await Deno.writeTextFile(
      join(dir, "no-idle", "look.json"),
      JSON.stringify({ id: "no-idle", name: "No idle" }),
    );
    await Deno.mkdir(join(dir, "bad-json"));
    await Deno.writeTextFile(join(dir, "bad-json", "look.json"), "{");
    await copy(join(dir, "pixel-blob"), join(dir, "zz-twin"), {
      preserveTimestamps: false,
    });
    const store = new LookStore(dir);
    const listing = await store.list();
    assertEquals(listing.looks.map((l) => l.id), ["pixel-blob"]);
    assertEquals(
      listing.problems.map((p) => p.folder).sort(),
      ["bad-json", "no-idle", "zz-twin"],
    );
    assertMatch(
      listing.problems.find((p) => p.folder === "zz-twin")!.error,
      /pixel-blob/,
    );
    const got = await store.get("pixel-blob");
    assert("look" in got);
    assertEquals("love" in got.look.images, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("Create a look: the starter look is written, usable, and documents every picture", async () => {
  const dir = await Deno.makeTempDir({ prefix: "qutty-looks-" });
  const opened: string[][] = [];
  try {
    const store = new LookStore(join(dir, "companions"), {
      os: "darwin",
      runner: {
        run: (program, args) => {
          opened.push([program, ...args]);
          return Promise.resolve({ code: 0, out: "" });
        },
      },
    });
    const first = await store.create();
    const second = await store.create();
    assertEquals(first, join(dir, "companions", "my-look"));
    assertEquals(second, join(dir, "companions", "my-look-2"));
    const listing = await store.list();
    assertEquals(listing.looks.map((l) => l.id), ["my-look", "my-look-2"]);
    assertEquals(listing.problems, []);
    const readme = await Deno.readTextFile(join(first, "README.md"));
    for (const spec of LOOK_IMAGES) {
      assertStringIncludes(readme, `| \`${spec.id}\` |`);
      if (spec.fallback) {
        assertStringIncludes(readme, `| \`${spec.fallback}\` |`);
      }
    }
    assertStringIncludes(readme, "speak-0");
    assertEquals(
      Object.keys(starterFiles("x")).sort(),
      ["README.md", "idle.svg", "look.json"],
    );
    await store.open();
    await store.open(first);
    assertEquals(opened, [
      ["/usr/bin/open", join(dir, "companions")],
      ["/usr/bin/open", first],
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the look setting: a look id is kept, anything else is not", () => {
  assertEquals(DEFAULT_COMPANION.look, BUILTIN_LOOK_ID);
  assertEquals(sanitizeCompanion({ look: "pixel-blob" }).look, "pixel-blob");
  assertEquals(sanitizeCompanion({ look: BUILTIN_LOOK_ID }).look, "loopy");
  for (const look of ["", "../x", "Has Space", 7, null, "a".repeat(60)]) {
    assertEquals(
      sanitizeCompanion({ look }).look,
      BUILTIN_LOOK_ID,
      String(look),
    );
  }
  // A bad value leaves the saved choice alone.
  const saved = sanitizeCompanion({ look: "pixel-blob" });
  assertEquals(sanitizeCompanion({ look: "../x" }, saved).look, "pixel-blob");
});
