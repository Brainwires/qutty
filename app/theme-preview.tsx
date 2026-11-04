// A tiny SVG of a colour theme, the size of a pattern preview: the theme's canvas and bar, a
// focused tile (header strip, accent border) with a few lines of ANSI-coloured "text", and an
// older tile beside it. Drawn from the theme's own colours, so it shows that theme whatever the
// current one is.

import type { ColorTheme } from "../lib/workspace/themes.ts";

const W = 72;
const H = 45;

/** [x, y, width, ANSI colour] of the "text" in the focused tile. */
const LINES: [number, number, number, keyof ColorTheme["terminal"]][] = [
  [6, 18, 7, "green"],
  [15, 18, 14, "foreground"],
  [6, 23, 18, "blue"],
  [6, 28, 6, "red"],
  [14, 28, 11, "yellow"],
  [6, 33, 13, "magenta"],
  [21, 33, 7, "cyan"],
];

export function ThemePreview({ theme }: { theme: ColorTheme }) {
  const c = theme.chrome;
  const t = theme.terminal;
  return (
    <svg
      class="theme-preview"
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      aria-hidden="true"
    >
      <rect width={W} height={H} rx={3} fill={c["--ink"]} />
      <rect width={W} height={6} fill={c["--ink-2"]} />
      <rect x={4} y={1.5} width={10} height={3} rx={1} fill={c["--accent"]} />
      <rect x={16} y={1.5} width={8} height={3} rx={1} fill={c["--line-2"]} />
      <rect
        x={3.5}
        y={9.5}
        width={43}
        height={32}
        rx={2}
        fill={t.background}
        stroke={c["--accent"]}
      />
      <rect x={4} y={10} width={42} height={4} fill={c["--head"]} />
      {LINES.map(([x, y, w, key]) => (
        <rect
          key={`${x},${y}`}
          x={x}
          y={y}
          width={w}
          height={2}
          rx={1}
          fill={t[key]}
        />
      ))}
      <rect
        x={50.5}
        y={9.5}
        width={18}
        height={32}
        rx={2}
        fill={t.background}
        stroke={c["--line"]}
      />
      <rect x={51} y={10} width={17} height={4} fill={c["--head"]} />
      <rect x={53} y={18} width={10} height={2} rx={1} fill={c["--text-3"]} />
      <rect x={53} y={23} width={13} height={2} rx={1} fill={c["--text-3"]} />
    </svg>
  );
}
