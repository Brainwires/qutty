// The site permissions web tiles remember (lib/web/site-permissions.ts): what a request is
// answered with, remembering and forgetting, the stored value checked, the list Settings shows,
// the words the permission bar uses, and the synced store's own key.

import { assertEquals } from "@std/assert";
import {
  clearSitePermissions,
  decideRequest,
  forgetPermission,
  NO_SITE_PERMISSIONS,
  originKey,
  permissionEntries,
  permissionName,
  permissionsLabel,
  rememberChoice,
  sanitizeSitePermissions,
  SITE_PERMISSIONS_STORAGE_KEY,
  sitePermission,
} from "../lib/web/site-permissions.ts";
import { syncedStore } from "../lib/web/synced.ts";

const SITE = "https://meet.example.com";

Deno.test("permissions: nothing remembered asks; allowed only when every kind is", () => {
  const p0 = NO_SITE_PERMISSIONS;
  assertEquals(decideRequest(p0, SITE, ["camera"]), "ask");
  const p1 = rememberChoice(p0, SITE, ["camera"], "allow");
  assertEquals(decideRequest(p1, SITE, ["camera"]), "allow");
  assertEquals(
    decideRequest(p1, SITE, ["camera", "microphone"]),
    "ask",
    "the microphone was never said",
  );
  const p2 = rememberChoice(p1, SITE, ["microphone"], "deny");
  assertEquals(decideRequest(p2, SITE, ["camera", "microphone"]), "deny");
  assertEquals(
    decideRequest(p2, "https://other.example", ["camera"]),
    "ask",
    "per origin",
  );
  assertEquals(
    decideRequest(p2, "http://meet.example.com", ["camera"]),
    "ask",
    "the scheme counts",
  );
  assertEquals(decideRequest(p2, SITE, []), "ask");
  assertEquals(decideRequest(p2, "file:///x", ["camera"]), "ask");
});

Deno.test("permissions: remembering several kinds, and the same answer again changes nothing", () => {
  const p = rememberChoice(NO_SITE_PERMISSIONS, SITE.toUpperCase(), [
    "camera",
    "microphone",
  ], "allow");
  assertEquals(p.sites, { [SITE]: { camera: "allow", microphone: "allow" } });
  assertEquals(rememberChoice(p, SITE, ["camera"], "allow"), p);
  assertEquals(sitePermission(p, SITE, "camera"), "allow");
  assertEquals(sitePermission(p, SITE, "constructor"), undefined);
  assertEquals(rememberChoice(p, "not a url", ["camera"], "allow"), p);
  assertEquals(rememberChoice(p, SITE, ["Bad Kind!"], "allow"), p);
  assertEquals(
    rememberChoice(p, SITE, ["camera"], "deny").sites[SITE].camera,
    "deny",
    "a new answer replaces the old",
  );
});

Deno.test("permissions: forget one kind, a whole site, or everything", () => {
  let p = rememberChoice(
    NO_SITE_PERMISSIONS,
    SITE,
    ["camera", "geolocation"],
    "allow",
  );
  p = rememberChoice(p, "https://b.example", ["notifications"], "deny");
  p = forgetPermission(p, SITE, "camera");
  assertEquals(p.sites[SITE], { geolocation: "allow" });
  assertEquals(forgetPermission(p, SITE, "camera"), p, "already forgotten");
  p = forgetPermission(p, SITE, "geolocation");
  assertEquals(SITE in p.sites, false, "a site with nothing left goes");
  p = forgetPermission(p, "https://b.example");
  assertEquals(p.sites, {});
  assertEquals(clearSitePermissions(), NO_SITE_PERMISSIONS);
});

Deno.test("permissions: the stored value is checked", () => {
  assertEquals(sanitizeSitePermissions(undefined), NO_SITE_PERMISSIONS);
  assertEquals(sanitizeSitePermissions({ sites: [] }), NO_SITE_PERMISSIONS);
  assertEquals(
    sanitizeSitePermissions({
      sites: {
        [SITE]: { camera: "allow", microphone: "maybe", "Bad Kind": "allow" },
        "https://Upper.example": { camera: "allow" },
        "javascript:alert(1)": { camera: "allow" },
        "https://empty.example": {},
        "https://n.example": { notifications: "deny" },
        "https://x.example": "allow",
      },
    }),
    {
      sites: {
        [SITE]: { camera: "allow" },
        "https://n.example": { notifications: "deny" },
      },
    },
  );
});

Deno.test("permissions: the list Settings shows, and the words", () => {
  let p = rememberChoice(
    NO_SITE_PERMISSIONS,
    "https://b.example",
    ["microphone", "camera"],
    "deny",
  );
  p = rememberChoice(p, "https://a.example", ["geolocation"], "allow");
  assertEquals(permissionEntries(p), [
    { origin: "https://a.example", kind: "geolocation", choice: "allow" },
    { origin: "https://b.example", kind: "camera", choice: "deny" },
    { origin: "https://b.example", kind: "microphone", choice: "deny" },
  ]);
  assertEquals(permissionsLabel(["camera"]), "use your camera");
  assertEquals(
    permissionsLabel(["camera", "microphone", "geolocation"]),
    "use your camera, use your microphone and know your location",
  );
  assertEquals(permissionsLabel(["some-new-thing"]), 'use "some new thing"');
  assertEquals(permissionName("geolocation"), "Location");
  assertEquals(permissionName("clipboard-read"), "Clipboard read");
  assertEquals(
    originKey("https://Example.com:443/path"),
    "https://example.com",
  );
});

Deno.test("permissions: the synced store keeps them on their own key", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
  const env = { storage, events: null };
  const store = syncedStore(
    SITE_PERMISSIONS_STORAGE_KEY,
    sanitizeSitePermissions,
    env,
  );
  store.set(rememberChoice(store.get(), SITE, ["camera"], "allow"));
  const again = syncedStore(
    SITE_PERMISSIONS_STORAGE_KEY,
    sanitizeSitePermissions,
    env,
  );
  assertEquals(decideRequest(again.get(), SITE, ["camera"]), "allow");
  assertEquals(SITE_PERMISSIONS_STORAGE_KEY, "qutty.web-permissions.v1");
});
