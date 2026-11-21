// A user look's companion (Settings → Companion → Look; lib/companion/looks.ts): the look's picture
// for what the companion is doing (`pickLookImage`: the mood's picture through its fallbacks, a
// mouth frame while it talks, the voice turn's pictures) in an `<img>`, from a `data:` URL.
//
// It carries the drawn face's attributes (`data-state`, `data-mood`, `data-voice`, …) on the same
// `.companion-avatar` / `.companion-face` pair, so the moves public/styles.css gives the drawn
// face (the pop-in, the bob, the hop, the fold, the mood's shake or nod) move the picture too, with
// nothing from the look. "Companion looks" in public/styles.css adds the rest: the bob while it
// talks without mouth frames, the swell while it listens, a squish for a blink.
//
// Pure: no hooks, like app/companion/companion-face.tsx.
import type { CompanionFaceProps } from "./companion-face.tsx";
import { DEFAULT_COMPANION_NAME } from "../../lib/companion/settings.ts";
import { LEVEL_STEPS } from "../../lib/companion/lip-sync.ts";
import {
  type Look,
  LOOK_DEFAULT_SIZE,
  pickLookImage,
} from "../../lib/companion/looks.ts";

/** A user look, drawn in the drawn face's place. */
export function LookFace(
  props: CompanionFaceProps & { readonly look: Look },
) {
  const { look, state, voice, level = 0, hot, asleep } = props;
  const mood = props.mood ?? "neutral";
  const isHot = hot === true && mood === "neutral";
  const pick = pickLookImage(look.images, {
    state,
    mood,
    ...(voice ? { voice } : {}),
    level,
    hot: isHot,
    asleep: asleep === true,
  });
  const size = look.size ?? LOOK_DEFAULT_SIZE;
  const listen = voice === "listening" ? Math.min(1, level / LEVEL_STEPS) : 0;
  return (
    <div
      class="companion-avatar companion-look"
      data-testid="companion-look"
      data-look-id={look.id}
      data-state={state}
      data-mood={isHot ? "hot" : mood}
      data-voice={voice}
      data-lively={props.lively ? "" : undefined}
      data-expr={props.expression}
      data-asleep={asleep && mood === "sleepy" ? "" : undefined}
      data-stretch={props.stretching ? "" : undefined}
      data-picture={pick.name}
      data-bob={pick.bob ? "" : undefined}
      style={{
        "--companion-listen": listen,
        width: `${size.w}px`,
        height: `${size.h}px`,
      }}
      role="img"
      aria-label={props.label ?? DEFAULT_COMPANION_NAME}
    >
      <div class="companion-face">
        <img
          class="companion-look-picture"
          data-testid="companion-look-picture"
          src={pick.src}
          alt=""
          draggable={false}
        />
      </div>
    </div>
  );
}
