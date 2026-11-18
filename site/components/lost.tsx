// The not-found page's content: app/not-found.tsx (served by `deno task start`) and
// app/404/page.tsx (exported, then copied to out/404.html by scripts/seo.ts, since Denext's
// static export writes no file for app/not-found.tsx).

import { Link } from "denext";
import { Tile } from "./ui.tsx";

export const LOST_METADATA = {
  title: "Page not found — Qutty",
  description: "There is no page at this address on qutty.org.",
  robots: { index: false, follow: true },
};

export function Lost() {
  return (
    <div class="wrap">
      <div class="lost">
        <Tile title="zsh — ~" focused bodyClass="" labelledBy="lost-t">
          <pre class="term">
            <span class="p">$</span> cd this-page{"\n"}
            cd: no such file or directory: this-page
          </pre>
          <div class="tile-body">
            <h1 id="lost-t">This page doesn't exist.</h1>
            <p>
              The address may have changed. Start from the{" "}
              <Link href="/">home page</Link>, or go straight to{" "}
              <Link href="/download">downloads</Link>.
            </p>
          </div>
        </Tile>
      </div>
    </div>
  );
}
