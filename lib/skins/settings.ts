/**
 * Settings → Appearance → Skin, as persisted with the workspace settings
 * (lib/workspace/store.ts): the skin, whether its colours are used, and the user's own choice for
 * the tile frames (which side the window buttons are on, how the title is aligned), each of which
 * may follow the skin.
 *
 * `applySkin` puts the result on the document element: `data-skin`, `data-frame-buttons`,
 * `data-frame-title` and the buttons' order (`--frame-order-*`), which the stylesheets go by
 * (public/styles.css for the frame options, a skin's own for everything else).
 *
 * Client-safe and pure.
 *
 * @module
 */

import {
  DEFAULT_SKIN_ID,
  FRAME_BUTTON_IDS,
  FRAME_BUTTONS,
  FRAME_TITLES,
  type FrameButton,
  type FrameButtons,
  type FrameTitle,
  isSkinId,
  type SkinFrame,
} from "./skin.ts";

/** "skin": whatever the skin says (Qutty's own: buttons right, title left). */
export type FrameButtonsSetting = "skin" | FrameButtons;
export type FrameTitleSetting = "skin" | FrameTitle;

export const FRAME_BUTTONS_SETTINGS: readonly FrameButtonsSetting[] = [
  "skin",
  ...FRAME_BUTTONS,
];
export const FRAME_TITLE_SETTINGS: readonly FrameTitleSetting[] = [
  "skin",
  ...FRAME_TITLES,
];

export interface SkinSettings {
  /** The skin's id: a built-in or a user skin (one that is gone falls back to Qutty's look). */
  id: string;
  /** Use the skin's colours and terminal font instead of the chosen theme and font. */
  colors: boolean;
  frameButtons: FrameButtonsSetting;
  frameTitle: FrameTitleSetting;
}

export const DEFAULT_SKIN: SkinSettings = {
  id: DEFAULT_SKIN_ID,
  colors: true,
  frameButtons: "skin",
  frameTitle: "skin",
};

/** `raw` (from storage or a patch) onto `base`, each field checked. */
export function sanitizeSkinSettings(
  raw: unknown,
  base: SkinSettings = DEFAULT_SKIN,
): SkinSettings {
  const out = { ...base };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Partial<Record<keyof SkinSettings, unknown>>;
  // Present but not an id (junk) falls back to Qutty's own look.
  if (r.id !== undefined) out.id = isSkinId(r.id) ? r.id : DEFAULT_SKIN_ID;
  if (typeof r.colors === "boolean") out.colors = r.colors;
  if (FRAME_BUTTONS_SETTINGS.includes(r.frameButtons as FrameButtonsSetting)) {
    out.frameButtons = r.frameButtons as FrameButtonsSetting;
  }
  if (FRAME_TITLE_SETTINGS.includes(r.frameTitle as FrameTitleSetting)) {
    out.frameTitle = r.frameTitle as FrameTitleSetting;
  }
  return out;
}

/** The tile frames as drawn. */
export interface ResolvedFrame {
  buttons: FrameButtons;
  title: FrameTitle;
  /** Left to right. */
  buttonOrder: readonly FrameButton[];
}

/** The order of the window buttons on a side when the skin names none: Close is outermost. */
function defaultOrder(side: FrameButtons): readonly FrameButton[] {
  return side === "left"
    ? ["close", "minimize", "maximize"]
    : ["minimize", "maximize", "close"];
}

/**
 * The frame to draw: the user's choice over the skin's default over Qutty's (buttons right, title
 * left). The skin's button order holds for the side the skin chose; on the other side (the user
 * moved the buttons) the order is that side's usual one.
 */
export function resolveFrame(
  skin: SkinFrame | undefined,
  settings: Pick<SkinSettings, "frameButtons" | "frameTitle">,
): ResolvedFrame {
  const skinSide = skin?.buttons ?? "right";
  const buttons = settings.frameButtons === "skin"
    ? skinSide
    : settings.frameButtons;
  const title = settings.frameTitle === "skin"
    ? skin?.title ?? "left"
    : settings.frameTitle;
  const buttonOrder = skin?.buttonOrder && buttons === skinSide
    ? skin.buttonOrder
    : defaultOrder(buttons);
  return { buttons, title, buttonOrder };
}

/** What `applySkin` needs from the document element (a stub in tests). */
export interface SkinTarget {
  style: { setProperty(name: string, value: string): void };
  setAttribute(name: string, value: string): void;
}

/**
 * Put the skin's id and the frame options on the document element. The buttons' order becomes
 * `--frame-order-minimize` / `-maximize` / `-close` (1 to 3), which each button's `order` reads.
 */
export function applySkin(
  el: SkinTarget,
  id: string,
  frame: ResolvedFrame,
): void {
  el.setAttribute("data-skin", id);
  el.setAttribute("data-frame-buttons", frame.buttons);
  el.setAttribute("data-frame-title", frame.title);
  for (const b of FRAME_BUTTON_IDS) {
    el.style.setProperty(
      `--frame-order-${b}`,
      String(frame.buttonOrder.indexOf(b) + 1),
    );
  }
}
