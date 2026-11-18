# site: qutty.org

The Qutty website, a [Denext](https://denext.dev) app of its own (its own `deno.json`, Denext from
JSR), static-exported to plain HTML in `out/`. Every page is server-rendered at export time and
works with no JavaScript. Two small client components boot Denext's client runtime on every page:
the header's page links (`components/site-nav.tsx`) and the hero's download button
(`components/download-button.tsx`). With it, the links navigate softly, without a page reload.

```sh
deno task dev           # http://localhost:3000
deno task site          # export + seo: the deployable out/
deno task export        # out/: one HTML file per page (+ the client bundles)
deno task seo           # post-export: canonical/OG tags, Markdown twins, sitemap, robots, llms.txt, 404.html
deno task og            # redraw public/og.png (1200x630; committed)
deno task screenshots   # retake public/screenshots/*.webp from the app (headless Chromium)
deno task check         # type-check (CI also runs deno fmt --check and deno lint here)
deno task start         # serve a `deno task build` with Denext's server instead
deno task deploy        # build and publish to qutty.org (see Deploy)
```

The repo root's lint, fmt and fallow skip `site/`; CI's "Website (qutty.org)" job checks and builds
it instead.

## Pages

- `/` (`app/page.tsx`): the hero (a cascade of tiles, the focused one holding the pitch and the
  download button), screenshots, highlights.
- `/features`, `/download`, `/changelog`: the changelog is the repo's `CHANGELOG.md`, rendered at
  build time with `denext/markdown` (`lib/changelog.ts`), one anchor per version (`#v0-6-1`).
- `/404` (`app/404/page.tsx`): moved to `out/404.html` by `scripts/seo.ts`. Denext's static export
  writes no file for `app/not-found.tsx`, which still serves the same page under `deno task start`.

## Downloads

`lib/release.ts` asks GitHub for the latest release at build time (`GITHUB_TOKEN` is sent when set),
so the HTML carries the version and direct links to each file, with sizes. Without an answer
(offline, rate-limited, or `QUTTY_SITE_OFFLINE=1`) it uses the version in the repo's `deno.json` and
builds the links from the release file names. The download button starts as a link to `/download`;
once hydrated it points at the `.dmg` for the visitor's Mac (Apple Silicon or Intel, from User-Agent
Client Hints or the WebGL renderer) or the AppImage for their Linux architecture, and stays on
`/download` when it can't tell.

## Screenshots

`scripts/screenshots.ts` exports the app (the repo root's `deno task export`), serves it, and drives
it in **headless** Chromium through the e2e suite's helpers (`tests/e2e/harness.ts`) with the demo
backend (`?pty=demo`): demo shells, demo agents and the demo companion brain. It never opens a
window. It writes 2000 px wide WebP files (via `cwebp`) to `public/screenshots/`: the cascade
layout, a Claude Code harness tile, a web tile, the companion, and the Cloud (light) and Plum (dark)
themes. `SHOTS_ONLY=cascade,companion` retakes some; `SHOTS_NO_BUILD=1` reuses the app's current
`out/`.

## SEO and agents

Per page: title, description, canonical, Open Graph and Twitter tags (the shared image is
`public/og.png`, drawn by `scripts/gen-og.tsx` with Denext's `ImageResponse`). The home and download
pages carry JSON-LD `SoftwareApplication`. `scripts/seo.ts` (adapted from Denext's own docs site)
writes `sitemap.xml`, `robots.txt`, `llms.txt` and a Markdown twin of every page, reachable at
`<path>.md` or at the page's own URL with `Accept: text/markdown` (`deploy/nginx.conf`).

## Deploy

qutty.org is served from the host `biscuits` by an `nginx:alpine` container named `qutty-site`,
published on `127.0.0.1:5710` and reached through a Cloudflare tunnel. The container serves
`biscuits:~/qutty.org` (mounted read-only at `/usr/share/nginx/html`) with
`biscuits:~/qutty.org.nginx.conf` as its config. That setup exists already; deploying only replaces
the files and the config.

`deploy/nginx.conf` is the source of truth for that config: content negotiation to the Markdown
twins, `Cache-Control: no-store` (so Cloudflare serves every change at once), and
`error_page 404 /404.html`.

```sh
deno task deploy        # from site/; QUTTY_DEPLOY_HOST overrides the ssh host
```

`scripts/deploy.sh`:

1. builds: `deno task export`, then `deno task seo`, then `deno task og` if `public/og.png` is
   missing;
2. syncs `out/` with `rsync -az --delete out/ biscuits:qutty.org/`;
3. copies `deploy/nginx.conf` to `biscuits:qutty.org.nginx.conf` and runs
   `docker exec qutty-site nginx -s reload`;
4. curls `http://127.0.0.1:5710/` over ssh and fails unless it answers 200.

There is no deploy workflow: deploys are run by hand after a change merges.
