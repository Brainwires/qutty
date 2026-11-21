// Settings → Companion → Look: what the companion looks like. The built-in Loopy first, then the
// looks in the looks folder (desktop/companion-looks.ts), each with its `idle` picture; "Open looks
// folder", "Reload looks" and "Create a look…" (the starter look copied into the folder and
// opened); the folders that are not usable looks, with why; and a note when the chosen look cannot
// be had (the companion then wears Loopy). docs/companion-looks.md is the procedure.

import { useEffect, useState } from "denext";
import type { CompanionSettings } from "../../lib/companion/settings.ts";
import {
  BUILTIN_LOOK_ID,
  BUILTIN_LOOK_NAME,
  type LookListing,
  type LooksBackend,
} from "../../lib/companion/looks.ts";
import {
  reloadLooks,
  useCompanionLook,
  useLooksVersion,
} from "./use-companion-look.ts";

/** One choice in the picker. */
function LookChoice(props: {
  id: string;
  name: string;
  thumbnail: string;
  title: string;
  active: boolean;
  disabled: boolean;
  onPick(): void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.active}
      class={props.active
        ? "companion-look-choice is-active"
        : "companion-look-choice"}
      data-testid="setting-companion-look"
      data-value={props.id}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onPick}
    >
      <img src={props.thumbnail} alt="" draggable={false} />
      <span>{props.name}</span>
    </button>
  );
}

export function LookSettings(props: {
  settings: CompanionSettings;
  looks: LooksBackend | undefined;
  shown: boolean;
  onChange(patch: Partial<CompanionSettings>): void;
}) {
  const { settings, looks, onChange } = props;
  const [listing, setListing] = useState<LookListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const version = useLooksVersion();
  useEffect(() => {
    if (!looks) return;
    let live = true;
    looks.list().then(
      (l) => live && (setListing(l), setError(null)),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [looks, version]);
  const chosen = useCompanionLook(looks, settings.look);
  const act = (work: () => Promise<unknown>) => {
    setBusy(true);
    work().then(
      () => setError(null),
      (e) => setError(e instanceof Error ? e.message : String(e)),
    ).finally(() => setBusy(false));
  };
  const custom = settings.look !== BUILTIN_LOOK_ID;
  const missing = custom && listing !== null &&
    !listing.looks.some((l) => l.id === settings.look);
  const note = chosen.error
    ? `"${settings.look}" cannot be used (${chosen.error}), so the companion looks like ${BUILTIN_LOOK_NAME}.`
    : missing
    ? `"${settings.look}" is not in the looks folder, so the companion looks like ${BUILTIN_LOOK_NAME}.`
    : "";
  return (
    <>
      <div class="field">
        <span class="field-label">Look</span>
        <div
          class="companion-look-picker"
          role="radiogroup"
          aria-label="Look"
        >
          <LookChoice
            id={BUILTIN_LOOK_ID}
            name={BUILTIN_LOOK_NAME}
            thumbnail="/favicon.png"
            title={`${BUILTIN_LOOK_NAME}: Qutty's own companion`}
            active={!custom}
            disabled={!props.shown}
            onPick={() => onChange({ look: BUILTIN_LOOK_ID })}
          />
          {listing?.looks.map((l) => (
            <LookChoice
              key={l.id}
              id={l.id}
              name={l.name}
              thumbnail={l.thumbnail}
              title={[
                l.name,
                l.author && `by ${l.author}`,
                l.version && `v${l.version}`,
                l.description,
              ].filter(Boolean).join(" · ")}
              active={settings.look === l.id}
              disabled={!props.shown}
              onPick={() => onChange({ look: l.id })}
            />
          ))}
        </div>
        {note && (
          <span
            class="field-hint voice-error"
            data-testid="companion-look-note"
          >
            {note}
          </span>
        )}
        <span class="field-hint" data-testid="companion-look-where">
          Make your own: one picture per mood in a folder, only{" "}
          <code>idle</code> is required. {listing?.dir
            ? (
              <>
                The looks folder is <code>{listing.dir}</code>.
              </>
            )
            : ""}
        </span>
      </div>
      <div class="field">
        <span class="field-label">Your looks</span>
        <div class="companion-look-actions">
          <button
            type="button"
            class="btn-quiet"
            data-testid="companion-looks-open"
            disabled={!looks || busy}
            onClick={() => act(() => looks!.openFolder())}
          >
            Open looks folder
          </button>
          <button
            type="button"
            class="btn-quiet"
            data-testid="companion-looks-reload"
            disabled={!looks || busy}
            onClick={reloadLooks}
          >
            Reload looks
          </button>
          <button
            type="button"
            class="btn-quiet"
            data-testid="companion-looks-create"
            disabled={!looks || busy}
            onClick={() => act(() => looks!.create().then(reloadLooks))}
          >
            Create a look…
          </button>
        </div>
        {error && <span class="field-hint voice-error">{error}</span>}
        {listing && listing.problems.length > 0 && (
          <span class="field-hint" data-testid="companion-look-problems">
            Not usable: {listing.problems.map((p, i) => (
              <span key={p.folder}>
                {i > 0 && "; "}
                <code>{p.folder}</code> ({p.error})
              </span>
            ))}.
          </span>
        )}
      </div>
    </>
  );
}
