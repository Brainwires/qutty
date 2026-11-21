// Settings → Appearance → Skin (beside Theme): the skin picker (the built-ins, then the user's
// skins), whether the skin's colours are used, the tile frame options (which side the window
// buttons are on, how the title is aligned: the skin's default or the user's own choice), and the
// skins folder's buttons: open it, read it again, start a skin from Classic.
//
// Picking a skin applies it at once (app/use-skins.ts). A skin that cannot be used says why here,
// and Qutty's own look shows meanwhile.

import { useState } from "denext";
import type { KeyPlatform } from "../lib/workspace/keys.ts";
import type { ColorTheme } from "../lib/workspace/themes.ts";
import {
  effectiveTheme,
  skinHasColors,
  type SkinManifest,
} from "../lib/skins/skin.ts";
import {
  FRAME_BUTTONS_SETTINGS,
  FRAME_TITLE_SETTINGS,
  type FrameButtonsSetting,
  type FrameTitleSetting,
  resolveFrame,
  type SkinSettings,
} from "../lib/skins/settings.ts";
import type { SkinsApi } from "./use-skins.ts";

const W = 72;
const H = 45;

/**
 * A tiny drawing of a skin: one tile in the skin's colours (the user's theme when it brings
 * none), its header with the window buttons on the skin's side and the title where it aligns it.
 */
function SkinPreview(props: { skin: SkinManifest; theme: ColorTheme }) {
  const c = effectiveTheme(props.theme, props.skin, true).chrome;
  const frame = resolveFrame(props.skin.frame, {
    frameButtons: "skin",
    frameTitle: "skin",
  });
  const left = frame.buttons === "left";
  // The title's room: beside the three buttons.
  const from = left ? 27 : 9;
  const room = 36;
  const titleW = 18;
  const titleX = frame.title === "left"
    ? from
    : frame.title === "right"
    ? from + room - titleW
    : from + (room - titleW) / 2;
  return (
    <svg
      class="theme-preview skin-preview"
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      aria-hidden="true"
    >
      <rect width={W} height={H} rx={3} fill={c["--ink"]} />
      <rect
        x={5.5}
        y={6.5}
        width={61}
        height={33}
        rx={props.skin.frame ? 0 : 2}
        fill={c["--tile"]}
        stroke={c["--line-2"]}
      />
      <rect x={6} y={7} width={60} height={7} fill={c["--head"]} />
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={(left ? 9 : 49) + i * 5}
          y={9}
          width={3}
          height={3}
          fill={c["--text-2"]}
        />
      ))}
      <rect
        x={titleX}
        y={9.5}
        width={titleW}
        height={2}
        rx={1}
        fill={c["--accent"]}
      />
      <rect x={10} y={20} width={24} height={2} rx={1} fill={c["--text"]} />
      <rect x={10} y={25} width={34} height={2} rx={1} fill={c["--text-3"]} />
      <rect x={10} y={30} width={16} height={2} rx={1} fill={c["--text-3"]} />
    </svg>
  );
}

const BUTTONS_LABELS: Record<FrameButtonsSetting, string> = {
  skin: "Skin default",
  left: "Left",
  right: "Right",
};
const TITLE_LABELS: Record<FrameTitleSetting, string> = {
  skin: "Skin default",
  left: "Left",
  center: "Center",
  right: "Right",
};

export function SkinSettingsSection(props: {
  settings: SkinSettings;
  skins: SkinsApi;
  /** The user's theme (a skin with no colours of its own is drawn in it). */
  theme: ColorTheme;
  platform: KeyPlatform;
  onSkin(patch: Partial<SkinSettings>): void;
}) {
  const { settings, skins } = props;
  const [note, setNote] = useState("");
  const chosen = skins.choices.find((c) => c.manifest.id === settings.id);
  // What "Skin default" means now.
  const skinFrame = resolveFrame(skins.active.frame, {
    frameButtons: "skin",
    frameTitle: "skin",
  });
  const act = (what: () => Promise<string>) => {
    setNote("");
    what().then(
      setNote,
      (err) => setNote(err instanceof Error ? err.message : String(err)),
    );
  };
  return (
    <>
      <div class="skin-picker" role="radiogroup" aria-label="Skin">
        <div class="theme-grid">
          {skins.choices.map(({ manifest: m, source }) => (
            <button
              type="button"
              key={m.id}
              role="radio"
              aria-checked={m.id === settings.id}
              class={`pattern-option theme-option skin-option${
                m.id === settings.id ? " is-active" : ""
              }`}
              data-testid="setting-skin"
              data-value={m.id}
              data-source={source}
              title={m.description || m.name}
              onClick={() => props.onSkin({ id: m.id })}
            >
              <SkinPreview skin={m} theme={props.theme} />
              <span>{m.name}</span>
            </button>
          ))}
        </div>
      </div>
      {chosen && (
        <span class="field-hint" data-testid="skin-desc">
          {chosen.manifest.description}
          {chosen.source === "user" && chosen.manifest.author
            ? ` By ${chosen.manifest.author}.`
            : ""}
        </span>
      )}
      {skins.error && (
        <p class="skin-error" role="alert" data-testid="skin-error">
          The skin “{settings.id}” cannot be used: {skins.error}{" "}
          Qutty's own look is shown instead.
        </p>
      )}
      {skins.problems.length > 0 && (
        <ul class="skin-problems" data-testid="skin-problems">
          {skins.problems.map((p) => (
            <li key={p.folder} data-folder={p.folder}>
              <code>{p.folder}</code>: {p.error}
            </li>
          ))}
        </ul>
      )}
      <label class="field field-check">
        <input
          type="checkbox"
          data-testid="setting-skin-colors"
          checked={settings.colors}
          disabled={!skinHasColors(skins.active)}
          onChange={(e) =>
            props.onSkin({ colors: (e.target as HTMLInputElement).checked })}
        />
        <span class="field-label">
          Use the skin's colours and terminal font
        </span>
      </label>
      <span class="field-hint">
        {skinHasColors(skins.active)
          ? "Off: the skin keeps its shapes and takes the theme chosen above."
          : "This skin brings no colours: it takes the theme chosen above."}
      </span>
      <label class="field">
        <span class="field-label">Frame buttons</span>
        <select
          class="field-select"
          data-testid="setting-frame-buttons"
          value={settings.frameButtons}
          onChange={(e) =>
            props.onSkin({
              frameButtons: (e.target as HTMLSelectElement)
                .value as FrameButtonsSetting,
            })}
        >
          {FRAME_BUTTONS_SETTINGS.map((v) => (
            <option value={v} key={v}>
              {v === "skin"
                ? `${BUTTONS_LABELS.skin} (${skinFrame.buttons})`
                : BUTTONS_LABELS[v]}
            </option>
          ))}
        </select>
      </label>
      <label class="field">
        <span class="field-label">Title</span>
        <select
          class="field-select"
          data-testid="setting-frame-title"
          value={settings.frameTitle}
          onChange={(e) =>
            props.onSkin({
              frameTitle: (e.target as HTMLSelectElement)
                .value as FrameTitleSetting,
            })}
        >
          {FRAME_TITLE_SETTINGS.map((v) => (
            <option value={v} key={v}>
              {v === "skin"
                ? `${TITLE_LABELS.skin} (${skinFrame.title})`
                : TITLE_LABELS[v]}
            </option>
          ))}
        </select>
        <span class="field-hint">
          Where each tile's Minimize, Maximize and Close buttons sit, and how
          its title is aligned.{props.platform === "mac"
            ? " The window's own buttons are drawn by macOS and stay where they are."
            : ""}
        </span>
      </label>
      <div class="skin-actions">
        <button
          type="button"
          class="btn-quiet"
          data-testid="skins-open-folder"
          disabled={!skins.available}
          onClick={() => act(() => skins.openFolder().then(() => ""))}
        >
          Open skins folder
        </button>
        <button
          type="button"
          class="btn-quiet"
          data-testid="skins-reload"
          disabled={!skins.available}
          onClick={() => {
            skins.reload();
            setNote("Skins reloaded.");
          }}
        >
          Reload skins
        </button>
        <button
          type="button"
          class="btn-quiet"
          data-testid="skins-start-classic"
          disabled={!skins.available}
          title="Copy the Classic skin into the skins folder, to change into your own"
          onClick={() =>
            act(() =>
              skins.startFromClassic().then((id) =>
                `Copied Classic to the “${id}” folder: edit its skin.css, then Reload skins.`
              )
            )}
        >
          Start from Classic
        </button>
      </div>
      <span class="field-hint" data-testid="skins-note" aria-live="polite">
        {note ||
          (skins.dir
            ? `Skins are folders in ${skins.dir}.`
            : "A skin is a folder with a skin.json and a skin.css.")}
      </span>
    </>
  );
}
