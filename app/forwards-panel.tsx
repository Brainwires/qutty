// The port-forward panel for one SSH host: the forwards running on its shared connection (added
// here, stopped here), the ones its ssh config starts with every connection (read-only), the
// favourites saved for it, and a form to add a local (-L), remote (-R) or dynamic (-D) forward.
// Everything runs on the live connection through its control socket (`ssh -O forward` /
// `-O cancel`, desktop/ssh.ts), so nothing reconnects and nothing prompts.
//
// Shown from an SSH tile's header (`ForwardsDialog`) and inside the connection manager's detail
// pane. Favourites are kept in qutty.conf metadata, so only Qutty hosts can have them.

import { useEffect, useRef, useState } from "denext";
import type { PtyBackend, SshForwardStatus } from "../lib/pty-client.ts";
import type { SshHost, SshTarget } from "../lib/ssh-config.ts";
import {
  addForward,
  configuredForwards,
  favoritesOf,
  FORWARD_KINDS,
  forwardKey,
  type ForwardKind,
  forwardText,
  kindLabel,
  parseForward,
  removeForward,
  sameForward,
  specPlaceholder,
  type SshForward,
} from "../lib/ssh-forward.ts";
import { Modal } from "./modal.tsx";

export interface ForwardsPanelProps {
  backend: PtyBackend;
  target: SshTarget;
  label: string;
}

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** The saved host for an alias target (a Qutty host first, as ssh reads qutty.conf first). */
function hostFor(hosts: SshHost[], target: SshTarget): SshHost | undefined {
  if (!("alias" in target)) return undefined;
  const matches = hosts.filter((h) => h.aliases.includes(target.alias));
  return matches.find((h) => h.editable) ?? matches[0];
}

export function ForwardsPanel(props: ForwardsPanelProps) {
  const { backend, target } = props;
  const [status, setStatus] = useState<SshForwardStatus | null>(null);
  const [host, setHost] = useState<SshHost | undefined>(undefined);
  const [kind, setKind] = useState<ForwardKind>("local");
  const [spec, setSpec] = useState("");
  const [keep, setKeep] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const specRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    try {
      const [s, hosts] = await Promise.all([
        backend.sshForwards(target),
        backend.sshHosts().then((r) => r.hosts, () => []),
      ]);
      setStatus(s);
      setHost(hostFor(hosts, target));
    } catch (err) {
      setError(errorText(err));
    }
  };
  useEffect(() => {
    void refresh();
    specRef.current?.focus();
  }, []);

  /** Run an action with the busy flag and ssh's error shown. */
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      // The clicked button may be gone (a stopped forward's row) or was disabled while busy:
      // keep the keyboard in the panel, so Escape and Tab still work.
      setTimeout(() => {
        if (!rootRef.current?.contains(document.activeElement)) {
          specRef.current?.focus();
        }
      }, 0);
    }
  };

  const favorites = favoritesOf(host?.forwards);
  const configured = configuredForwards(host?.directives ?? []);
  const canSave = host?.editable === true;
  const active = status?.active ?? [];
  const isActive = (f: SshForward) => active.some((a) => sameForward(a, f));

  const saveFavorites = (next: SshForward[]) =>
    act(async () => {
      setHost(
        await backend.sshSaveForwards({ alias: host!.alias, forwards: next }),
      );
    });
  const start = (f: SshForward) =>
    act(async () => {
      setStatus(await backend.sshForwardAdd({ target, forward: f }));
    });
  const stop = (f: SshForward) =>
    act(async () => {
      setStatus(await backend.sshForwardCancel({ target, forward: f }));
    });

  const parsed = parseForward(kind, spec);
  const add = () => {
    setTouched(true);
    const f = parsed.forward;
    if (!f) return;
    void act(async () => {
      setStatus(await backend.sshForwardAdd({ target, forward: f }));
      setSpec("");
      setTouched(false);
      if (keep && canSave) {
        setHost(
          await backend.sshSaveForwards({
            alias: host!.alias,
            forwards: addForward(favorites, f),
          }),
        );
      }
    });
  };

  return (
    <div
      class="forwards"
      ref={rootRef}
      data-testid="forwards-panel"
      data-master={status === null ? "" : String(status.master)}
    >
      <div class="forwards-status">
        <span
          class={`forwards-dot${status?.master ? " is-up" : ""}`}
          aria-hidden="true"
        />
        <span data-testid="forwards-status">
          {status === null
            ? "Checking the shared connection…"
            : status.master
            ? "Connected: forwards ride the shared connection."
            : "Not connected. Open a tile to this host, then add forwards."}
        </span>
        <button
          type="button"
          class="btn-quiet"
          data-testid="forwards-refresh"
          disabled={busy}
          onClick={() => void act(refresh)}
        >
          Refresh
        </button>
      </div>
      {error && (
        <p class="form-error" role="alert" data-testid="forwards-error">
          {error}
        </p>
      )}

      <span class="theme-group-label">Active</span>
      {active.length === 0 && (
        <p class="forwards-empty" data-testid="forwards-none">
          No forwards added from Qutty on this connection.
        </p>
      )}
      <ul class="forwards-list">
        {active.map((f) => (
          <li
            key={forwardKey(f)}
            class="forwards-row"
            data-testid="forward-row"
            data-key={forwardKey(f)}
          >
            <span class="mono">{forwardText(f)}</span>
            {canSave && !favorites.some((x) => sameForward(x, f)) && (
              <button
                type="button"
                class="btn-quiet"
                data-testid="forward-keep"
                disabled={busy}
                onClick={() => void saveFavorites(addForward(favorites, f))}
              >
                Keep as favourite
              </button>
            )}
            <button
              type="button"
              class="btn-quiet is-danger"
              data-testid="forward-cancel"
              disabled={busy}
              onClick={() => void stop(f)}
            >
              Stop
            </button>
          </li>
        ))}
      </ul>

      {configured.length > 0 && (
        <>
          <span class="theme-group-label">From the ssh config</span>
          <ul class="forwards-list" data-testid="forwards-configured">
            {configured.map((f) => (
              <li key={forwardKey(f)} class="forwards-row is-readonly">
                <span class="mono">{forwardText(f)}</span>
                <span class="field-hint">opens with every connection</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {favorites.length > 0 && (
        <>
          <span class="theme-group-label">Favourites</span>
          <ul class="forwards-list" data-testid="forwards-favorites">
            {favorites.map((f) => (
              <li
                key={forwardKey(f)}
                class="forwards-row"
                data-testid="forward-favorite"
                data-key={forwardKey(f)}
              >
                <span class="mono">{forwardText(f)}</span>
                {isActive(f) ? <span class="field-hint">running</span> : (
                  <button
                    type="button"
                    class="btn-quiet"
                    data-testid="forward-start"
                    disabled={busy || !status?.master}
                    onClick={() => void start(f)}
                  >
                    Start
                  </button>
                )}
                <button
                  type="button"
                  class="strip-x"
                  aria-label="Forget this favourite"
                  data-testid="forward-forget"
                  disabled={busy}
                  onClick={() =>
                    void saveFavorites(removeForward(favorites, f))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <form
        class="forwards-add"
        data-testid="forward-form"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <span class="theme-group-label">Add a forward</span>
        <div class="forwards-kinds" role="radiogroup" aria-label="Kind">
          {FORWARD_KINDS.map((k) => (
            <button
              type="button"
              key={k}
              role="radio"
              aria-checked={kind === k}
              class={`btn-quiet${kind === k ? " is-active" : ""}`}
              data-testid="forward-kind"
              data-kind={k}
              onClick={() => setKind(k)}
            >
              {kindLabel(k)}
            </button>
          ))}
        </div>
        <div class="forwards-spec">
          <input
            ref={specRef}
            type="text"
            class={`text-input${touched && parsed.error ? " is-invalid" : ""}`}
            data-testid="forward-spec"
            aria-label="Forward"
            placeholder={specPlaceholder(kind)}
            spellcheck={false}
            autocomplete="off"
            value={spec}
            onInput={(e) => {
              setSpec(e.currentTarget.value);
              setTouched(false);
            }}
          />
          <button
            type="submit"
            class="btn-primary"
            data-testid="forward-add"
            disabled={busy || !status?.master}
          >
            Add
          </button>
        </div>
        {touched && parsed.error && (
          <span class="form-field-error" data-testid="forward-spec-error">
            {parsed.error}
          </span>
        )}
        {canSave
          ? (
            <label class="form-check">
              <input
                type="checkbox"
                data-testid="forward-save"
                checked={keep}
                onChange={(e) => setKeep(e.currentTarget.checked)}
              />
              Also keep it as a favourite for {host!.alias}
            </label>
          )
          : (
            <p class="field-hint">
              {host
                ? "Favourites are kept for Qutty hosts: duplicate this host into Qutty hosts to keep some."
                : "Save this host in Qutty to keep favourite forwards."}
            </p>
          )}
      </form>
    </div>
  );
}

/** The panel as a dialog of its own (from an SSH tile's header). */
export function ForwardsDialog(
  props: ForwardsPanelProps & { onClose(): void },
) {
  return (
    <Modal
      label={`Port forwards for ${props.label}`}
      testid="forwards-dialog"
      class="forwards-dialog"
      onClose={props.onClose}
    >
      <div class="modal-head">
        <h2>
          Port forwards · <span class="mono">{props.label}</span>
        </h2>
        <button
          type="button"
          class="bar-btn"
          data-testid="forwards-close"
          aria-label="Close port forwards"
          onClick={props.onClose}
        >
          ×
        </button>
      </div>
      <div class="forwards-body">
        <ForwardsPanel
          backend={props.backend}
          target={props.target}
          label={props.label}
        />
      </div>
    </Modal>
  );
}
