// The workspace's SSH state, outside workspace.tsx: which dialog is open (the connection
// manager, the download picker), the transfers (one `onTransfer` subscription for the app's
// lifetime), files dropped on SSH tiles waiting for confirmation, and the "save this host"
// offers of quick-connect tiles.
//
// Dropped files. Inside the desktop window, `onFileDrop` (denext/desktop/window) hands over the
// drop point and each file's absolute path (plus a read-only handle Qutty does not need: scp
// reads the files itself); the page's own DOM `drop` event, which carries no paths, only drives
// the hover style there. In a plain browser (the demo backend) the DOM drop is all there is, so
// the file names stand in for paths in the demo's fake home.

import { useCallback, useEffect, useRef, useState } from "denext";
import { onFileDrop } from "denext/desktop/window";
import type { HostForm } from "../lib/connections.ts";
import { formFromQuickTarget } from "../lib/connections.ts";
import type { SshQuickTarget } from "../lib/ssh-config.ts";
import {
  applyTransferEvent,
  bindTransfer,
  dismissTransfer,
  type SshProfile,
  transferState,
  type TransferView,
} from "../lib/ssh-ui.ts";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import type { TerminalEntry } from "../lib/workspace/store.ts";
import type { ConnectRequest } from "./connections-dialog.tsx";
import type { PendingUpload } from "./ssh-overlays.tsx";

/** A finished upload's row goes away by itself after this long (failures stay). */
const UPLOAD_DONE_MS = 4000;
/** The demo backend's stand-in for a dropped file's folder. */
const DEMO_DROP_DIR = "/Users/demo/Desktop";

export interface UseSshOptions {
  manager: TerminalManager | null;
  /** The terminals, current (read in event handlers). */
  terminals: () => TerminalEntry[];
  /** Create a tile running `profile`; returns its id. */
  openTile(profile: SshProfile): string | null;
  /** Put the keyboard back in the focused terminal. */
  refocus(): void;
  cluster: { current: HTMLElement | null };
}

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** The SSH tile under a viewport point (one that is still connected), or `undefined`. */
function sshTileAt(
  terminals: TerminalEntry[],
  el: Element | null,
): TerminalEntry | undefined {
  const id = el?.closest<HTMLElement>("[data-testid=tile]")?.dataset.id;
  const entry = terminals.find((t) => t.id === id);
  return entry?.ssh && !entry.exited ? entry : undefined;
}

export function useSsh(opts: UseSshOptions) {
  const { manager } = opts;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [dialog, setDialog] = useState<{ form?: HostForm } | null>(null);
  const [browseFor, setBrowseFor] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<TransferView[]>([]);
  const [uploads, setUploads] = useState<Record<string, PendingUpload>>({});
  const [offers, setOffers] = useState<Record<string, SshQuickTarget>>({});
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const failSeq = useRef(0);
  const dismissTimers = useRef(new Set<string>());

  // Every transfer's progress, for the app's lifetime.
  useEffect(() => {
    if (!manager) return;
    return manager.backend.onTransfer((ev) =>
      setTransfers((list) => applyTransferEvent(list, ev))
    );
  }, [manager]);

  // A finished upload clears itself; downloads stay (they show where the file went).
  useEffect(() => {
    for (const t of transfers) {
      if (
        t.kind !== "upload" || transferState(t) !== "done" ||
        dismissTimers.current.has(t.transferId)
      ) continue;
      dismissTimers.current.add(t.transferId);
      setTimeout(
        () => setTransfers((list) => dismissTransfer(list, t.transferId)),
        UPLOAD_DONE_MS,
      );
    }
  }, [transfers]);

  /** Files dropped on a tile: ask before uploading them to its remote folder. */
  const offerUpload = useCallback((id: string, localPaths: string[]) => {
    if (localPaths.length === 0) return;
    const remoteDir = optsRef.current.manager?.remoteCwd(id) ?? "~";
    setUploads((u) => ({ ...u, [id]: { localPaths, remoteDir } }));
  }, []);

  // Desktop drops (absolute paths) and the DOM drag events (hover style; demo drops).
  useEffect(() => {
    const el = opts.cluster.current;
    if (!manager || !el) return;
    const native = manager.backend.kind === "desktop";
    const tileOf = (e: DragEvent) =>
      e.dataTransfer?.types.includes("Files")
        ? sshTileAt(optsRef.current.terminals(), e.target as Element)
        : undefined;
    const onOver = (e: DragEvent) => {
      const tile = tileOf(e);
      setDropTarget(tile?.id ?? null);
      if (!tile) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) setDropTarget(null);
    };
    const onDrop = (e: DragEvent) => {
      setDropTarget(null);
      const tile = tileOf(e);
      if (!tile) return;
      e.preventDefault();
      if (native) return; // `onFileDrop` brings the paths
      const names = [...(e.dataTransfer?.files ?? [])].map((f) => f.name);
      offerUpload(tile.id, names.map((n) => `${DEMO_DROP_DIR}/${n}`));
    };
    el.addEventListener("dragover", onOver);
    el.addEventListener("dragleave", onLeave);
    el.addEventListener("drop", onDrop);
    const stopNative = native
      ? onFileDrop(({ x, y, files }) => {
        const tile = sshTileAt(
          optsRef.current.terminals(),
          document.elementFromPoint(x, y),
        );
        if (tile) offerUpload(tile.id, files.map((f) => f.path));
      })
      : () => {};
    return () => {
      el.removeEventListener("dragover", onOver);
      el.removeEventListener("dragleave", onLeave);
      el.removeEventListener("drop", onDrop);
      stopNative();
    };
  }, [manager, offerUpload]);

  const profileOf = (id: string) => {
    const p = optsRef.current.manager?.profile(id);
    return p?.kind === "ssh" ? p : undefined;
  };

  /** A transfer that never started, shown as a failed row on the tile. */
  const failed = (
    terminalId: string,
    kind: TransferView["kind"],
    err: unknown,
  ) =>
    setTransfers((list) => [...list, {
      transferId: `failed-${++failSeq.current}`,
      terminalId,
      kind,
      percent: 0,
      filesDone: 0,
      done: true,
      error: errorText(err),
    }]);

  const upload = async (id: string, remoteDir: string) => {
    const pending = uploads[id];
    const profile = profileOf(id);
    setUploads(({ [id]: _, ...rest }) => rest);
    optsRef.current.refocus();
    if (!pending || !profile || !manager) return;
    try {
      const { transferId } = await manager.backend.sshUpload({
        target: profile.target,
        localPaths: pending.localPaths,
        remoteDir,
      });
      setTransfers((list) =>
        bindTransfer(list, transferId, {
          terminalId: id,
          kind: "upload",
          remoteDir,
        })
      );
    } catch (err) {
      failed(id, "upload", err);
    }
  };

  const download = async (id: string, remotePath: string) => {
    const profile = profileOf(id);
    setBrowseFor(null);
    optsRef.current.refocus();
    if (!profile || !manager) return;
    try {
      const started = await manager.backend.sshDownload({
        target: profile.target,
        remotePath,
      });
      setTransfers((list) =>
        bindTransfer(list, started.transferId, {
          terminalId: id,
          kind: "download",
          ...(started.localPath ? { localPath: started.localPath } : {}),
        })
      );
    } catch (err) {
      failed(id, "download", err);
    }
  };

  const connect = (req: ConnectRequest) => {
    setDialog(null);
    const id = optsRef.current.openTile({
      kind: "ssh",
      target: req.target,
      label: req.label,
      ...(req.tint ? { tint: req.tint } : {}),
    });
    if (id && req.quick) setOffers((o) => ({ ...o, [id]: req.quick! }));
  };

  /** Forget everything about a closed tile (a running transfer carries on unseen). */
  const forget = (id: string) => {
    setUploads(({ [id]: _, ...rest }) => rest);
    setOffers(({ [id]: _, ...rest }) => rest);
    setTransfers((list) => list.filter((t) => t.terminalId !== id));
    if (browseFor === id) setBrowseFor(null);
  };

  return {
    dialog,
    browseFor,
    dropTarget,
    /** Open the connection manager, or close it when it is open. */
    toggleDialog() {
      setDialog((d) => (d ? null : {}));
    },
    closeDialog() {
      setDialog(null);
      optsRef.current.refocus();
    },
    browse: setBrowseFor,
    closeBrowser() {
      setBrowseFor(null);
      optsRef.current.refocus();
    },
    connect,
    download,
    forget,
    /** What tile `id`'s overlay needs. */
    tile(id: string) {
      return {
        transfers: transfers.filter((t) => t.terminalId === id),
        upload: uploads[id],
        offer: offers[id],
        onUpload: (dir: string) => void upload(id, dir),
        onCancelUpload: () => {
          setUploads(({ [id]: _, ...rest }) => rest);
          optsRef.current.refocus();
        },
        onCancelTransfer: (transferId: string) =>
          void manager?.backend.sshCancel(transferId).catch(() => {}),
        onDismissTransfer: (transferId: string) =>
          setTransfers((list) => dismissTransfer(list, transferId)),
        onSaveOffer: () => {
          const target = offers[id];
          setOffers(({ [id]: _, ...rest }) => rest);
          if (target) setDialog({ form: formFromQuickTarget(target) });
        },
        onDismissOffer: () => setOffers(({ [id]: _, ...rest }) => rest),
      };
    },
  };
}
