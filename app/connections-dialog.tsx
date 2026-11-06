// The SSH connection manager: a keyboard-first modal. The filter field has focus from the
// start; ↑ / ↓ move the selection, Enter connects in a new tile, Escape closes. The list is
// grouped Favorites / Qutty hosts / ~/.ssh/config / Recent (lib/connections.ts); the detail
// pane shows the selected host and its actions. Qutty hosts (qutty.conf) can be edited,
// renamed and deleted here; hosts from the user's own config are read-only and can be
// duplicated into Qutty hosts. Text that matches nothing but reads as `user@host:port` offers
// a quick connect.
//
// Passwords never pass through here: ssh asks for them in the tile's terminal.
//
// No confirm()/alert(): they block the desktop bridge. Deleting asks inside the pane.

import { useEffect, useMemo, useRef, useState } from "denext";
import {
  connectionGroups,
  type ConnectionItem,
  EMPTY_FORM,
  flattenGroups,
  type FormErrors,
  formForDuplicate,
  formFromHost,
  formFromQuickTarget,
  type HostForm,
  hostInputFromForm,
  keepSelection,
  moveSelection,
  quickConnectTarget,
} from "../lib/connections.ts";
import type { PtyBackend } from "../lib/pty-client.ts";
import {
  type SshHost,
  type SshQuickTarget,
  type SshTarget,
  targetLabel,
} from "../lib/ssh-config.ts";
import type { SshRecent } from "../lib/ssh-command.ts";
import { type KeyPlatform, shortcutLabel } from "../lib/workspace/keys.ts";
import { isTintId, TINT_IDS } from "../lib/workspace/themes.ts";
import { Modal } from "./modal.tsx";

/** What to connect to, as the workspace opens it. */
export interface ConnectRequest {
  target: SshTarget;
  label: string;
  tint?: string;
  /** A quick-connect destination (the tile then offers to save it). */
  quick?: SshQuickTarget;
}

export interface ConnectionsDialogProps {
  backend: PtyBackend;
  platform: KeyPlatform;
  /** Open straight into the New form, prefilled (the "save this host" offer). */
  initialForm?: HostForm;
  onConnect(request: ConnectRequest): void;
  onClose(): void;
}

/** The detail pane's mode. */
type Pane =
  | { mode: "view" }
  | { mode: "form"; form: HostForm; previousAlias?: string; errors: FormErrors }
  | { mode: "confirmDelete"; host: SshHost };

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** The request for a row. */
function requestFor(item: ConnectionItem): ConnectRequest {
  const quick = "alias" in item.target ? undefined : item.target;
  return {
    target: item.target,
    label: item.label,
    ...(isTintId(item.host?.tint) ? { tint: item.host!.tint } : {}),
    ...(quick && !item.host ? { quick } : {}),
  };
}

export function ConnectionsDialog(props: ConnectionsDialogProps) {
  const { backend } = props;
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [recents, setRecents] = useState<SshRecent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  // The row asked for; what is shown selected is that row if it is still listed, else the first.
  const [wanted, setWanted] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>(() =>
    props.initialForm
      ? { mode: "form", form: props.initialForm, errors: {} }
      : { mode: "view" }
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const reload = async (select?: string) => {
    try {
      const r = await backend.sshHosts();
      setHosts(r.hosts);
      setRecents(r.recents);
      if (select) setWanted(select);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => {
    void reload();
    if (!props.initialForm) filterRef.current?.focus();
  }, []);

  const groups = useMemo(
    () => connectionGroups(hosts, recents, query),
    [hosts, recents, query],
  );
  const items = useMemo(() => flattenGroups(groups), [groups]);
  const quick = quickConnectTarget(query, groups);
  const selected = keepSelection(items, wanted);
  const current = items.find((i) => i.key === selected) ?? null;

  // Keep the selected row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(".is-selected");
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const connect = (req: ConnectRequest) => {
    props.onConnect(req);
  };
  const connectQuick = (t: SshQuickTarget) =>
    connect({ target: t, label: targetLabel(t), quick: t });

  const onFilterKey = (e: { key: string; preventDefault(): void }) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setWanted(moveSelection(items, selected, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (current) connect(requestFor(current));
      else if (quick) connectQuick(quick);
    }
  };

  const startEdit = (form: HostForm, previousAlias?: string) => {
    setError(null);
    setPane({ mode: "form", form, previousAlias, errors: {} });
  };
  const backToView = () => {
    setPane({ mode: "view" });
    setError(null);
    filterRef.current?.focus();
  };

  const save = async (form: HostForm, previousAlias?: string) => {
    const checked = hostInputFromForm(form, previousAlias);
    if (!checked.input) {
      setPane({ mode: "form", form, previousAlias, errors: checked.errors });
      return;
    }
    setBusy(true);
    try {
      const saved = await backend.sshSaveHost(checked.input);
      setQuery("");
      await reload(`${saved.favorite ? "favorites" : "qutty"}:${saved.alias}`);
      backToView();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (host: SshHost) => {
    setBusy(true);
    try {
      await backend.sshDeleteHost(host.alias);
      await reload();
      backToView();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const mod = (keys: string) => shortcutLabel(keys, props.platform);

  return (
    <Modal
      label="Connections"
      testid="connections-dialog"
      class="connections"
      onClose={props.onClose}
    >
      <div class="modal-head">
        <h2>Connections</h2>
        <button
          type="button"
          class="btn-quiet"
          data-testid="conn-new"
          onClick={() => startEdit({ ...EMPTY_FORM })}
        >
          New host
        </button>
        <button
          type="button"
          class="bar-btn"
          data-testid="conn-close"
          aria-label="Close connections"
          onClick={props.onClose}
        >
          ×
        </button>
      </div>
      <div class="conn-filter-row">
        <input
          ref={filterRef}
          type="text"
          class="text-input conn-filter"
          data-testid="conn-filter"
          placeholder="Filter hosts, or type user@host:port"
          spellcheck={false}
          autocomplete="off"
          aria-label="Filter hosts"
          aria-controls="conn-list"
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onFilterKey}
        />
      </div>
      <div class="conn-body">
        <div
          class="conn-list"
          id="conn-list"
          role="listbox"
          aria-label="Hosts"
          data-testid="conn-list"
          ref={listRef}
        >
          {groups.map((g) => (
            <div class="conn-group" key={g.id} data-group={g.id}>
              <span class="theme-group-label">{g.label}</span>
              {g.items.map((item) => (
                <HostRow
                  key={item.key}
                  item={item}
                  selected={item.key === selected}
                  onSelect={() => setWanted(item.key)}
                  onConnect={() =>
                    connect(requestFor(item))}
                />
              ))}
            </div>
          ))}
          {quick && (
            <button
              type="button"
              class="conn-quick"
              data-testid="conn-quick"
              onClick={() => connectQuick(quick)}
            >
              <span class="conn-quick-verb">Connect to</span>
              <span class="conn-quick-target">{targetLabel(quick)}</span>
              <kbd>↵</kbd>
            </button>
          )}
          {loaded && items.length === 0 && !quick && (
            <p class="conn-empty" data-testid="conn-empty">
              {hosts.length === 0 && recents.length === 0 && query === ""
                ? "No hosts in ~/.ssh/config yet. Add one with New host."
                : "No hosts match. Type user@host or user@host:port to connect."}
            </p>
          )}
        </div>
        <div class="conn-detail" data-testid="conn-detail">
          {error && (
            <p class="form-error" role="alert" data-testid="conn-error">
              {error}
            </p>
          )}
          {pane.mode === "form" && (
            <HostFormPane
              form={pane.form}
              errors={pane.errors}
              editing={pane.previousAlias !== undefined}
              busy={busy}
              onChange={(form) => setPane({ ...pane, form })}
              onSave={() => void save(pane.form, pane.previousAlias)}
              onCancel={backToView}
            />
          )}
          {pane.mode === "confirmDelete" && (
            <ConfirmDelete
              host={pane.host}
              busy={busy}
              onDelete={() => void remove(pane.host)}
              onCancel={backToView}
            />
          )}
          {pane.mode === "view" && current && (
            <HostDetail
              item={current}
              onConnect={() => connect(requestFor(current))}
              onEdit={(h) => startEdit(formFromHost(h), h.alias)}
              onDelete={(h) => setPane({ mode: "confirmDelete", host: h })}
              onDuplicate={(h) => startEdit(formForDuplicate(h, hosts))}
              onSaveQuick={(t) => startEdit(formFromQuickTarget(t))}
            />
          )}
          {pane.mode === "view" && !current && (
            <p class="conn-placeholder">
              {quick
                ? "Press Enter to connect. You can save the host afterwards."
                : "Select a host to see its settings."}
            </p>
          )}
        </div>
      </div>
      <div class="modal-foot">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> select
        </span>
        <span>
          <kbd>↵</kbd> connect in a new tile
        </span>
        <span>
          <kbd>esc</kbd> close
        </span>
        <span class="modal-foot-end">
          <kbd>{mod("Mod+Shift+O")}</kbd> opens this
        </span>
      </div>
    </Modal>
  );
}

function HostRow(props: {
  item: ConnectionItem;
  selected: boolean;
  onSelect(): void;
  onConnect(): void;
}) {
  const { item } = props;
  const tint = isTintId(item.host?.tint) ? item.host!.tint : undefined;
  return (
    <div
      role="option"
      aria-selected={props.selected}
      class={`conn-row${props.selected ? " is-selected" : ""}`}
      data-testid="conn-row"
      data-key={item.key}
      data-group={item.group}
      onPointerDown={(e) => e.preventDefault()} // keep focus in the filter field
      onClick={props.onSelect}
      onDoubleClick={props.onConnect}
    >
      <span class="conn-tint" data-tint={tint} aria-hidden="true" />
      <span class="conn-row-text">
        <span class="conn-row-label">{item.label}</span>
        {item.detail !== item.label && (
          <span class="conn-row-detail">{item.detail}</span>
        )}
      </span>
      {item.host?.tags?.map((t) => <span class="tag" key={t}>{t}</span>)}
    </div>
  );
}

/** One `label: value` line of the detail pane (left out when there is no value). */
function Fact(
  props: { label: string; value?: string | number; mono?: boolean },
) {
  if (props.value === undefined || props.value === "") return null;
  return (
    <div class="fact">
      <dt>{props.label}</dt>
      <dd class={props.mono === false ? "" : "mono"}>{props.value}</dd>
    </div>
  );
}

interface HostDetailProps {
  item: ConnectionItem;
  onConnect(): void;
  onEdit(host: SshHost): void;
  onDelete(host: SshHost): void;
  onDuplicate(host: SshHost): void;
  onSaveQuick(target: SshQuickTarget): void;
}

function HostDetail(props: HostDetailProps) {
  const { item } = props;
  const h = item.host;
  const quick = "alias" in item.target ? undefined : item.target;
  const tint = isTintId(h?.tint) ? h!.tint : undefined;
  return (
    <div class="host-detail" data-testid="host-detail" data-key={item.key}>
      <div class="host-detail-head">
        <span class="conn-tint is-large" data-tint={tint} aria-hidden="true" />
        <h3 data-testid="host-detail-label">{item.label}</h3>
        {h && !h.editable && (
          <span class="tag" data-testid="host-readonly">read-only</span>
        )}
      </div>
      <dl class="facts">
        <Fact label="User" value={h?.user ?? quick?.user} />
        <Fact label="Host" value={h?.hostName ?? quick?.host} />
        <Fact label="Port" value={h?.port ?? quick?.port} />
        <Fact label="Key" value={h?.identityFile} />
        <Fact label="Jump host" value={h?.proxyJump} />
        <Fact label="Tags" value={h?.tags?.join(", ")} mono={false} />
        <Fact label="Tint" value={tint} mono={false} />
        <Fact
          label="tmux"
          value={h?.tmux ? "attach on connect" : undefined}
          mono={false}
        />
        <Fact label="Command" value={h?.remoteCommand} />
        <Fact label="From" value={h?.source} />
      </dl>
      {h && h.directives.length > 0 && (
        <div class="directives" data-testid="host-directives">
          <span class="theme-group-label">Other settings</span>
          <ul>
            {h.directives.map((d, i) => (
              <li key={i}>
                <span class="mono">{d.key}</span> {d.value}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div class="pane-actions">
        <button
          type="button"
          class="btn-primary"
          data-testid="host-connect"
          onClick={props.onConnect}
        >
          Connect
        </button>
        {h?.editable && (
          <button
            type="button"
            class="btn-quiet"
            data-testid="host-edit"
            onClick={() => props.onEdit(h)}
          >
            Edit
          </button>
        )}
        {h?.editable && (
          <button
            type="button"
            class="btn-quiet is-danger"
            data-testid="host-delete"
            onClick={() => props.onDelete(h)}
          >
            Delete
          </button>
        )}
        {h && !h.editable && (
          <button
            type="button"
            class="btn-quiet"
            data-testid="host-duplicate"
            onClick={() => props.onDuplicate(h)}
          >
            Duplicate to Qutty hosts
          </button>
        )}
        {!h && quick && (
          <button
            type="button"
            class="btn-quiet"
            data-testid="host-save-quick"
            onClick={() => props.onSaveQuick(quick)}
          >
            Save as a Qutty host
          </button>
        )}
      </div>
      {h && !h.editable && (
        <p class="field-hint">
          This host is in your own ssh config, which Qutty never rewrites.
        </p>
      )}
    </div>
  );
}

function ConfirmDelete(props: {
  host: SshHost;
  busy: boolean;
  onDelete(): void;
  onCancel(): void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <div
      class="confirm"
      data-testid="host-confirm-delete"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        props.onCancel();
      }}
    >
      <h3>Delete {props.host.alias}?</h3>
      <p class="field-hint">
        It is removed from ~/.ssh/qutty.conf. Open tiles stay connected.
      </p>
      <div class="pane-actions">
        <button
          type="button"
          class="btn-primary is-danger"
          data-testid="host-confirm-delete-yes"
          disabled={props.busy}
          onClick={props.onDelete}
        >
          Delete
        </button>
        <button
          type="button"
          class="btn-quiet"
          ref={cancelRef}
          data-testid="host-confirm-delete-no"
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

interface HostFormPaneProps {
  form: HostForm;
  errors: FormErrors;
  editing: boolean;
  busy: boolean;
  onChange(form: HostForm): void;
  onSave(): void;
  onCancel(): void;
}

type TextKey = Exclude<keyof HostForm, "favorite" | "tmux" | "tint">;

function HostFormPane(props: HostFormPaneProps) {
  const { form, errors } = props;
  const firstRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => firstRef.current?.focus(), []);
  const text = (key: TextKey, label: string, placeholder = "") => (
    <label class="form-field" key={key}>
      <span class="form-label">{label}</span>
      <input
        ref={key === "alias" ? firstRef : undefined}
        type="text"
        class={`text-input${errors[key] ? " is-invalid" : ""}`}
        data-testid={`form-${key}`}
        placeholder={placeholder}
        spellcheck={false}
        autocomplete="off"
        value={form[key]}
        onInput={(e) =>
          props.onChange({ ...form, [key]: e.currentTarget.value })}
      />
      {errors[key] && (
        <span class="form-field-error" data-testid={`form-error-${key}`}>
          {errors[key]}
        </span>
      )}
    </label>
  );
  const check = (key: "favorite" | "tmux", label: string) => (
    <label class="form-check">
      <input
        type="checkbox"
        data-testid={`form-${key}`}
        checked={form[key]}
        onChange={(e) =>
          props.onChange({ ...form, [key]: e.currentTarget.checked })}
      />
      {label}
    </label>
  );
  return (
    <form
      class="host-form"
      data-testid="host-form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        props.onCancel();
      }}
    >
      <h3>{props.editing ? `Edit ${form.alias}` : "New Qutty host"}</h3>
      <div class="form-grid">
        {text("alias", "Name", "web-1")}
        {text("hostName", "Host", "web-1.example.com")}
        {text("user", "User", "deploy")}
        {text("port", "Port", "22")}
        {text("identityFile", "Key file", "~/.ssh/id_ed25519")}
        {text("proxyJump", "Jump host", "bastion")}
        {text("tags", "Tags", "prod, eu")}
        {text("remoteCommand", "Remote command", "")}
      </div>
      <div class="form-field">
        <span class="form-label">Tint</span>
        <TintPicker
          value={form.tint}
          onChange={(tint) => props.onChange({ ...form, tint })}
        />
      </div>
      <div class="form-checks">
        {check("favorite", "Favorite")}
        {check("tmux", "Attach to tmux on connect")}
      </div>
      {props.editing && (
        <p class="field-hint">
          Settings this form does not show (forwards, agent…) are kept.
        </p>
      )}
      <div class="pane-actions">
        <button
          type="submit"
          class="btn-primary"
          data-testid="form-save"
          disabled={props.busy}
        >
          Save
        </button>
        <button
          type="button"
          class="btn-quiet"
          data-testid="form-cancel"
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function TintPicker(props: { value: string; onChange(tint: string): void }) {
  const options = ["", ...TINT_IDS];
  return (
    <div class="tint-picker" role="radiogroup" aria-label="Tint">
      {options.map((t) => (
        <button
          type="button"
          key={t || "none"}
          role="radio"
          aria-checked={props.value === t}
          aria-label={t || "no tint"}
          title={t || "no tint"}
          class={`tint-swatch${props.value === t ? " is-active" : ""}`}
          data-testid="form-tint"
          data-value={t || "none"}
          data-tint={t || undefined}
          onClick={() => props.onChange(t)}
        />
      ))}
    </div>
  );
}
