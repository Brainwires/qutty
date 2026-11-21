// What every web tile in a window shares, and every window too (lib/web/synced.ts: each on its
// own localStorage key, followed across windows): the bookmarks, the visited pages, the zoom
// each site was left at and the permissions each site was always allowed or denied
// (lib/web/site-permissions.ts). Plus which of the browser dialogs (the bookmark manager, History) is
// open: the bar, the star and the `+` menu open them, the workspace shows them.

import { useEffect, useState } from "denext";
import {
  type Bookmarks,
  BOOKMARKS_STORAGE_KEY,
  sanitizeBookmarks,
} from "../lib/web/bookmarks.ts";
import {
  sanitizeSitePermissions,
  SITE_PERMISSIONS_STORAGE_KEY,
  type SitePermissions,
} from "../lib/web/site-permissions.ts";
import { type SyncedStore, syncedStore } from "../lib/web/synced.ts";
import {
  sanitizeVisits,
  type Visits,
  VISITS_STORAGE_KEY,
} from "../lib/web/visits.ts";
import {
  sanitizeZoom,
  type SiteZoom,
  ZOOM_STORAGE_KEY,
} from "../lib/web/zoom.ts";

export const bookmarksStore: SyncedStore<Bookmarks> = syncedStore(
  BOOKMARKS_STORAGE_KEY,
  sanitizeBookmarks,
);
export const visitsStore: SyncedStore<Visits> = syncedStore(
  VISITS_STORAGE_KEY,
  sanitizeVisits,
);
export const zoomStore: SyncedStore<SiteZoom> = syncedStore(
  ZOOM_STORAGE_KEY,
  sanitizeZoom,
);
export const sitePermissionsStore: SyncedStore<SitePermissions> = syncedStore(
  SITE_PERMISSIONS_STORAGE_KEY,
  sanitizeSitePermissions,
);

/** Follow `store`'s value. */
export function useSynced<T>(store: SyncedStore<T>): T {
  const [value, setValue] = useState(() => store.get());
  useEffect(() => {
    setValue(store.get());
    return store.subscribe(setValue);
  }, [store]);
  return value;
}

/** A browser dialog: the bookmark manager (on a folder, or with a bookmark picked), History. */
export type WebDialog =
  | { kind: "bookmarks"; folderId?: string; selectId?: string }
  | { kind: "history" };

let dialog: WebDialog | null = null;
const dialogListeners = new Set<(d: WebDialog | null) => void>();

/** Open (or close, `null`) a browser dialog. */
export function openWebDialog(next: WebDialog | null): void {
  dialog = next;
  for (const fn of [...dialogListeners]) fn(dialog);
}

/** The open browser dialog. */
export function useWebDialog(): WebDialog | null {
  const [d, setD] = useState(dialog);
  useEffect(() => {
    dialogListeners.add(setD);
    setD(dialog);
    return () => void dialogListeners.delete(setD);
  }, []);
  return d;
}
