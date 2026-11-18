// What every page shares: the origin, the words, the links.

/** The production origin (keep in sync with scripts/seo.ts). */
export const SITE_ORIGIN = "https://qutty.org";

export const TAGLINE = "The terminal you're using gets the most space.";

export const DESCRIPTION =
  "Qutty is a tiling terminal for macOS and Linux, built for coding agents. The focused terminal gets the most space, agents in your tiles can talk to each other, and Claude Code, Codex and other harnesses get a GUI around their terminal. Free and open source (MIT).";

export const GITHUB_URL = "https://github.com/Brainwires/qutty";
export const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;
export const DENEXT_URL = "https://denext.dev";

/** The JSON-LD `SoftwareApplication` for the home and download pages. */
export function softwareJsonLd(
  release: { version: string; url: string },
  downloadUrl: string,
): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Qutty",
    description: DESCRIPTION,
    url: SITE_ORIGIN,
    image: `${SITE_ORIGIN}/og.png`,
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "Terminal emulator",
    operatingSystem: "macOS, Linux",
    softwareVersion: release.version,
    downloadUrl,
    releaseNotes: `${SITE_ORIGIN}/changelog`,
    license: "https://opensource.org/licenses/MIT",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    author: { "@type": "Organization", name: "Brainwires", url: "https://github.com/Brainwires" },
    codeRepository: GITHUB_URL,
  }).replace(/</g, "\\u003c");
}
