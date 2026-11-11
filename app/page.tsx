// The only route. A Server Component shell (pre-rendered into the static export) around the
// workspace island, which is where everything interactive lives.
import type { PageProps } from "denext/server";
import { Workspace } from "./workspace.tsx";
import { FRAME_SRC } from "../lib/web/url.ts";

export const metadata = { title: "Qutty" };

/**
 * Denext's strict CSP plus `frame-src` for web tiles: exactly the loopback and local dev origins
 * the iframe engine shows (lib/web/url.ts), any port. Without it frames fall back to
 * `default-src 'self'` and every web tile would be blocked.
 */
export const csp = { frameSrc: [...FRAME_SRC] };

export default function Home(_props: PageProps) {
  return <Workspace />;
}
