/**
 * Small pure formatters for the workspace chrome: relative ages and terminal titles.
 *
 * @module
 */

/** "just now", "42s ago", "2m ago", "1h ago", "3d ago". */
export function formatAge(now: number, then: number): string {
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Collapse `home` to `~` and keep the path short enough for a chip (last two segments). */
export function shortenPath(cwd: string, home?: string): string {
  let p = cwd;
  if (home && home !== "/" && (p === home || p.startsWith(home + "/"))) {
    p = "~" + p.slice(home.length);
  }
  const parts = p.split("/").filter(Boolean);
  if (p.startsWith("~")) {
    return parts.length <= 3
      ? parts.join("/")
      : "~/…/" + parts.slice(-2).join("/");
  }
  if (parts.length === 0) return "/";
  return parts.length <= 2
    ? "/" + parts.join("/")
    : "…/" + parts.slice(-2).join("/");
}

/** "zsh — ~/Source" (or just the process name when the cwd is unknown). */
export function makeTitle(
  info: { process: string; cwd?: string },
  home?: string,
): string {
  const proc = info.process.trim() || "shell";
  return info.cwd ? `${proc} — ${shortenPath(info.cwd, home)}` : proc;
}
