// The broadcast banner: while the mode is on, a strip at the bottom of the tile area says how
// many tiles the keyboard reaches (or, with fewer than two checked, to tick the box in the tiles'
// headers), warns about checked tiles that are not SSH tiles, and has All / None / Only SSH to
// change the selection at once and the Stop button (the mode never uses Escape: Escape goes to the terminal as always). A big paste
// held for confirmation is asked about here.

import { useEffect, useRef } from "denext";
import {
  broadcastLabel,
  type BroadcastState,
  pasteSummary,
} from "../lib/broadcast.ts";
import type { HeldPaste } from "./use-broadcast.ts";
import { boxOf, useAreaOverlays } from "./use-html-overlay.ts";

export interface BroadcastBannerProps {
  state: BroadcastState;
  nonSsh: number;
  held: HeldPaste | null;
  /** The shortcut's label (`⌘⇧I`). */
  shortcut: string;
  /** How many visible SSH tiles there are (Only SSH shows when there are any). */
  sshTiles: number;
  /** All (every visible terminal tile), None, Only SSH. */
  onSelect(which: "all" | "none" | "ssh"): void;
  onStop(): void;
  onPaste(to: "all" | "one" | "none"): void;
}

export function BroadcastBanner(props: BroadcastBannerProps) {
  const { state, held } = props;
  const pasteRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (held) pasteRef.current?.focus();
  }, [held]);
  // It stays while broadcast is on: a native web tile under it makes room (lib/web/overlays.ts).
  const rootRef = useRef<HTMLDivElement | null>(null);
  useAreaOverlays(rootRef, (el) => [{ kind: "keepout", box: boxOf(el, 4) }]);
  const live = state.members.length >= 2;
  return (
    <div
      ref={rootRef}
      class={`bcast-banner${live ? " is-live" : ""}`}
      role="status"
      data-testid="broadcast-banner"
      data-count={String(state.members.length)}
      data-live={live ? "true" : "false"}
      onMouseDown={(e) => {
        // Keep the keyboard in the terminal (the banner's buttons are clicked, not focused).
        if (!(e.target as Element).closest?.("input")) e.preventDefault();
      }}
    >
      <span class="bcast-dot" aria-hidden="true" />
      <span class="bcast-text" data-testid="broadcast-label">
        {broadcastLabel(state)}
      </span>
      {props.nonSsh > 0 && (
        <span class="bcast-warn" data-testid="broadcast-warn">
          {props.nonSsh === 1
            ? "1 is not an SSH tile"
            : `${props.nonSsh} are not SSH tiles`}
        </span>
      )}
      {held
        ? (
          <span
            class="bcast-paste"
            data-testid="broadcast-paste"
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              props.onPaste("none");
            }}
          >
            <span class="bcast-text">
              Paste {pasteSummary(held.data)} into {held.tiles} tiles?
            </span>
            <button
              type="button"
              class="btn-primary"
              ref={pasteRef}
              data-testid="broadcast-paste-all"
              onClick={() => props.onPaste("all")}
            >
              Paste to all
            </button>
            <button
              type="button"
              class="btn-quiet"
              data-testid="broadcast-paste-one"
              onClick={() => props.onPaste("one")}
            >
              This tile only
            </button>
            <button
              type="button"
              class="btn-quiet"
              data-testid="broadcast-paste-cancel"
              onClick={() => props.onPaste("none")}
            >
              Cancel
            </button>
          </span>
        )
        : (
          <span class="bcast-actions">
            <button
              type="button"
              class="btn-quiet"
              data-testid="broadcast-all"
              title="Check every visible terminal tile"
              onClick={() => props.onSelect("all")}
            >
              All
            </button>
            <button
              type="button"
              class="btn-quiet"
              data-testid="broadcast-none"
              title="Uncheck every tile"
              onClick={() => props.onSelect("none")}
            >
              None
            </button>
            {props.sshTiles > 0 && (
              <button
                type="button"
                class="btn-quiet"
                data-testid="broadcast-only-ssh"
                title="Check the visible SSH tiles only"
                onClick={() => props.onSelect("ssh")}
              >
                Only SSH
              </button>
            )}
            <button
              type="button"
              class="btn-quiet bcast-stop"
              data-testid="broadcast-stop"
              onClick={props.onStop}
            >
              Stop <kbd>{props.shortcut}</kbd>
            </button>
          </span>
        )}
    </div>
  );
}

/**
 * The tile header's broadcast toggle while broadcast is on: a labelled pill (`● Broadcast` when
 * the tile is checked, `○ Broadcast` when not), loud when on. A press keeps the keyboard in the
 * terminal.
 */
export function BroadcastCheck(props: {
  checked: boolean;
  ssh: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <button
      type="button"
      class={`tile-bcast${props.checked ? " is-checked" : ""}`}
      data-testid="tile-broadcast"
      data-keep-focus
      aria-pressed={props.checked}
      title={props.checked
        ? "Typing here goes to every checked tile: click to leave this tile out"
        : props.ssh
        ? "Click to type into this tile with the other checked ones"
        : "Not an SSH tile: click to include it (typing here would go to the other checked tiles)"}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        props.onChange(!props.checked);
      }}
    >
      <span class="tile-bcast-dot" aria-hidden="true">
        {props.checked ? "●" : "○"}
      </span>{" "}
      <span>Broadcast</span>
    </button>
  );
}
