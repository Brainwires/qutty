// The web tiles' icons: small inline SVGs on a 16-unit grid, stroked in `currentColor` so they
// follow the theme and the buttons' hover and disabled states. No icon font, no remote image.

const PATHS = {
  back: "M10 3.5 5.5 8l4.5 4.5",
  forward: "M6 3.5 10.5 8 6 12.5",
  reload: "M12.5 8a4.5 4.5 0 1 1-1.4-3.25M12.5 3v2.5H10",
  stop: "M4.5 4.5l7 7m0-7-7 7",
  home: "M3 7.5 8 3.5l5 4M4.5 6.5V12.5h7V6.5",
  external: "M9 3.5h3.5V7M12.5 3.5 7.5 8.5M11 9.5v3H3.5V5h3",
  star:
    "M8 2.8l1.6 3.3 3.6.5-2.6 2.5.6 3.6L8 11l-3.2 1.7.6-3.6-2.6-2.5 3.6-.5z",
  lock: "M5 7V5.5a3 3 0 0 1 6 0V7M4 7h8v5.5H4z",
  warn: "M8 2.8 13.5 12.5h-11zM8 6.5v3m0 1.5v.2",
  folder: "M2.5 4.5h4l1.2 1.3h5.8v6.7h-11z",
  chevron: "M6 4l4 4-4 4",
  down: "M4 6l4 4 4-4",
  up: "M4 10l4-4 4 4",
  more: "M4 8h.01M8 8h.01M12 8h.01",
  search: "M7 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zM10.3 10.3 13.5 13.5",
  close: "M4.5 4.5l7 7m0-7-7 7",
  clock: "M8 13a5 5 0 1 1 0-10 5 5 0 0 1 0 10zM8 5v3l2 1.5",
  plus: "M8 3.5v9M3.5 8h9",
  page: "M4 2.5h5l3 3v8H4zM9 2.5v3h3",
} as const;

export type WebIconName = keyof typeof PATHS;

/** Icon `name` (`filled`: the star, solid). */
export function WebIcon(
  props: { name: WebIconName; filled?: boolean; size?: number },
) {
  const size = String(props.size ?? 14);
  const fill = props.filled ? "currentColor" : "none";
  const dots = props.name === "more";
  return (
    <svg
      class={`web-icon web-icon-${props.name}`}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={PATHS[props.name]}
        fill={fill}
        stroke="currentColor"
        stroke-width={dots ? "2.6" : "1.5"}
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}
