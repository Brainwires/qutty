// The companion, drawn: the face of Denext's crossed-triangle paper clip on its own. A polished
// steel bead is the head, with the face on it: two big eyes under expressive brows and a small
// mouth, and each mood's extras around it (?, z's, hearts, !, steam, a tear…). The wire body is
// gone; the head is drawn 2 times the size it had on the clip, by cropping the drawing to the head
// (`COMPANION_VIEWBOX`) and scaling it (`COMPANION_SCALE`), so every shape is the example's.
// Hand-written SVG, no assets. Every move is CSS keyed off `data-state` (public/styles.css), on
// `.companion-face`; the idle life (Lively: micro-expressions, the eyes on the pointer) off
// `data-expr` and the `--companion-gaze-*` offsets, as transforms of the face's parts.
//
// Pure: no hooks, no timers — app/companion/companion-overlay.tsx owns the state machine and the
// squash on poke.
//
// The head group is Denext's examples/companion (components/Loopy.tsx on feat/loopy-voice-tools;
// same author, MIT), voice turn included: `voice` says whether the companion is listening,
// thinking or speaking, and `level` is the mouth step while speaking (lib/companion/lip-sync.ts)
// or the microphone's while listening. Qutty's changes to it are few and listed (lower brows, a
// gentler smile, catch-lights, cheeks, the `blush` mood; see `FACES`), and
// tests/companion_look_test.ts renders the head against the example with only those allowed.
import type { FaceMood, FaceState } from "../../lib/companion/face-machine.ts";
import { LEVEL_STEPS, mouthShape } from "../../lib/companion/lip-sync.ts";
import type { MicroExpression } from "../../lib/companion/face-life.ts";
import { DEFAULT_COMPANION_NAME } from "../../lib/companion/settings.ts";

/** One face: the brows, the eyes' shape and pupils, the mouth, and any extras. */
export interface Face {
  /** The left and right brow paths. */
  readonly brows: readonly [string, string];
  /** The eye whites' vertical radius (smaller: sleepier); 0 draws no whites. */
  readonly eyeRy: number;
  /** The pupils: dots offset from the eye centre, hearts, or none. */
  readonly pupils:
    | {
      readonly kind: "dots";
      readonly dx: [number, number];
      readonly dy: number;
      readonly r?: number;
    }
    | { readonly kind: "hearts" }
    | { readonly kind: "stars" }
    | { readonly kind: "ovals" }
    | { readonly kind: "none" };
  /** The mouth path, and whether it is filled (an open mouth). */
  readonly mouth: string;
  readonly mouthOpen?: boolean;
}

// Qutty's softer face (tests/companion_look_test.ts lists every way it differs from the example):
// - The brows sit lower, with flatter arches, so that no mood and no move of the face lifts them
//   past the head's top quarter (the example's surprised, shocked and excited brows rose to and
//   past the bead's rim). tests/companion_brows_test.ts checks every mood in every move and idle
//   pose against public/styles.css.
// - The resting smile is small and gentle (the example's wide crescent read as manic under high
//   brows, more so stretched by the delighted pose).

/** The resting smile: small and gentle. */
const SMILE = "M74 89 Q80 93 86 89";
const FROWN = "M71 92 Q80 85 89 92";

/** The face each mood wears (tests/companion_brows_test.ts keeps every brow on the head). */
export const FACES: Readonly<Record<FaceMood, Face>> = {
  neutral: {
    brows: ["M61 61 Q68 55 76 59.5", "M84 59.5 Q92 55 99 61"],
    eyeRy: 8.8,
    pupils: { kind: "dots", dx: [1.8, -1.8], dy: 1.8 },
    mouth: SMILE,
  },
  thinking: {
    brows: ["M62 60.4 Q68.5 56 76 59", "M84 60 Q92 58 98.5 61.5"],
    eyeRy: 8.8,
    pupils: { kind: "dots", dx: [2.6, 2.6], dy: -2.6 },
    mouth: "M73 90 Q80 91 87 89",
  },
  attention: {
    brows: ["M62 60 Q68.5 54.6 76 58.3", "M84 58.3 Q91.5 54.6 98 60"],
    eyeRy: 9.6,
    pupils: { kind: "dots", dx: [2.4, 2.4], dy: -0.5 },
    mouth: "M76 89 a4 4.5 0 1 0 8 0 a4 4.5 0 1 0 -8 0",
    mouthOpen: true,
  },
  success: {
    brows: ["M61 60.5 Q68 54.5 76 58.5", "M84 58.5 Q92 54.5 99 60.5"],
    eyeRy: 8.8,
    pupils: { kind: "dots", dx: [1.2, -1.2], dy: 0.8 },
    mouth: "M68 85 Q80 101 92 85 Z",
    mouthOpen: true,
  },
  confused: {
    brows: ["M62 60.4 Q68.5 55.6 76 59", "M84 61.5 Q92 61 98.5 63"],
    eyeRy: 8.8,
    pupils: { kind: "dots", dx: [-2.4, 2.4], dy: 1 },
    mouth: "M70 90 Q75 86 80 90 Q85 94 90 89",
  },
  mad: {
    brows: ["M62.5 59 L77 63.5", "M83 63.5 L97.5 59"],
    eyeRy: 7.4,
    pupils: { kind: "dots", dx: [2, -2], dy: 2.4 },
    mouth: FROWN,
  },
  sad: {
    brows: ["M61 63 L76 57.5", "M84 57.5 L99 63"],
    eyeRy: 8.8,
    pupils: { kind: "dots", dx: [0.8, -0.8], dy: 3 },
    mouth: FROWN,
  },
  excited: {
    brows: ["M62 60 Q68.5 55 76 58.4", "M84 58.4 Q91.5 55 98 60"],
    eyeRy: 9.8,
    pupils: { kind: "dots", dx: [0, 0], dy: 0 },
    mouth: "M67 84 Q80 104 93 84 Z",
    mouthOpen: true,
  },
  sleepy: {
    brows: ["M61 62 Q68 59.5 76 62", "M84 62 Q92 59.5 99 62"],
    eyeRy: 2.2,
    pupils: { kind: "none" },
    mouth: "M77 90 a3 2.4 0 1 0 6 0 a3 2.4 0 1 0 -6 0",
    mouthOpen: true,
  },
  love: {
    brows: ["M61 60.5 Q68 54.6 76 58.5", "M84 58.5 Q92 54.6 99 60.5"],
    eyeRy: 8.8,
    pupils: { kind: "hearts" },
    mouth: SMILE,
  },
  surprised: {
    brows: ["M63 59.6 Q69 55 76 58", "M84 58 Q91 55 97 59.6"],
    eyeRy: 10,
    pupils: { kind: "dots", dx: [0, 0], dy: 0, r: 3 },
    mouth: "M76.5 90 a3.5 4 0 1 0 7 0 a3.5 4 0 1 0 -7 0",
    mouthOpen: true,
  },
  shocked: {
    brows: ["M63 59.4 Q69 55.2 76 57.8", "M84 57.8 Q91 55.2 97 59.4"],
    eyeRy: 10.4,
    pupils: { kind: "dots", dx: [0, 0], dy: 0, r: 2 },
    mouth: "M75 91 a5 7 0 1 0 10 0 a5 7 0 1 0 -10 0",
    mouthOpen: true,
  },
  wow: {
    brows: ["M62 60 Q68.5 55 76 58.3", "M84 58.3 Q91.5 55 98 60"],
    eyeRy: 0,
    pupils: { kind: "ovals" },
    mouth: "M74 92 a6 7.5 0 1 0 12 0 a6 7.5 0 1 0 -12 0",
    mouthOpen: true,
  },
  // Qutty's own: flattered and a little shy. Soft brows, the eyes glancing down and away, a small
  // closed smile; the rosy cheeks, their "///" lines and a sparkle are its extras.
  blush: {
    brows: ["M61.5 61 Q68 57 76 58.4", "M84 58.4 Q92 57 98.5 61"],
    eyeRy: 7.6,
    pupils: { kind: "dots", dx: [-2.2, -2.2], dy: 2.4, r: 3.4 },
    mouth: "M76 90.5 Q80 92.8 84 90.5",
  },
};

/** A five-pointed star centred on (x, y) with outer radius `r`. */
const star = (x: number, y: number, r: number) => {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(
      `${(x + rad * Math.cos(a)).toFixed(1)} ${
        (y + rad * Math.sin(a)).toFixed(1)
      }`,
    );
  }
  return `M${pts.join(" L")} Z`;
};

/** A small heart centred on (x, y). */
const heart = (x: number, y: number, s: number) =>
  `M${x} ${y + s * 0.9} C${x - s * 1.6} ${y - s * 0.2} ${x - s * 0.7} ${
    y - s * 1.3
  } ${x} ${y - s * 0.4} C${x + s * 0.7} ${y - s * 1.3} ${x + s * 1.6} ${
    y - s * 0.2
  } ${x} ${y + s * 0.9} Z`;

/** The pupils of `face` for eyes centred at x 70 and 90, y 72. */
function Pupils({ face }: { face: Face }) {
  const p = face.pupils;
  if (p.kind === "none") return null;
  if (p.kind === "ovals") {
    return (
      <>
        <ellipse cx="70" cy="72" rx="4.2" ry="6.6" />
        <ellipse cx="90" cy="72" rx="4.2" ry="6.6" />
      </>
    );
  }
  if (p.kind === "stars") {
    return (
      <g class="companion-star-eyes">
        <path d={star(70, 72, 5.4)} />
        <path d={star(90, 72, 5.4)} />
      </g>
    );
  }
  if (p.kind === "hearts") {
    return (
      <g class="companion-heart-eyes">
        <path d={heart(70, 72, 4.6)} />
        <path d={heart(90, 72, 4.6)} />
      </g>
    );
  }
  const r = p.r ?? 3.6;
  return (
    <>
      <circle cx={70 + p.dx[0]} cy={72 + p.dy} r={r} />
      <circle cx={90 + p.dx[1]} cy={72 + p.dy} r={r} />
      <path class="companion-glint" d={glint(70 + p.dx[0], 72 + p.dy, r)} />
      <path class="companion-glint" d={glint(90 + p.dx[1], 72 + p.dy, r)} />
    </>
  );
}

/**
 * Qutty's own: the catch-light on a dot pupil of radius `r` centred on (x, y): a small round
 * highlight up and to the left (paths, so `.companion-eyes circle` stays the two pupils).
 */
const glint = (x: number, y: number, r: number) => {
  const g = +(r * 0.3).toFixed(2);
  const gx = +(x - r * 0.32 - g).toFixed(2);
  const gy = +(y - r * 0.36).toFixed(2);
  return `M${gx} ${gy} a${g} ${g} 0 1 0 ${2 * g} 0 a${g} ${g} 0 1 0 ${
    -2 * g
  } 0`;
};

/**
 * Qutty's own: rosy cheeks (a soft radial gradient, `#companion-cheek`) on the happy moods and the
 * blush, below the outer corner of each eye.
 */
function Cheeks({ big }: { big?: boolean }) {
  const [rx, ry, cy] = big ? [7.6, 4.6, 84] : [6, 3.6, 84.5];
  return (
    <g class="companion-cheeks">
      <ellipse cx="61" cy={cy} rx={rx} ry={ry} />
      <ellipse cx="99" cy={cy} rx={rx} ry={ry} />
    </g>
  );
}

/** The extras a mood adds around the head: a question mark, steam, a tear, z's, hearts, blush. */
function Extras({ mood }: { mood: FaceMood }) {
  switch (mood) {
    case "success":
    case "excited":
      return <Cheeks />;
    case "blush":
      return (
        <g class="companion-extra companion-blushing">
          <Cheeks big />
          <g class="companion-blush-lines">
            <path d="M57.4 86.4 l2 -3.4 M60.4 86.8 l2 -3.4 M63.4 87.2 l2 -3.4" />
            <path d="M94.6 87.2 l2 -3.4 M97.6 86.8 l2 -3.4 M100.6 86.4 l2 -3.4" />
          </g>
          <path
            class="companion-blush-sparkle"
            d="M107 46 q0.8 3.2 4 4 q-3.2 0.8 -4 4 q-0.8 -3.2 -4 -4 q3.2 -0.8 4 -4 Z"
          />
        </g>
      );
    case "confused":
      return (
        <text class="companion-extra companion-question" x="112" y="52">?</text>
      );
    case "mad":
      return (
        <g class="companion-extra companion-steam">
          <path d="M44 50 q-4 -6 0 -12 q4 -6 0 -12" />
          <path d="M116 50 q4 -6 0 -12 q-4 -6 0 -12" />
        </g>
      );
    case "sad":
      return (
        <path
          class="companion-extra companion-tear"
          d="M63 82 q-3 6 0 8 q3 -2 0 -8 Z"
        />
      );
    case "sleepy":
      return (
        <g class="companion-extra companion-zs">
          <text x="110" y="52">z</text>
          <text x="120" y="40">z</text>
          <text x="131" y="28">Z</text>
        </g>
      );
    case "love":
      return (
        <g class="companion-extra">
          <g class="companion-blush">
            <ellipse cx="62" cy="86" rx="5" ry="3" />
            <ellipse cx="98" cy="86" rx="5" ry="3" />
          </g>
          <g class="companion-floating-hearts">
            <path d={heart(120, 44, 5)} />
            <path d={heart(36, 36, 4)} />
          </g>
        </g>
      );
    case "surprised":
      return (
        <text class="companion-extra companion-exclaim" x="112" y="50">!</text>
      );
    case "shocked":
      return (
        <g class="companion-extra companion-zaps">
          <path d="M40 54 l-8 -4 M38 66 l-9 0 M40 78 l-8 4" />
          <path d="M120 54 l8 -4 M122 66 l9 0 M120 78 l8 4" />
        </g>
      );
    case "wow":
      return (
        <ellipse
          class="companion-extra companion-tongue"
          cx="80"
          cy="96.5"
          rx="4.2"
          ry="2.4"
        />
      );
    default:
      return null;
  }
}

// --- Qutty's own: hot ---------------------------------------------------------------------------
// Not one of the example's 13 moods (lib/companion/face-machine.ts MOODS stays the example's, and
// tests/companion_look_test.ts checks those unchanged): the face the companion wears, while it is
// otherwise idle, when the CPU or the GPU has been busy for a while (lib/sysstats.ts, the `hot`
// prop). Drawn in the example's style: the same eyes, brows and ink, a flushed bead, a panting
// mouth with the wow face's tongue, sweat drops like the sad face's tear and heat rising like the
// mad face's steam. Its CSS is in public/styles.css, "The companion is hot" (after the example's
// block).

/** The hot face: worried brows, tired eyes, a panting open mouth. */
export const HOT_FACE: Face = {
  brows: ["M61 61.5 Q68 58 76 57", "M84 57 Q92 58 99 61.5"],
  eyeRy: 6.6,
  pupils: { kind: "dots", dx: [0.6, -0.6], dy: 1.6, r: 3.2 },
  mouth: "M72 87 Q80 84 88 87 Q87 97 80 97 Q73 97 72 87 Z",
  mouthOpen: true,
};

/** The flush on the bead, under the face: the steel warming to red-orange at the rim. */
function HotFlush() {
  return (
    <g class="companion-hot-flush" aria-hidden="true">
      <radialGradient id="companion-flush" cx="0.5" cy="0.55" r="0.55">
        <stop offset="0.35" stop-color="#ff9a4a" stop-opacity="0.12" />
        <stop offset="1" stop-color="#e5401c" stop-opacity="0.62" />
      </radialGradient>
      <circle cx="80" cy="76" r="29" fill="url(#companion-flush)" />
    </g>
  );
}

/** The hot face's extras: flushed cheeks, the tongue out, sweat drops, heat rising off the head. */
function HotExtras() {
  return (
    <g class="companion-extra companion-hot">
      <g class="companion-hot-cheeks">
        <ellipse cx="61" cy="85" rx="5" ry="3" />
        <ellipse cx="99" cy="85" rx="5" ry="3" />
      </g>
      <ellipse class="companion-tongue" cx="80" cy="94.6" rx="3.8" ry="2.3" />
      <g class="companion-sweat">
        <path d="M105 55 q-3 6 0 8 q3 -2 0 -8 Z" />
        <path d="M55 61 q-2.4 5 0 6.6 q2.4 -1.6 0 -6.6 Z" />
      </g>
      <g class="companion-heat">
        <path d="M68 44 q-2.5 -3.5 0 -7 q2.5 -3.5 0 -7" />
        <path d="M80 41 q-2.5 -3.5 0 -7 q2.5 -3.5 0 -7" />
        <path d="M92 44 q-2.5 -3.5 0 -7 q2.5 -3.5 0 -7" />
      </g>
    </g>
  );
}

/**
 * Qutty's own colour accents (public/styles.css, "Colour accents"): the irises (a deep teal ring
 * around a dark pupil), the warm inside of an open mouth, and the rosy cheeks. A `<defs>` of its
 * own, after the bead's shading (which stays the example's).
 */
function AccentDefs() {
  return (
    <defs class="companion-accent-defs">
      <radialGradient id="companion-iris" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="#0c1a22" />
        <stop offset="0.42" stop-color="#0f2530" />
        <stop offset="0.5" stop-color="#1b7f8e" />
        <stop offset="0.86" stop-color="#14606f" />
        <stop offset="1" stop-color="#0c3a44" />
      </radialGradient>
      <linearGradient id="companion-mouth-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#4f1a22" />
        <stop offset="0.55" stop-color="#7a2632" />
        <stop offset="1" stop-color="#d0566a" />
      </linearGradient>
      <radialGradient id="companion-cheek" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="#ff5f86" stop-opacity="0.9" />
        <stop offset="0.55" stop-color="#ff7d9b" stop-opacity="0.55" />
        <stop offset="1" stop-color="#ff9ab2" stop-opacity="0" />
      </radialGradient>
    </defs>
  );
}

/** The props of {@linkcode the companion}. */
export interface CompanionFaceProps {
  /** The move on screen. */
  readonly state: FaceState;
  /** Accessible name (default "Companion": Settings → Companion → Name). */
  readonly label?: string;
  /** The mood of the message on screen: its face, and a tinted rim on the bead (none: bare steel). */
  readonly mood?: FaceMood;
  /**
   * What the companion is doing in a voice turn (`data-voice`): listening, thinking or speaking.
   */
  readonly voice?: "listening" | "thinking" | "speaking";
  /**
   * The audio level step, 0 to `LEVEL_STEPS`: while speaking how open the mouth is (lip-sync),
   * while listening the microphone's (the pulse).
   */
  readonly level?: number;
  /**
   * Lively (`data-lively`): the pupils follow the pointer (the `--companion-gaze-*` offsets the
   * overlay sets) and the face eases between its micro-expressions.
   */
  readonly lively?: boolean;
  /**
   * A micro-expression on the neutral face (`data-expr`; lib/companion/face-life.ts), or
   * `delighted` while the pointer is over it. Only transforms of the face's parts: the shapes stay
   * the example's.
   */
  readonly expression?: MicroExpression | "delighted";
  /**
   * Qutty's own: the machine is hot (`data-mood="hot"`). Only drawn over the neutral face: the
   * page passes it only while the companion is otherwise idle (lib/sysstats.ts `mayShowHot`).
   */
  readonly hot?: boolean;
  /**
   * Qutty's own: the companion sleeps at night (`data-asleep`, with the example's `sleepy` mood):
   * its nod and z's slow down (public/styles.css, "The companion sleeps").
   */
  readonly asleep?: boolean;
  /** Qutty's own: the companion stretches as it wakes up (`data-stretch`). */
  readonly stretching?: boolean;
}

/** The mouth to draw: the lip-sync shape while speaking, else the mood's. */
function mouthFor(
  face: Face,
  voice: CompanionFaceProps["voice"],
  step: number,
) {
  if (voice === "speaking") return mouthShape(step);
  return { d: face.mouth, open: face.mouthOpen === true };
}

/**
 * The avatar's crop of the drawing: the bead head (centre (80, 76), radius 29) with a little room
 * around it and some above it for the moods' rising extras (z's, ?, !, hearts); the extras beside
 * the head draw outside the box (`overflow: visible`). In the drawing's own coordinates, so the
 * face is the example's, unchanged.
 */
export const COMPANION_VIEWBOX = [49, 33, 62, 74] as const;

/**
 * CSS px per unit of the drawing: the head 2 times the size it had on the example's crossed-
 * triangle the companion in its 120 x 150 desktop window (0.75 px per unit there, a 43.5 px bead;
 * here 87 px).
 */
export const COMPANION_SCALE = 0.75 * 2;

const [VB_X, VB_Y, VB_W, VB_H] = COMPANION_VIEWBOX;

/** The companion's face: the steel bead head of the example's paper clip, without the wire. */
export function CompanionFace(
  {
    state,
    label = DEFAULT_COMPANION_NAME,
    mood,
    voice,
    level = 0,
    lively,
    expression,
    hot,
    asleep,
    stretching,
  }: CompanionFaceProps,
) {
  const current = mood ?? "neutral";
  const isHot = hot === true && current === "neutral";
  const face = isHot ? HOT_FACE : FACES[current];
  const mouth = mouthFor(face, voice, level);
  const listen = voice === "listening" ? Math.min(1, level / LEVEL_STEPS) : 0;
  return (
    <svg
      class="companion-avatar"
      data-state={state}
      data-mood={isHot ? "hot" : current}
      data-voice={voice}
      data-lively={lively ? "" : undefined}
      data-expr={expression}
      data-asleep={asleep && current === "sleepy" ? "" : undefined}
      data-stretch={stretching ? "" : undefined}
      style={{ "--companion-listen": listen }}
      viewBox={`${VB_X} ${VB_Y} ${VB_W} ${VB_H}`}
      width={String(VB_W * COMPANION_SCALE)}
      height={String(VB_H * COMPANION_SCALE)}
      role="img"
      aria-label={label}
    >
      <defs>
        <radialGradient id="companion-bead" cx="0.36" cy="0.32" r="0.75">
          <stop offset="0" stop-color="#ffffff" />
          <stop offset="0.35" stop-color="#d9dee3" />
          <stop offset="0.8" stop-color="#8b959e" />
          <stop offset="1" stop-color="#5d666e" />
        </radialGradient>
      </defs>
      <AccentDefs />
      <g class="companion-face">
        <g class="companion-head">
          <circle
            class="companion-bead"
            cx="80"
            cy="76"
            r="29"
            fill="url(#companion-bead)"
          />
          {isHot && <HotFlush />}
          <g class="companion-brows">
            <path d={face.brows[0]} />
            <path d={face.brows[1]} />
          </g>
          <g class="companion-eyes">
            {face.eyeRy > 0 && (
              <>
                <ellipse
                  class="companion-eye-white"
                  cx="70"
                  cy="72"
                  rx="7.2"
                  ry={face.eyeRy}
                />
                <ellipse
                  class="companion-eye-white"
                  cx="90"
                  cy="72"
                  rx="7.2"
                  ry={face.eyeRy}
                />
              </>
            )}
            <Pupils face={face} />
          </g>
          <path
            class={mouth.open ? "companion-mouth is-open" : "companion-mouth"}
            d={mouth.d}
          />
          {isHot ? <HotExtras /> : <Extras mood={current} />}
        </g>
        <g class="companion-thought" aria-hidden="true">
          <circle cx="112" cy="40" r="2.6" />
          <circle cx="121" cy="32" r="2.6" />
          <circle cx="130" cy="24" r="2.6" />
        </g>
        <g class="companion-sparkles" aria-hidden="true">
          <path d="M38 44 l3 -8 l3 8 l-3 8 z" />
          <path d="M116 64 l2.5 -6 l2.5 6 l-2.5 6 z" />
          <path d="M40 100 l2 -5 l2 5 l-2 5 z" />
        </g>
      </g>
    </svg>
  );
}
