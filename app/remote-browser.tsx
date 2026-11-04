// The download picker: a remote folder listing (sftp over the tile's shared connection) to
// pick a file or folder from. It starts in the remote home; the backend answers with the
// absolute path, which every later step builds on. Keyboard: ↑ / ↓ select, Enter opens a
// folder or downloads a file, Backspace goes up, Escape closes.

import { useEffect, useRef, useState } from "denext";
import type { PtyBackend } from "../lib/pty-client.ts";
import type { SshTarget } from "../lib/ssh-config.ts";
import type { SshDirEntry, SshListing } from "../lib/ssh-command.ts";
import {
  formatSize,
  joinRemote,
  parentRemote,
  sortEntries,
} from "../lib/ssh-ui.ts";
import { Modal } from "./modal.tsx";

export interface RemoteBrowserProps {
  backend: PtyBackend;
  target: SshTarget;
  label: string;
  /** Download this remote path (a file or a folder). */
  onPick(remotePath: string): void;
  onClose(): void;
}

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export function RemoteBrowser(props: RemoteBrowserProps) {
  const [listing, setListing] = useState<SshListing | null>(null);
  const [entries, setEntries] = useState<SshDirEntry[]>([]);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);

  const open = async (path?: string) => {
    setLoading(true);
    try {
      const l = await props.backend.sshList({
        target: props.target,
        ...(path !== undefined ? { path } : {}),
      });
      setListing(l);
      setEntries(sortEntries(l.entries));
      setIndex(0);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
      listRef.current?.focus();
    }
  };
  useEffect(() => {
    listRef.current?.focus();
    void open();
  }, []);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".is-selected")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [index, entries]);

  const selected = entries[index];
  const pathOf = (e: SshDirEntry) =>
    listing ? joinRemote(listing.path, e.name) : e.name;
  const activate = (e: SshDirEntry | undefined) => {
    if (!e) return;
    if (e.kind === "dir") void open(pathOf(e));
    else props.onPick(pathOf(e));
  };
  const up = () => {
    if (listing && listing.path !== "/") void open(parentRemote(listing.path));
  };

  return (
    <Modal
      label={`Download from ${props.label}`}
      testid="remote-browser"
      class="remote-browser"
      onClose={props.onClose}
    >
      <div class="modal-head">
        <h2>
          Download from <span class="mono">{props.label}</span>
        </h2>
        <button
          type="button"
          class="bar-btn"
          data-testid="remote-close"
          aria-label="Close"
          onClick={props.onClose}
        >
          ×
        </button>
      </div>
      <div class="remote-path">
        <button
          type="button"
          class="btn-quiet"
          data-testid="remote-up"
          disabled={!listing || listing.path === "/"}
          onClick={up}
          aria-label="Up one folder"
        >
          ↑ Up
        </button>
        <span class="mono" data-testid="remote-path">
          {listing?.path ?? "~"}
        </span>
        {loading && <span class="remote-loading">listing…</span>}
      </div>
      {error && (
        <p class="form-error" role="alert" data-testid="remote-error">
          {error}
        </p>
      )}
      <div
        class="remote-list"
        role="listbox"
        aria-label="Remote files"
        tabIndex={0}
        ref={listRef}
        data-testid="remote-list"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const d = e.key === "ArrowDown" ? 1 : -1;
            setIndex((i) => Math.min(entries.length - 1, Math.max(0, i + d)));
          } else if (e.key === "Enter") {
            e.preventDefault();
            activate(selected);
          } else if (e.key === "Backspace") {
            e.preventDefault();
            up();
          }
        }}
      >
        {entries.map((e, i) => (
          <div
            key={e.name}
            role="option"
            aria-selected={i === index}
            class={`remote-row${i === index ? " is-selected" : ""}`}
            data-testid="remote-row"
            data-name={e.name}
            data-kind={e.kind}
            onClick={() => setIndex(i)}
            onDoubleClick={() => activate(e)}
          >
            <span class={`remote-icon is-${e.kind}`} aria-hidden="true" />
            <span class="remote-name">
              {e.name}
              {e.target !== undefined && (
                <span class="remote-link">→ {e.target}</span>
              )}
            </span>
            <span class="remote-size">
              {e.kind === "dir" ? "" : formatSize(e.size)}
            </span>
          </div>
        ))}
        {listing && entries.length === 0 && (
          <p class="conn-empty">This folder is empty.</p>
        )}
      </div>
      <div class="modal-foot">
        <span>Saves to ~/Downloads (never overwrites)</span>
        <span class="modal-foot-end pane-actions">
          <button
            type="button"
            class="btn-quiet"
            data-testid="remote-cancel"
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn-primary"
            data-testid="remote-download"
            disabled={!selected}
            onClick={() => selected && props.onPick(pathOf(selected))}
          >
            {selected?.kind === "dir" ? "Download folder" : "Download"}
          </button>
        </span>
      </div>
    </Modal>
  );
}
