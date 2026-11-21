/**
 * The starter look Settings → Companion → Look → "Create a look…" copies into the looks folder: a
 * `look.json`, a placeholder `idle.svg` and a README that lists every picture a look may have,
 * what it is for and what it falls back to (lib/companion/looks.ts `LOOK_IMAGES`). The desktop
 * writes it (desktop/companion-looks.ts); the demo keeps it in memory.
 *
 * Pure and client-safe.
 *
 * @module
 */

import { LOOK_IMAGES, LOOK_LIMITS } from "./looks.ts";

/** The starter look's folder name (and id): `my-look`, then `my-look-2`, `my-look-3`, … */
export function starterFolderName(taken: ReadonlySet<string>): string {
  if (!taken.has("my-look")) return "my-look";
  let n = 2;
  while (taken.has(`my-look-${n}`)) n++;
  return `my-look-${n}`;
}

/** A placeholder face: a soft round blob with two eyes and a smile (replace it with yours). */
const STARTER_IDLE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <!-- A placeholder: draw your own idle.svg (or idle.png) and delete this one. -->
  <circle cx="50" cy="54" r="38" fill="#7fc8a9" stroke="#2d5a4a" stroke-width="3"/>
  <circle cx="38" cy="48" r="5" fill="#1d2b26"/>
  <circle cx="62" cy="48" r="5" fill="#1d2b26"/>
  <path d="M38 64 Q50 73 62 64" fill="none" stroke="#1d2b26" stroke-width="3" stroke-linecap="round"/>
</svg>
`;

/** The starter look's `look.json`. */
function starterManifest(id: string): string {
  return `${
    JSON.stringify(
      {
        id,
        name: "My look",
        author: "",
        version: "1.0",
        description: "A look of my own.",
      },
      null,
      2,
    )
  }\n`;
}

/** The starter look's README: the procedure, every picture with its use and fallback, limits. */
function starterReadme(id: string): string {
  const rows = LOOK_IMAGES.map((s) =>
    `| \`${s.id}\` | ${s.use} | ${
      s.fallback ? `\`${s.fallback}\`` : "(required)"
    } |`
  );
  return `# My look

A look for Qutty's companion. This folder is the look: Qutty reads the
pictures in it and nothing else.

## How to make it yours

1. Draw a picture of your companion resting and save it here as \`idle.png\`
   (or \`idle.svg\`, \`idle.webp\`, \`idle.gif\`). Delete the placeholder
   \`idle.svg\` if you keep a PNG.
2. Edit \`look.json\`: give the look a \`name\` and put yours as \`author\`.
   Keep \`"id": "${id}"\` (lower-case letters, digits and dashes) unless you
   rename the folder too.
3. In Qutty: Settings → Companion → Look → Reload looks, then pick it.

That is all a look needs. Add more pictures whenever you like: each is named
after the mood it shows. A missing picture uses the one in the "Falls back to"
column, and so on until \`idle\`.

## The pictures

| File name | What it is for | Falls back to |
| --- | --- | --- |
${rows.join("\n")}

## Talking

Add mouth frames \`speak-0.png\`, \`speak-1.png\`, \`speak-2.png\`, … (up to
${LOOK_LIMITS.speakFrames}): \`speak-0\` with the mouth closed, the last one
wide open. Qutty picks the frame for how loud each syllable is. With fewer than
two frames the companion bobs gently while it talks instead.

## Tweaks (optional)

A \`look.css\` file can change how the companion's bubble looks while this
look is on, such as its colours. Its rules only apply inside the companion.
\`@import\` and links to the web are removed. \`url(name.png)\` may name one of
this folder's pictures.

## Limits

- Pictures: SVG, PNG, WebP or GIF, at most ${
    LOOK_LIMITS.imageBytes / 1024
  } KB each and ${LOOK_LIMITS.totalBytes / 1024 / 1024} MB together.
- No scripts: pictures are shown as images, so an SVG's scripts never run.
- Files in sub-folders, links (aliases) and other file names are ignored.
- \`size\` in look.json (\`{ "w": 120, "h": 120 }\`, ${LOOK_LIMITS.minSize} to ${LOOK_LIMITS.maxSize})
  sets how big the companion is drawn.
`;
}

/** The starter look's files by name. */
export function starterFiles(id: string): Record<string, string> {
  return {
    "look.json": starterManifest(id),
    "idle.svg": STARTER_IDLE_SVG,
    "README.md": starterReadme(id),
  };
}
