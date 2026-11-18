import type { LayoutProps } from "denext/server";
import { Link } from "denext";
import { SiteNav } from "../components/site-nav.tsx";
import { latestRelease, RELEASES_URL } from "../lib/release.ts";
import {
  DENEXT_URL,
  DESCRIPTION,
  GITHUB_URL,
  LICENSE_URL,
  SITE_ORIGIN,
  TAGLINE,
} from "../lib/site.ts";

export const metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: `Qutty — ${TAGLINE}`,
  description: DESCRIPTION,
  // The static OG/Twitter bits every page shares. The per-page og:title/description/url,
  // twitter:title/description and the canonical link are added by scripts/seo.ts from each
  // page's own <title> and description.
  openGraph: {
    type: "website",
    siteName: "Qutty",
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Qutty, a tiling terminal" }],
  },
  twitter: {
    card: "summary_large_image",
    images: "/og.png",
  },
  head: [
    `<link rel="preload" href="/fonts/martian-mono-latin.woff2" as="font" type="font/woff2" crossorigin>`,
    `<link rel="stylesheet" href="/styles.css">`,
    `<link rel="icon" type="image/png" sizes="32x32" href="/icons/icon-32.png">`,
    `<link rel="apple-touch-icon" href="/icons/icon-180.png">`,
    `<link rel="manifest" href="/site.webmanifest">`,
    `<meta name="theme-color" content="#10141a" media="(prefers-color-scheme: dark)">`,
    `<meta name="theme-color" content="#e5e9ef" media="(prefers-color-scheme: light)">`,
    `<meta name="color-scheme" content="dark light">`,
  ].join(""),
};

export default async function RootLayout({ children }: LayoutProps) {
  const release = await latestRelease();
  return (
    <>
      <a class="skip" href="#main">Skip to content</a>
      <header class="bar">
        <div class="wrap bar-inner">
          <Link class="brand" href="/">
            <img src="/icons/logo-96.webp" alt="" width={28} height={28} />
            <span>Qutty</span>
          </Link>
          <SiteNav github={GITHUB_URL} />
        </div>
      </header>
      <main id="main">{children}</main>
      <footer class="foot">
        <div class="wrap foot-inner">
          <p class="foot-note">
            Qutty {release.version}. MIT licensed, by{" "}
            <a href="https://github.com/Brainwires" rel="noopener">Brainwires</a>.
          </p>
          <ul>
            <li>
              <a href={GITHUB_URL} rel="noopener">GitHub</a>
            </li>
            <li>
              <a href={RELEASES_URL} rel="noopener">Releases</a>
            </li>
            <li>
              <a href={LICENSE_URL} rel="noopener">License</a>
            </li>
            <li>
              <a href={DENEXT_URL} rel="noopener">Built with Denext</a>
            </li>
          </ul>
        </div>
      </footer>
    </>
  );
}
