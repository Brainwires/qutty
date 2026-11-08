// Loopy's reactions to the tiles' work (Settings → Companion → Reactions), the workspace's side:
// it hears both signals and turns them into the reaction the overlay plays
// (app/companion/use-loopy-reaction.ts), by the rules in lib/companion/reactions.ts:
//
// - a shell command ended (the terminal manager's `onCommandDone`, from the shell's OSC 133
//   marks: lib/shell-marks.ts);
// - an agent tile's `set_status` note changed (the hub's `tiles` snapshots).
//
// At most one reaction of a kind per REACT_EVERY_MS (counted from the last one Loopy showed). A
// reaction that played is said aloud only when its voice alert is on (Settings → Voice: "finished"
// for a success, "failed build" for a failure) and nothing else is being said.

import { useEffect, useRef, useState } from "denext";
import type { PtyBackend } from "../lib/pty-client.ts";
import type { CommandDone } from "../lib/shell-marks.ts";
import type { CompanionSettings } from "../lib/companion/settings.ts";
import type { HubSnapshot, TileInfo } from "../lib/hub/protocol.ts";
import type { VoiceSettings } from "../lib/voice/settings.ts";
import {
  commandReaction,
  mayReact,
  maySpeakReaction,
  NEVER_REACTED,
  type Reaction,
  type ReactionClock,
  type ReactionRules,
  tileReactions,
} from "../lib/companion/reactions.ts";

export interface UseReactionsOptions {
  readonly backend: PtyBackend | null;
  readonly companion: CompanionSettings;
  readonly voice: Pick<VoiceSettings, "alertFinished" | "alertBuildFailed">;
  /** Whether something is being said now. */
  readonly speaking: boolean;
  /** Say a line as an alert. */
  readonly say: (text: string) => void;
  /** The name a terminal's reaction uses (its hub name, else its title). */
  readonly nameOf: (terminalId: string) => string;
}

export interface Reactions {
  /** The latest reaction (a new `id` plays it). */
  readonly reaction: Reaction | undefined;
  /** For the terminal manager: a command ended in terminal `id`. */
  onCommandDone(id: string, done: CommandDone): void;
  /** For the overlay: a reaction played. */
  onShown(reaction: Reaction): void;
}

const rulesOf = (s: CompanionSettings): ReactionRules => ({
  celebrate: s.celebrate,
  sad: s.sad,
  minDurationS: s.reactMinS,
  anyLongCommand: s.reactAnyCommand,
});

export function useReactions(opts: UseReactionsOptions): Reactions {
  const live = useRef(opts);
  live.current = opts;
  const [reaction, setReaction] = useState<Reaction | undefined>();
  const clock = useRef<ReactionClock>(NEVER_REACTED);
  const seq = useRef(0);
  const nextId = () => `reaction-${++seq.current}`;

  /** Hand `r` to the overlay, unless one of its kind showed too recently. */
  const offer = (r: Reaction | null) => {
    if (r && mayReact(clock.current, r.kind, Date.now()).ok) setReaction(r);
  };

  // Agents' status notes, from the hub's tile snapshots.
  const { backend } = opts;
  useEffect(() => {
    if (!backend) return;
    let prev: TileInfo[] | undefined;
    const onTiles = (snapshot: HubSnapshot) => {
      if (prev) {
        const rules = rulesOf(live.current.companion);
        for (const r of tileReactions(prev, snapshot.tiles, rules, nextId)) {
          offer(r);
        }
      }
      prev = snapshot.tiles;
    };
    const off = backend.onHubTiles(onTiles);
    backend.hubSnapshot().then((s) => prev ??= s.tiles, () => {});
    return off;
  }, [backend]);

  return {
    reaction,
    onCommandDone: (id, done) => {
      const o = live.current;
      offer(
        commandReaction(done, o.nameOf(id), rulesOf(o.companion), nextId()),
      );
    },
    onShown: (r) => {
      clock.current = mayReact(clock.current, r.kind, Date.now()).clock;
      const o = live.current;
      if (maySpeakReaction(r, o.voice, o.speaking)) o.say(r.spoken);
    },
  };
}
