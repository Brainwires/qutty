// Server-only building blocks (no "use client": they ship no JavaScript).

import type { ReactNode } from "denext";

/** A tile as the app draws it: a header strip over a body; `focused` wears the accent ring. */
export function Tile(
  { title, when, dot, focused, class: cls, bodyClass, children, id, labelledBy }: {
    title: string;
    when?: string;
    dot?: "accent" | "amber" | "green";
    focused?: boolean;
    class?: string;
    bodyClass?: string;
    children?: ReactNode;
    id?: string;
    labelledBy?: string;
  },
) {
  return (
    <section
      class={["tile", focused && "is-focused", cls].filter(Boolean).join(" ")}
      id={id}
      aria-labelledby={labelledBy}
    >
      <div class="tile-head" aria-hidden="true">
        {dot && <span class={`dot ${dot}`} />}
        <span>{title}</span>
        {when && <span class="when">{when}</span>}
      </div>
      <div class={bodyClass ?? "tile-body"}>{children}</div>
    </section>
  );
}

export interface ShotInfo {
  src: string;
  alt: string;
  caption: string;
}

/** The screenshots (site/scripts/screenshots.ts takes them, 2000x1250 WebP). */
export const SHOTS = {
  cascade: {
    src: "/screenshots/cascade.webp",
    alt:
      "Qutty with five terminals in the cascade layout: the focused one on the left is largest, the others step down in size",
    caption: "The cascade layout: the focused terminal is largest, the rest step back.",
  },
  harness: {
    src: "/screenshots/harness.webp",
    alt:
      "Claude Code running in a Qutty tile, framed by a header card, a prompt box and a side rail",
    caption: "Claude Code in a terminal tile, with Qutty's frame around its own UI.",
  },
  browser: {
    src: "/screenshots/browser.webp",
    alt: "A web tile showing a local development server's dashboard beside a terminal",
    caption: "A web tile beside the terminal that printed its address.",
  },
  companion: {
    src: "/screenshots/companion.webp",
    alt:
      "The companion, a round face in the corner, answering a question about the tiles in a speech bubble",
    caption: "The companion answers about your tiles.",
  },
  light: {
    src: "/screenshots/theme-light.webp",
    alt: "Qutty in the light Cloud theme with four terminals",
    caption: "Cloud, one of three light themes.",
  },
  dark: {
    src: "/screenshots/theme-dark.webp",
    alt: "Qutty in the dark Plum theme with four terminals",
    caption: "Plum, one of three dark themes.",
  },
} satisfies Record<string, ShotInfo>;

/** A screenshot in a window frame. `eager` for the one above the fold. */
export function Shot({ shot, eager }: { shot: ShotInfo; eager?: boolean }) {
  return (
    <figure class="window">
      <img
        src={shot.src}
        alt={shot.alt}
        width={2000}
        height={1250}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        fetchpriority={eager ? "high" : undefined}
      />
      <figcaption>{shot.caption}</figcaption>
    </figure>
  );
}

/** Structured data, inlined. `json` is already escaped for a script element. */
export function JsonLd({ json }: { json: string }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
