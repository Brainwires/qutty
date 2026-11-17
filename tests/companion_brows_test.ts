// The companion's brows stay on its head: for every mood (and the hot face), in every move that
// lifts or tilts the brows (`data-state`: think, celebrate, appear…) and every idle pose of the
// Lively face (`data-expr`: brow-raise, look-up, delighted…), each brow's stroke lies inside the
// bead with a margin, and the brows' bounding box stays below the head's top quarter. The moves
// and poses are read from public/styles.css (every rule that moves `.companion-brows` or its
// paths), so a lift added there is checked too. A face is checked in the moves it can be in: its
// mood's own (`moodState`: think for thinking, celebrate for success…) and the ones any mood
// passes through (appear, blink, idle; the hot face only idles). An idle pose is only combined with the moves the
// face life plays in (`mayLiven`: idle or blinking, neither of which moves the brows). Once, the surprised, shocked and excited brows
// (and the neutral face's delighted pose) sat at or past the bead's rim.

import { assert, assertEquals } from "@std/assert";
import { FACES, HOT_FACE } from "../app/companion/companion-face.tsx";
import {
  type FaceMood,
  type FaceState,
  MOODS,
  moodState,
} from "../lib/companion/face-machine.ts";
import { mayLiven, MICRO_EXPRESSIONS } from "../lib/companion/face-life.ts";

/** The bead: the head's centre and radius, in drawing units (app/companion/companion-face.tsx). */
const HEAD = { cx: 80, cy: 76, r: 29 } as const;
/** How far inside the bead's rim every point of a brow's stroke stays. */
const RIM_MARGIN = 2;
/** The highest a brow's stroke may reach: 7 units (a quarter of the radius) below the head's top. */
const TOP_Y = HEAD.cy - HEAD.r + 7;

type Pt = [number, number];

/** Points along an SVG path of M, L and Q commands (absolute), every brow's shape. */
function sample(d: string): Pt[] {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+/g) ?? [];
  const pts: Pt[] = [];
  let cur: Pt = [0, 0];
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M") {
      cur = [num(), num()];
      pts.push(cur);
    } else if (cmd === "L") {
      const end: Pt = [num(), num()];
      for (let k = 1; k <= 24; k++) {
        const t = k / 24;
        pts.push([
          cur[0] + (end[0] - cur[0]) * t,
          cur[1] + (end[1] - cur[1]) * t,
        ]);
      }
      cur = end;
    } else if (cmd === "Q") {
      const c: Pt = [num(), num()];
      const end: Pt = [num(), num()];
      for (let k = 1; k <= 48; k++) {
        const t = k / 48;
        const u = 1 - t;
        pts.push([
          u * u * cur[0] + 2 * t * u * c[0] + t * t * end[0],
          u * u * cur[1] + 2 * t * u * c[1] + t * t * end[1],
        ]);
      }
      cur = end;
    } else throw new Error(`brow path command ${cmd} in ${d}`);
  }
  return pts;
}

// --- the brows' moves in public/styles.css ---------------------------------------------------

/** One move of the brows: a transform function list (`translateY(-1px) rotate(-3deg)`). */
type Fn = { kind: "translate"; x: number; y: number } | {
  kind: "rotate";
  deg: number;
};

/** `transform: …` or `translate: …` as functions. */
function parseMove(prop: string, value: string): Fn[] {
  const px = (v: string) => Number(v.trim().replace(/px$/, "")) || 0;
  if (prop === "translate") {
    const [x, y = "0"] = value.trim().split(/\s+/);
    return [{ kind: "translate", x: px(x), y: px(y) }];
  }
  if (prop === "rotate") {
    return [{ kind: "rotate", deg: Number(value.replace(/deg$/, "")) }];
  }
  if (value === "none") return [];
  return [...value.matchAll(/(\w+)\(([^)]*)\)/g)].map(([, fn, args]) => {
    const a = args.split(",");
    switch (fn) {
      case "translateY":
        return { kind: "translate", x: 0, y: px(a[0]) };
      case "translateX":
        return { kind: "translate", x: px(a[0]), y: 0 };
      case "translate":
        return { kind: "translate", x: px(a[0]), y: px(a[1] ?? "0") };
      case "rotate":
        return { kind: "rotate", deg: Number(a[0].replace(/deg$/, "")) };
      default:
        throw new Error(`a brow move this test does not know: ${fn}()`);
    }
  });
}

/** A rule that moves the brows (the group, or one or both paths). */
interface BrowMove {
  readonly selector: string;
  /** The brows' group, or their paths (`path:nth-child(n)`: only brow n). */
  readonly level: "group" | "path";
  readonly nth: 1 | 2 | null;
  readonly mood: string | null;
  readonly state: string | null;
  readonly expr: string | null;
  readonly fns: Fn[];
}

/** Every rule of `css` that moves `.companion-brows` or its paths, and the brows' stroke width. */
function browMoves(css: string): { moves: BrowMove[]; stroke: number } {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const moves: BrowMove[] = [];
  let stroke = NaN;
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].trim().split(/\s*,\s*/);
    const decls = m[2].split(";").map((d) => d.split(":")).filter((d) =>
      d.length >= 2
    ).map(([p, ...v]) => [p.trim(), v.join(":").trim()] as const);
    for (const selector of selectors) {
      if (!/\.companion-brows\b/.test(selector)) continue;
      const isPath = /\.companion-brows path/.test(selector);
      for (const [prop, value] of decls) {
        if (prop === "stroke-width" && isPath) stroke = Number(value);
        if (!["transform", "translate", "rotate"].includes(prop)) continue;
        moves.push({
          selector,
          level: isPath ? "path" : "group",
          nth: (Number(/nth-child\((\d)\)/.exec(selector)?.[1]) || null) as
            | 1
            | 2
            | null,
          mood: /data-mood="([\w-]+)"/.exec(selector)?.[1] ?? null,
          state: /data-state="([\w-]+)"/.exec(selector)?.[1] ?? null,
          expr: /data-expr="([\w-]+)"/.exec(selector)?.[1] ?? null,
          fns: parseMove(prop, value),
        });
      }
    }
  }
  return { moves, stroke };
}

/** `p` moved by `fns` (applied right to left, as CSS does) about `origin`. */
function apply(p: Pt, fns: Fn[], origin: Pt): Pt {
  let [x, y] = [p[0] - origin[0], p[1] - origin[1]];
  for (const fn of [...fns].reverse()) {
    if (fn.kind === "translate") {
      x += fn.x;
      y += fn.y;
    } else {
      const a = (fn.deg * Math.PI) / 180;
      [x, y] = [
        x * Math.cos(a) - y * Math.sin(a),
        x * Math.sin(a) + y * Math.cos(a),
      ];
    }
  }
  return [x + origin[0], y + origin[1]];
}

/** The centre of the points' bounding box (the group's `transform-box: fill-box` origin). */
function centre(pts: Pt[]): Pt {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (Math.min(...ys) + Math.max(...ys)) / 2,
  ];
}

const CSS = await Deno.readTextFile(
  new URL("../public/styles.css", import.meta.url),
);
const { moves: MOVES, stroke: STROKE } = browMoves(CSS);

/** Where the brows of `mood`'s face are drawn in move `state` and idle pose `expr`. */
function posed(
  brows: readonly [string, string],
  mood: string,
  state: string | null,
  expr: string | null,
): [Pt[], Pt[]] {
  const applies = (m: BrowMove) => m.mood === null || m.mood === mood;
  // The paths' own moves (`translate`, the idle pose's): brow n takes its own rule over both's.
  const paths = brows.map((d, i) => {
    const mine = MOVES.filter((m) =>
      m.level === "path" && m.expr === expr && expr !== null && applies(m) &&
      (m.nth === null || m.nth === i + 1)
    );
    const rule = mine.find((m) => m.nth === i + 1) ?? mine.at(-1);
    const pts = sample(d);
    return rule ? pts.map((p) => apply(p, rule.fns, [0, 0])) : pts;
  }) as [Pt[], Pt[]];
  // Then the group's move (the state's), about the centre of the brows' box.
  const group = MOVES.filter((m) =>
    m.level === "group" && m.state === state && state !== null && applies(m)
  ).at(-1);
  if (!group) return paths;
  const origin = centre([...paths[0], ...paths[1]]);
  return paths.map((pts) => pts.map((p) => apply(p, group.fns, origin))) as [
    Pt[],
    Pt[],
  ];
}

/** Every face to check: each mood's, and the hot face (drawn over the neutral one). */
const FACES_TO_CHECK: [string, readonly [string, string]][] = [
  ...MOODS.map((m): [string, readonly [string, string]] => [m, FACES[m].brows]),
  ["hot", HOT_FACE.brows],
];

Deno.test("brows: the moves and idle poses that move them are read from the stylesheet", () => {
  assertEquals(STROKE, 3.4, "the brows' stroke width");
  const states = new Set(
    MOVES.filter((m) => m.level === "group").map((m) => m.state),
  );
  for (const s of ["think", "celebrate", "appear"]) assert(states.has(s), s);
  const exprs = new Set(
    MOVES.filter((m) => m.level === "path").map((m) => m.expr),
  );
  for (const e of ["brow-raise", "look-up", "hm", "delighted"]) {
    assert(exprs.has(e), e);
  }
  // Every brow move is keyed to a move or an idle pose (none applies all the time).
  for (const m of MOVES) {
    assert(
      m.level === "group" ? m.state !== null : m.expr !== null,
      `unkeyed brow move: ${m.selector}`,
    );
  }
  // Every idle pose this test checks is one the face life plays (or the pointer's delight).
  for (const e of exprs) {
    assert(
      e === "delighted" || Object.hasOwn(MICRO_EXPRESSIONS, e!),
      `a pose the face never takes: ${e}`,
    );
  }
});

Deno.test("brows: in every mood, move and idle pose, inside the head and below its top quarter", () => {
  const states = [
    null,
    ...new Set(MOVES.flatMap((m) => m.state ? [m.state] : [])),
  ];
  const exprs = [
    null,
    ...new Set(MOVES.flatMap((m) => m.expr ? [m.expr] : [])),
  ];
  const half = STROKE / 2;
  const failures: string[] = [];
  let checked = 0;
  /** Whether the idle poses play in move `state` (none moves the brows when null). */
  const lively = (state: string | null) =>
    mayLiven({
      lively: true,
      awake: true,
      message: false,
      voice: false,
      busy: false,
      state: (state ?? "idle") as FaceState,
    });
  for (const [mood, brows] of FACES_TO_CHECK) {
    const own = mood === "hot" ? "idle" : moodState(mood as FaceMood);
    for (const state of states) {
      if (state !== null && state !== "appear" && state !== own) continue;
      for (const expr of lively(state) ? exprs : [null]) {
        const [left, right] = posed(brows, mood, state, expr);
        for (const [side, pts] of [["left", left], ["right", right]] as const) {
          // The stroked brow's bounding box.
          const top = Math.min(...pts.map((p) => p[1])) - half;
          // Its farthest point from the head's centre, stroke included.
          const reach = Math.max(
            ...pts.map((p) => Math.hypot(p[0] - HEAD.cx, p[1] - HEAD.cy)),
          ) + half;
          checked++;
          if (top < TOP_Y || reach > HEAD.r - RIM_MARGIN) {
            failures.push(
              `${mood} ${state ?? "-"} ${expr ?? "-"} ${side}: top ${
                top.toFixed(2)
              } (min ${TOP_Y}), reach ${reach.toFixed(2)} (max ${
                HEAD.r - RIM_MARGIN
              })`,
            );
          }
        }
      }
    }
  }
  // Each face: at rest (and in each idle pose for the neutral one), and as it appears.
  assert(
    checked >= FACES_TO_CHECK.length * 2 * 2 + 2 * (exprs.length - 1),
    `only ${checked} checked`,
  );
  assertEquals(failures, [], "brows off the head");
});

Deno.test("brows: the delighted pose (the pointer over the face) keeps a band of steel above them", () => {
  const [l, r] = posed(FACES.neutral.brows, "neutral", null, "delighted");
  const top = Math.min(...[...l, ...r].map((p) => p[1])) - STROKE / 2;
  // The pose the user once saw with the brows on the rim (top ≈ 50.8, the rim there ≈ 49.5).
  assert(top - (HEAD.cy - HEAD.r) >= 7, `top ${top}`);
});
