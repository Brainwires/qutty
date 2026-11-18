// The release the download links point at, read once at build (export) time.
//
// First choice is GitHub's latest release (`GITHUB_TOKEN` is sent when set, for the rate limit),
// so the HTML carries the real version, asset URLs and sizes. Offline, or when the API refuses,
// the version comes from the repo's deno.json and the asset URLs are built from the release
// naming scheme (scripts/package-linux.ts, the release workflow), with no sizes.

export const REPO = "Brainwires/qutty";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;

export type Platform = "mac" | "linux";
export type Arch = "arm64" | "x86_64";
export type Format = "dmg" | "AppImage" | "deb" | "tar.gz";

export interface Asset {
  platform: Platform;
  arch: Arch;
  format: Format;
  name: string;
  url: string;
  /** Bytes (null when the API was not reachable). */
  size: number | null;
  /** The `.sha256` file published beside it. */
  sha256Url: string;
}

export interface Release {
  version: string;
  tag: string;
  url: string;
  /** ISO date (null offline). */
  publishedAt: string | null;
  assets: Asset[];
  /** Where the data came from: the GitHub API, or deno.json plus the naming scheme. */
  source: "github" | "fallback";
}

/** Every file a release publishes, by its name for `version`. */
function expectedAssets(version: string): Omit<Asset, "url" | "size" | "sha256Url">[] {
  const out: Omit<Asset, "url" | "size" | "sha256Url">[] = [];
  for (const arch of ["arm64", "x86_64"] as const) {
    out.push({ platform: "mac", arch, format: "dmg", name: `Qutty-${version}-${arch}.dmg` });
    out.push({
      platform: "linux",
      arch,
      format: "AppImage",
      name: `Qutty-${version}-${arch}.AppImage`,
    });
    out.push({ platform: "linux", arch, format: "deb", name: `Qutty-${version}-${arch}.deb` });
    out.push({
      platform: "linux",
      arch,
      format: "tar.gz",
      name: `Qutty-${version}-${arch}-linux.tar.gz`,
    });
  }
  return out;
}

const downloadUrl = (tag: string, name: string) => `${RELEASES_URL}/download/${tag}/${name}`;

async function repoVersion(): Promise<string> {
  const json = JSON.parse(await Deno.readTextFile(new URL("../../deno.json", import.meta.url)));
  return String(json.version);
}

function fallback(version: string): Release {
  const tag = `v${version}`;
  return {
    version,
    tag,
    url: `${RELEASES_URL}/tag/${tag}`,
    publishedAt: null,
    source: "fallback",
    assets: expectedAssets(version).map((a) => ({
      ...a,
      url: downloadUrl(tag, a.name),
      size: null,
      sha256Url: downloadUrl(tag, `${a.name}.sha256`),
    })),
  };
}

interface GhAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

async function fromGitHub(): Promise<Release | null> {
  if (Deno.env.get("QUTTY_SITE_OFFLINE") === "1") return null;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "qutty-site-build",
  };
  const token = Deno.env.get("GITHUB_TOKEN");
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      console.warn(`site: GitHub answered ${res.status} for the latest release; using deno.json`);
      return null;
    }
    const data = await res.json() as {
      tag_name: string;
      html_url: string;
      published_at: string;
      assets: GhAsset[];
    };
    const tag = data.tag_name;
    const version = tag.replace(/^v/, "");
    const byName = new Map(data.assets.map((a) => [a.name, a]));
    const assets: Asset[] = [];
    for (const want of expectedAssets(version)) {
      const got = byName.get(want.name);
      if (!got) continue; // a release without that build (never so far): leave it out
      assets.push({
        ...want,
        url: got.browser_download_url,
        size: got.size,
        sha256Url: byName.get(`${want.name}.sha256`)?.browser_download_url ??
          downloadUrl(tag, `${want.name}.sha256`),
      });
    }
    if (assets.length === 0) return null;
    return {
      version,
      tag,
      url: data.html_url,
      publishedAt: data.published_at,
      assets,
      source: "github",
    };
  } catch (e) {
    console.warn(
      `site: no GitHub release (${e instanceof Error ? e.message : e}); using deno.json`,
    );
    return null;
  }
}

let cached: Promise<Release> | undefined;

/** The latest release (fetched once per build). */
export function latestRelease(): Promise<Release> {
  return cached ??= (async () => (await fromGitHub()) ?? fallback(await repoVersion()))();
}

/** The asset for a platform, arch and format (undefined when the release lacks it). */
export function findAsset(
  release: Release,
  platform: Platform,
  arch: Arch,
  format: Format,
): Asset | undefined {
  return release.assets.find((a) =>
    a.platform === platform && a.arch === arch && a.format === format
  );
}

/** "62 MB" (decimal, as the browsers' download bars show). */
export function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** "17 November 2026". */
export function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
