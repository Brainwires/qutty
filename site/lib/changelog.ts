// The repo's CHANGELOG.md, split into one entry per `## ` heading and rendered to HTML at build
// time with Denext's own Markdown renderer (raw HTML in the source is escaped).

import { renderMarkdown } from "denext/markdown";

export interface ChangelogEntry {
  /** "0.6.1", or "Unreleased". */
  version: string;
  /** The heading's words after the version ("Denext 4.20, a GUI around agent harnesses…"). */
  summary: string;
  /** The anchor id: `v0-6-1`, or `unreleased`. */
  id: string;
  html: string;
}

const SOURCE = new URL("../../CHANGELOG.md", import.meta.url);

/** `0.6.1` → `v0-6-1`; anything else is slugged. */
export function versionId(version: string): string {
  return /^\d/.test(version)
    ? `v${version.replace(/\./g, "-")}`
    : version.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Split the changelog's Markdown at its `## ` headings (`## 0.6.1 — summary`). */
export function splitChangelog(
  markdown: string,
): { version: string; summary: string; id: string; body: string }[] {
  const entries: { version: string; summary: string; id: string; body: string }[] = [];
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const m = line.match(/^## (.+)$/);
    if (m) {
      const [version, ...rest] = m[1].split(" — ");
      entries.push({
        version: version.trim(),
        summary: rest.join(" — ").trim(),
        id: versionId(version.trim()),
        body: "",
      });
    } else if (entries.length) {
      entries[entries.length - 1].body += line + "\n";
    }
  }
  return entries;
}

let cached: Promise<ChangelogEntry[]> | undefined;

/** Every changelog entry, newest first, with its body as HTML. */
export function changelog(): Promise<ChangelogEntry[]> {
  return cached ??= (async () =>
    splitChangelog(await Deno.readTextFile(SOURCE)).map((e) => ({
      version: e.version,
      summary: e.summary,
      id: e.id,
      html: renderMarkdown(e.body.trim(), { headingIds: false }),
    })))();
}
