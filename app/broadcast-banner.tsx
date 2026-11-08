// The broadcast banner: while the mode is on, a strip at the bottom of the tile area says how
// many tiles the keyboard reaches, warns about checked tiles that are not SSH tiles, and has the
// Stop button (the mode never uses Escape: Escape goes to the terminal as always). A big paste
// held for confirmation is asked about here.

import { useEffect, useRef } from "denext";
import {
  broadcastLabel,
  type BroadcastState,
  pasteSummary,
} from "../lib/broadcast.ts";
import type { HeldPaste } from "./use-broadcast.ts";

export interface BroadcastBannerProps {
  state: BroadcastState;
  nonSsh: number;
  held: HeldPaste | null;
  /** The shortcut's label (`⌘⇧I`). */
  shortcut: string;
  onStop(): void;
  onPaste(to: "all" | "one" | "none"): void;
}

export function BroadcastBanner(props: BroadcastBannerProps) {
  const { state, held } = props;
  const pasteRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (held) pasteRef.current?.focus();
  }, [held]);
  const live = state.members.length >= 2;
  return (
    <div
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
          <button
            type="button"
            class="btn-quiet bcast-stop"
            data-testid="broadcast-stop"
            onClick={props.onStop}
          >
            Stop <kbd>{props.shortcut}</kbd>
          </button>
        )}
    </div>
  );
}

/** The tile header's checkbox while broadcast is on. */
export function BroadcastCheck(props: {
  checked: boolean;
  ssh: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label
      class={`tile-bcast${props.checked ? " is-checked" : ""}`}
      data-keep-focus
      title={props.ssh
        ? "Type into this tile with the other checked ones"
        : "Not an SSH tile: typing here would also go to the other checked tiles"}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        data-testid="tile-broadcast"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span>{props.checked ? "BROADCAST" : "broadcast"}</span>
    </label>
  );
}
