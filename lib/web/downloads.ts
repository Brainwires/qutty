/**
 * A web tile's downloads, as its download bar (app/web-chrome.tsx) shows them: the list kept from
 * the engine's `download` events (lib/web/engine.ts), what each entry says, and which of its
 * buttons show.
 *
 * Where the runtime hands downloads to the app (Denext's `downloads: "app"`,
 * `webViewCapabilities().downloadEvents`), the native engine (lib/web/native-engine.ts) answers
 * each one with the OS save panel (the item's `saveAs()`, what `downloads: "ask"` does on an older
 * runtime) and reports every step of it as a {@linkcode WebDownload}: `requested` while the save
 * panel is up, then `progressing` (a few times a second, and on each pause and resume), and last
 * `completed`, `cancelled` or `interrupted` (an interrupted one that `canResume` can still go on).
 *
 * The list ({@linkcode applyDownload}) keeps one entry per download id, newest last:
 *
 * - A download cancelled before it started (the save panel dismissed: it was still `requested`
 *   and had no path) is dropped, not shown as cancelled: the user said no to it already.
 * - A finished one (completed, cancelled, interrupted) stays until it is dismissed
 *   ({@linkcode dismissDownload}); past {@linkcode MAX_DOWNLOADS} the oldest finished ones go.
 *
 * The buttons ({@linkcode downloadButtons}): Pause / Resume only where the runtime can pause
 * (`downloadPause`), Resume also on an interrupted one that can resume, Cancel while it runs,
 * "Show in Finder" once completed with a path, and Dismiss once it is over.
 *
 * Pure and client-safe.
 *
 * @module
 */

/** Where a download is in its life (Denext's `WebViewDownloadState`). */
export type WebDownloadState =
  | "requested"
  | "progressing"
  | "completed"
  | "cancelled"
  | "interrupted";

/** One step of a download, as the engine reports it (a plain copy of Denext's item). */
export interface WebDownload {
  /** The download's id (the runtime's). */
  readonly id: number;
  /** What is being downloaded. */
  readonly url: string;
  /** The suggested file name (a bare name, never a path). */
  readonly filename: string;
  /** Its MIME type, when the server says. */
  readonly mimeType?: string;
  /** Its size in bytes, left out while unknown. */
  readonly totalBytes?: number;
  /** The bytes received so far. */
  readonly receivedBytes: number;
  readonly state: WebDownloadState;
  /** Where it is being saved, once decided. */
  readonly path?: string;
  /** Whether it is paused. */
  readonly paused: boolean;
  /** Whether `resume` can restart it after an interruption. */
  readonly canResume: boolean;
  /** Why it was interrupted (`"network"`, `"server"`, `"file"`, `"crash"`, `"failed"`). */
  readonly reason?: string;
}

/** What a download bar's button does (`reveal` and `dismiss` are the tile's own). */
export type DownloadAction =
  | "pause"
  | "resume"
  | "cancel"
  | "reveal"
  | "dismiss";

/** The most entries a tile's download bar keeps (the oldest finished ones go first). */
export const MAX_DOWNLOADS = 5;

/** Whether `d` is over (nothing more comes for it, unless an interrupted one is resumed). */
export function downloadOver(d: WebDownload): boolean {
  return d.state === "completed" || d.state === "cancelled" ||
    d.state === "interrupted";
}

/** The list with `d` (a new download, or the next step of one it has) put in. */
export function applyDownload(
  list: readonly WebDownload[],
  d: WebDownload,
): readonly WebDownload[] {
  const at = list.findIndex((x) => x.id === d.id);
  const was = at < 0 ? undefined : list[at];
  // Refused at the save panel (or cancelled before anything was written): gone.
  if (
    d.state === "cancelled" && !d.path && (!was || was.state === "requested")
  ) {
    return at < 0 ? list : list.filter((x) => x.id !== d.id);
  }
  if (at < 0) return trim([...list, d]);
  const next = [...list];
  next[at] = d;
  return next;
}

/** Past {@linkcode MAX_DOWNLOADS}: the oldest finished entries go (running ones always stay). */
function trim(list: WebDownload[]): WebDownload[] {
  let extra = list.length - MAX_DOWNLOADS;
  if (extra <= 0) return list;
  return list.filter((d) => {
    if (extra > 0 && downloadOver(d)) {
      extra--;
      return false;
    }
    return true;
  });
}

/** The list without download `id` (only a finished one can be dismissed). */
export function dismissDownload(
  list: readonly WebDownload[],
  id: number,
): readonly WebDownload[] {
  const d = list.find((x) => x.id === id);
  if (!d || !downloadOver(d)) return list;
  return list.filter((x) => x.id !== id);
}

/** Which of a download's buttons show. */
export interface DownloadButtons {
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  reveal: boolean;
  dismiss: boolean;
}

/**
 * The buttons `d` shows; `canPause`: the runtime pauses downloads (`downloadPause`), which is
 * also what resuming an interrupted one needs.
 */
export function downloadButtons(
  d: WebDownload,
  canPause: boolean,
): DownloadButtons {
  const running = d.state === "progressing";
  return {
    pause: canPause && running && !d.paused,
    resume: canPause &&
      ((running && d.paused) || (d.state === "interrupted" && d.canResume)),
    cancel: d.state === "requested" || running ||
      (d.state === "interrupted" && d.canResume),
    reveal: d.state === "completed" && !!d.path,
    dismiss: downloadOver(d),
  };
}

/** `n` bytes in words (`"512 B"`, `"1.4 MB"`). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** How far `d` is: 0 to 1, or `null` while its size is unknown (an indeterminate bar). */
export function downloadFraction(d: WebDownload): number | null {
  if (d.state === "completed") return 1;
  if (!d.totalBytes || d.totalBytes <= 0) return null;
  return Math.min(1, Math.max(0, d.receivedBytes / d.totalBytes));
}

/** What a download's entry says beside its name. */
export function downloadStatus(d: WebDownload): string {
  switch (d.state) {
    case "requested":
      return "Choosing where to save…";
    case "completed":
      return d.totalBytes || d.receivedBytes
        ? `Done, ${formatBytes(d.totalBytes ?? d.receivedBytes)}`
        : "Done";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return d.reason === "network"
        ? "Failed: network error"
        : d.reason === "server"
        ? "Failed: server error"
        : d.reason === "file"
        ? "Failed: couldn't write the file"
        : "Failed";
    case "progressing": {
      const got = formatBytes(d.receivedBytes);
      const of = d.totalBytes ? ` of ${formatBytes(d.totalBytes)}` : "";
      return `${d.paused ? "Paused, " : ""}${got}${of}`;
    }
  }
}

/** The label of the button that shows a saved file (Settings and menus say the same). */
export function revealLabel(platform: "mac" | "other"): string {
  return platform === "mac" ? "Show in Finder" : "Show in file manager";
}
