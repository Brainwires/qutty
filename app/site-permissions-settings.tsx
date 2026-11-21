// Settings → Links → Site permissions: what web tiles remember a site was always allowed or denied
// (the permission bar's "Remember", app/web-chrome.tsx; lib/web/site-permissions.ts), one row per
// site and permission, with Forget per row and Clear all. Stored in the synced
// `sitePermissionsStore` (app/web-stores.ts), so every window's tiles follow at once; a forgotten
// permission is asked about again the next time the site wants it.

import {
  clearSitePermissions,
  forgetPermission,
  permissionEntries,
  permissionName,
} from "../lib/web/site-permissions.ts";
import { hostLabel } from "../lib/web/url.ts";
import { sitePermissionsStore, useSynced } from "./web-stores.ts";

export function SitePermissionsSection() {
  const stored = useSynced(sitePermissionsStore);
  const entries = permissionEntries(stored);
  return (
    <div class="site-permissions" data-testid="site-permissions">
      <div class="field">
        <span class="field-label">Remembered</span>
        {entries.length
          ? (
            <ul class="site-permission-list" aria-label="Site permissions">
              {entries.map((e) => (
                <li
                  class="site-permission"
                  data-testid="site-permission"
                  data-origin={e.origin}
                  data-kind={e.kind}
                  key={`${e.origin} ${e.kind}`}
                >
                  <span class="site-permission-site" title={e.origin}>
                    {hostLabel(e.origin)}
                  </span>
                  <span class="site-permission-kind">
                    {permissionName(e.kind)}
                  </span>
                  <span
                    class={`site-permission-choice is-${e.choice}`}
                    data-testid="site-permission-choice"
                  >
                    {e.choice === "allow" ? "Allowed" : "Denied"}
                  </span>
                  <button
                    type="button"
                    class="btn-quiet"
                    data-testid="site-permission-forget"
                    onClick={() =>
                      sitePermissionsStore.set(
                        forgetPermission(
                          sitePermissionsStore.get(),
                          e.origin,
                          e.kind,
                        ),
                      )}
                  >
                    Forget
                  </button>
                </li>
              ))}
            </ul>
          )
          : (
            <span class="field-hint" data-testid="site-permissions-empty">
              None yet.
            </span>
          )}
        <span class="field-hint">
          What a web tile's permission bar was told to remember: a site allowed
          or denied the camera, the microphone, the location and the like. A
          forgotten one is asked about again.
        </span>
      </div>
      <button
        type="button"
        class="btn-quiet is-danger"
        data-testid="site-permissions-clear"
        disabled={!entries.length}
        onClick={() => sitePermissionsStore.set(clearSitePermissions())}
      >
        Clear all
      </button>
    </div>
  );
}
