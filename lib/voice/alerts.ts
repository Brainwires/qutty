/**
 * Spoken event alerts, from the hub's tile snapshots (the `tiles` event): an agent finished its
 * turn (busy → idle), an agent needs you (→ waiting: a permission prompt or a question), a tile
 * reported a failed build (`set_status` with a failure note, e.g. `{ status: "idle", note: "build
 * failed" }`). Each has its own toggle in Settings → Voice, so the window is not chatty.
 *
 * Client-safe and pure.
 *
 * @module
 */

import type { TileInfo } from "../hub/protocol.ts";
import type { VoiceSettings } from "./settings.ts";

/** The alert toggles. */
export type AlertToggles = Pick<
  VoiceSettings,
  "alertFinished" | "alertPermission" | "alertBuildFailed"
>;

/** What an alert is about. */
export type AlertKind = "finished" | "permission" | "buildFailed";

export interface VoiceAlert {
  kind: AlertKind;
  tileId: string;
  /** What is said. */
  text: string;
}

/** A note that reports a failure ("build failed", "3 tests failing", "compile error"). */
const FAILURE = /\b(?:fail(?:ed|s|ure|ing)?|errors?|broken|crash(?:ed)?)\b/i;

/** Whether a status note reports a failure. */
export function isFailureNote(note: string | undefined): boolean {
  return note !== undefined && FAILURE.test(note);
}

/** A tile's name as it is said: `codex-2` → "codex 2". */
export function spokenName(tile: Pick<TileInfo, "name">): string {
  return tile.name.replace(/[-_]+/g, " ").trim() || "a tile";
}

/** Whether any alert is on. */
export function anyAlertOn(t: AlertToggles): boolean {
  return t.alertFinished || t.alertPermission || t.alertBuildFailed;
}

/** Each tile of `next` that `prev` had too, with how it was: `[was, now]`. */
export function* seenBefore(
  prev: readonly TileInfo[],
  next: readonly TileInfo[],
): Generator<[TileInfo, TileInfo]> {
  const before = new Map(prev.map((t) => [t.id, t]));
  for (const tile of next) {
    const was = before.get(tile.id);
    if (was) yield [was, tile];
  }
}

/**
 * The alerts between two snapshots, at most one per tile (a failed build, else a question, else
 * finished). A tile seen for the first time gives none: opening the app is not news.
 */
export function tileAlerts(
  prev: readonly TileInfo[],
  next: readonly TileInfo[],
  toggles: AlertToggles,
): VoiceAlert[] {
  const out: VoiceAlert[] = [];
  for (const [was, tile] of seenBefore(prev, next)) {
    const name = spokenName(tile);
    if (
      toggles.alertBuildFailed && isFailureNote(tile.note) &&
      tile.note !== was.note
    ) {
      out.push({
        kind: "buildFailed",
        tileId: tile.id,
        text: `${name}: ${tile.note}.`,
      });
    } else if (
      toggles.alertPermission && tile.status === "waiting" &&
      was.status !== "waiting"
    ) {
      out.push({
        kind: "permission",
        tileId: tile.id,
        text: `${name} needs you.`,
      });
    } else if (
      toggles.alertFinished && was.status === "busy" && tile.status === "idle"
    ) {
      out.push({
        kind: "finished",
        tileId: tile.id,
        text: `${name} finished.`,
      });
    }
  }
  return out;
}
