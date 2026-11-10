// An API key's row in Settings (Settings → Voice's cloud engines, Settings → Companion's API key
// brain): where the key is kept, whether one is saved, a field to save one, and Remove.
//
// The key goes to the desktop extension that uses it, which keeps it in the OS keychain
// (lib/secrets/api-keys.ts); the page only learns whether one is set, so the field never shows a
// saved key. In the browser demo the backend's stand-in keeps it in memory, and the row says so.

import { useEffect, useState } from "denext";
import type { KeyPlatform } from "../../lib/workspace/keys.ts";

export interface ApiKeyFieldProps {
  /** The service's name (`Deepgram`, `Anthropic`). */
  name: string;
  /** `data-testid` of the row; its parts get `-input`, `-save`, `-remove`, `-where`. */
  testid: string;
  /** Whether a key is saved (re-asked after every change). */
  has(): Promise<boolean>;
  save(key: string): Promise<void>;
  remove(): Promise<void>;
  /** The browser demo: the key is kept in memory, not in a keychain. */
  demo: boolean;
  platform: KeyPlatform;
}

/** Where a saved key lives, said the way the OS names it. */
function keychainName(platform: KeyPlatform): string {
  return platform === "mac"
    ? "the macOS Keychain"
    : "the system keyring (Secret Service)";
}

export function ApiKeyField(props: ApiKeyFieldProps) {
  const { name, testid } = props;
  const [saved, setSaved] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = () =>
    props.has().then(setSaved, (e) => {
      setSaved(false);
      setError(String(e?.message ?? e));
    });
  useEffect(() => {
    setSaved(null);
    setError("");
    void refresh();
  }, [testid]);
  const act = (work: Promise<void>, after?: () => void) => {
    setBusy(true);
    work.then(() => {
      after?.();
      setError("");
    }, (e) => setError(String(e?.message ?? e))).finally(() => {
      setBusy(false);
      void refresh();
    });
  };
  const where = props.demo
    ? `This demo keeps the ${name} key in memory only, until the page is closed; the desktop app keeps it in the OS keychain.`
    : `The ${name} key is kept in ${
      keychainName(props.platform)
    }, by Qutty's own process: Settings never shows it again, and it is read only to call ${name}.`;
  return (
    <div
      class="voice-key api-key"
      data-testid={testid}
      data-saved={saved === null ? "" : String(saved)}
    >
      <input
        type="password"
        class="font-custom"
        data-testid={`${testid}-input`}
        placeholder={saved ? `${name} key saved` : `${name} API key`}
        aria-label={`${name} API key`}
        value={draft}
        autocomplete="off"
        disabled={busy}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
      />
      <button
        type="button"
        class="btn-quiet"
        data-testid={`${testid}-save`}
        disabled={busy || !draft.trim()}
        onClick={() => act(props.save(draft.trim()), () => setDraft(""))}
      >
        {saved ? "Replace" : "Save"}
      </button>
      {saved && (
        <button
          type="button"
          class="btn-quiet"
          data-testid={`${testid}-remove`}
          disabled={busy}
          onClick={() => act(props.remove())}
        >
          {props.demo ? "Remove" : "Remove from keychain"}
        </button>
      )}
      <span class="field-hint" data-testid={`${testid}-where`}>
        {saved === null
          ? "Checking…"
          : saved
          ? "A key is saved. "
          : "No key saved. "}
        {where}
      </span>
      {error && <span class="field-hint voice-error">{error}</span>}
    </div>
  );
}
