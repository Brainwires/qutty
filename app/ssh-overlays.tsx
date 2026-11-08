// What an SSH tile draws over its terminal: the Disconnected card (Reconnect / Close), and a
// stack of strips at the bottom: the upload confirmation for dropped files, the offer to save
// a quick-connect host, and one row per transfer (progress, Cancel, then the outcome).

import { useEffect, useRef, useState } from "denext";
import type { SshQuickTarget } from "../lib/ssh-config.ts";
import { targetLabel } from "../lib/ssh-config.ts";
import {
  baseName,
  disconnectMessage,
  exitReason,
  itemCount,
  transferCount,
  transferState,
  transferText,
  type TransferView,
} from "../lib/ssh-ui.ts";
import type { TerminalEntry } from "../lib/workspace/store.ts";

/** Files dropped on a tile, waiting for Upload / Cancel. */
export interface PendingUpload {
  localPaths: string[];
  /** The remote folder (OSC 7's report, else `~`); editable in the strip. */
  remoteDir: string;
}

export interface SshTileOverlayProps {
  entry: TerminalEntry;
  focused: boolean;
  transfers: TransferView[];
  upload?: PendingUpload;
  offer?: SshQuickTarget;
  onReconnect(): void;
  onClose(): void;
  onUpload(remoteDir: string): void;
  onCancelUpload(): void;
  onCancelTransfer(transferId: string): void;
  onDismissTransfer(transferId: string): void;
  onSaveOffer(): void;
  onDismissOffer(): void;
}

export function SshTileOverlay(props: SshTileOverlayProps) {
  const { entry } = props;
  const strips = props.upload || props.offer || props.transfers.length > 0;
  return (
    <>
      {entry.exited && (
        <Disconnected
          entry={entry}
          focused={props.focused}
          onReconnect={props.onReconnect}
          onClose={props.onClose}
        />
      )}
      {strips && (
        <div class="tile-strips" data-testid="tile-strips">
          {props.upload && (
            <UploadStrip
              upload={props.upload}
              onUpload={props.onUpload}
              onCancel={props.onCancelUpload}
            />
          )}
          {props.offer && (
            <div class="tile-strip" data-testid="save-offer">
              <span class="tile-strip-text">
                Save <span class="mono">{targetLabel(props.offer)}</span>{" "}
                as a Qutty host?
              </span>
              <button
                type="button"
                class="btn-quiet"
                data-testid="save-offer-yes"
                onClick={props.onSaveOffer}
              >
                Save…
              </button>
              <button
                type="button"
                class="strip-x"
                aria-label="Not now"
                data-testid="save-offer-no"
                onClick={props.onDismissOffer}
              >
                ×
              </button>
            </div>
          )}
          {props.transfers.map((t) => (
            <TransferRow
              key={t.transferId}
              t={t}
              onCancel={() => props.onCancelTransfer(t.transferId)}
              onDismiss={() => props.onDismissTransfer(t.transferId)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function Disconnected(props: {
  entry: TerminalEntry;
  focused: boolean;
  onReconnect(): void;
  onClose(): void;
}) {
  const { entry } = props;
  const reconnectRef = useRef<HTMLButtonElement | null>(null);
  // The terminal is dead: when its tile has the focus, the keyboard goes to Reconnect.
  useEffect(() => {
    if (props.focused) reconnectRef.current?.focus();
  }, [props.focused]);
  const exit = {
    exitCode: entry.exitCode,
    signal: entry.exitSignal,
    message: entry.exitMessage,
  };
  return (
    <div class="tile-overlay" data-testid="disconnected">
      <div class="disconnect-card" role="alert">
        <div class="disconnect-head">
          <span class="disconnect-title">Disconnected</span>
          <span class="disconnect-code" data-testid="disconnected-code">
            {exitReason(exit)}
          </span>
        </div>
        <p class="disconnect-msg" data-testid="disconnected-message">
          {disconnectMessage(exit)}
        </p>
        <div class="pane-actions">
          <button
            type="button"
            class="btn-primary"
            ref={reconnectRef}
            data-testid="reconnect"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={props.onReconnect}
          >
            Reconnect
          </button>
          <button
            type="button"
            class="btn-quiet"
            data-testid="disconnected-close"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={props.onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function UploadStrip(props: {
  upload: PendingUpload;
  onUpload(remoteDir: string): void;
  onCancel(): void;
}) {
  const [dir, setDir] = useState(props.upload.remoteDir);
  const uploadRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    setDir(props.upload.remoteDir);
    uploadRef.current?.focus();
  }, [props.upload]);
  const n = props.upload.localPaths.length;
  const names = props.upload.localPaths.map(baseName).join(", ");
  const go = () => props.onUpload(dir.trim() || "~");
  return (
    <div
      class="tile-strip is-question"
      data-testid="upload-confirm"
      title={names}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <span class="tile-strip-text">
        Upload {n === 1 ? <span class="mono">{names}</span> : itemCount(n)} to
      </span>
      <input
        type="text"
        class="text-input strip-input"
        data-testid="upload-dir"
        aria-label="Remote folder"
        spellcheck={false}
        value={dir}
        size={Math.max(4, Math.min(28, dir.length + 1))}
        onInput={(e) => setDir(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            go();
          }
        }}
      />
      <span class="tile-strip-text">?</span>
      <button
        type="button"
        class="btn-primary"
        ref={uploadRef}
        data-testid="upload-yes"
        onClick={go}
      >
        Upload
      </button>
      <button
        type="button"
        class="btn-quiet"
        data-testid="upload-no"
        onClick={props.onCancel}
      >
        Cancel
      </button>
    </div>
  );
}

function TransferRow(props: {
  t: TransferView;
  onCancel(): void;
  onDismiss(): void;
}) {
  const { t } = props;
  const state = transferState(t);
  const count = transferCount(t);
  return (
    <div
      class={`tile-strip transfer is-${state}`}
      data-testid="transfer"
      data-state={state}
      data-kind={t.kind}
    >
      <span class="transfer-arrow" aria-hidden="true">
        {t.kind === "upload" ? "↑" : "↓"}
      </span>
      <span class="tile-strip-text" data-testid="transfer-text">
        {transferText(t)}
      </span>
      {state === "running" && (
        <>
          {count && <span class="transfer-count">{count}</span>}
          <span
            class="transfer-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={t.percent}
          >
            <span style={{ width: `${t.percent}%` }} />
          </span>
          <span class="transfer-pct" data-testid="transfer-percent">
            {t.percent}%
          </span>
          <button
            type="button"
            class="btn-quiet"
            data-testid="transfer-cancel"
            onClick={props.onCancel}
          >
            Cancel
          </button>
        </>
      )}
      {state !== "running" && (
        <button
          type="button"
          class="strip-x"
          aria-label="Dismiss"
          data-testid="transfer-dismiss"
          onClick={props.onDismiss}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** The SSH tile's header action: Download…. */
export function SshHeadActions(props: {
  entry: TerminalEntry;
  onDownload(): void;
  onForwards(): void;
}) {
  if (props.entry.exited) return null;
  return (
    <>
      <HeadAction
        testid="tile-forwards"
        title="Port forwards on this connection…"
        label="Forwards…"
        path="M2.5 5.5h9M9 3l2.5 2.5L9 8M13.5 10.5h-9M7 8l-2.5 2.5L7 13"
        onClick={props.onForwards}
      />
      <HeadAction
        testid="tile-download"
        title="Download a file from this host…"
        label="Download…"
        path="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"
        onClick={props.onDownload}
      />
    </>
  );
}

function HeadAction(props: {
  testid: string;
  title: string;
  label: string;
  /** The icon's stroke. */
  path: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      class="tile-action"
      data-testid={props.testid}
      title={props.title}
      aria-label={props.title.replace(/…$/, "")}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path
          d={props.path}
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          fill="none"
        />
      </svg>
      <span>{props.label}</span>
    </button>
  );
}
