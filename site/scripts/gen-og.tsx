// The Open Graph share image (public/og.png, 1200x630), drawn with Denext's own ImageResponse
// (satori + resvg, bundled font: offline). Modelled on Denext's docs site. Run once; commit the PNG.
//
//   deno task og
//
// Referenced site-wide from app/layout.tsx (openGraph.images / twitter.images). The picture is
// the hero's idea: a cascade of tiles, the focused one largest, in Qutty's Sea Glass colours.

import type { ReactNode } from "denext";
import { ImageResponse as ImageResponseValue } from "denext/server";
import { encodeBase64 } from "@std/encoding/base64";

// ImageResponse is exported with a non-constructable public type; it IS a class at runtime.
const ImageResponse = ImageResponseValue as unknown as new (
  element: unknown,
  options: Record<string, unknown>,
) => { arrayBuffer(): Promise<ArrayBuffer> };

const OUT = new URL("../public/og.png", import.meta.url).pathname;
const ICON = await Deno.readFile(new URL("../public/icons/icon-192.png", import.meta.url));
const iconSrc = `data:image/png;base64,${encodeBase64(ICON)}`;

const C = {
  ink: "#0d1015",
  tile: "#0d1117",
  head: "#141a22",
  line: "#222a35",
  text: "#d9e0e8",
  text2: "#8e99a8",
  accent: "#7fd8c2",
  amber: "#f3c37a",
  green: "#8fd19e",
};

function Tile(
  { title, focused, flex, children, dot }: {
    title: string;
    focused?: boolean;
    flex: number;
    children?: ReactNode;
    dot?: string;
  },
) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex,
        background: C.tile,
        border: `2px solid ${focused ? C.accent : C.line}`,
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 34,
          padding: "0 16px",
          background: C.head,
          color: focused ? C.text : C.text2,
          fontSize: 16,
        }}
      >
        {dot
          ? (
            <div
              style={{ width: 9, height: 9, borderRadius: 9, background: dot, marginRight: 10 }}
            />
          )
          : null}
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "0 40px" }}>
        {children}
      </div>
    </div>
  );
}

const card = (
  <div
    style={{
      width: "100%",
      height: "100%",
      display: "flex",
      background: C.ink,
      padding: 28,
      fontFamily: "sans-serif",
      color: C.text,
    }}
  >
    <div style={{ display: "flex", flex: 1, gap: 10 }}>
      <Tile title="zsh — ~/qutty" focused flex={1.6}>
        <div style={{ display: "flex", alignItems: "center", marginTop: 48 }}>
          <img src={iconSrc} width={72} height={72} style={{ borderRadius: 16 }} />
          <span style={{ fontSize: 48, fontWeight: 700, marginLeft: 20, letterSpacing: "-0.02em" }}>
            Qutty
          </span>
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 60,
            fontWeight: 700,
            lineHeight: 1.06,
            letterSpacing: "-0.03em",
            marginTop: 40,
          }}
        >
          The terminal you're using gets the most space.
        </div>
        <div style={{ display: "flex", fontSize: 26, color: C.text2, marginTop: 28 }}>
          A tiling terminal for macOS and Linux, built for coding agents.
        </div>
      </Tile>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 10 }}>
        <Tile title="claude — ~/app" flex={1.3} dot={C.amber} />
        <div style={{ display: "flex", flex: 1, gap: 10 }}>
          <Tile title="ssh — prod" flex={1.3} />
          <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 10 }}>
            <Tile title="top" flex={1.3} dot={C.green} />
            <Tile title="vim" flex={1} />
          </div>
        </div>
      </div>
    </div>
  </div>
);

const res = new ImageResponse(card, { width: 1200, height: 630, offline: true });
const bytes = new Uint8Array(await res.arrayBuffer());
await Deno.writeFile(OUT, bytes);
console.log(`og image: ${bytes.length} bytes → ${OUT}`);
