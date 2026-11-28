// The menus self-test's read-back (desktop/menus-selftest.ts): a menu Denext 4.22's
// `getApplicationMenu` / `getDockMenu` reads back from the OS, in the shape the self-test checks
// and logs, and ⌘T in both spellings.
//
// Run: deno task test

import { assertEquals } from "@std/assert";
import type { MenuSnapshotItem } from "denext/desktop";
import {
  isNewTileKey,
  renderMenu,
  snapshotEntries,
  submenu,
} from "../desktop/menus-selftest.ts";

const item = (over: Partial<MenuSnapshotItem>): MenuSnapshotItem => ({
  type: "item",
  label: "",
  enabled: true,
  checked: false,
  visible: true,
  ...over,
});

Deno.test("menus self-test: a read-back menu in the checked shape", () => {
  const snapshot: MenuSnapshotItem[] = [
    item({
      type: "submenu",
      label: "Shell",
      submenu: [
        item({
          id: "denext:menu:qutty:new-tile",
          label: "New Tile",
          accelerator: "Super+T",
        }),
        item({ type: "separator" }),
        item({ label: "Hidden", id: "x", visible: false }),
        item({ label: "Close Window", role: "close" }),
        item({ id: "denext:menu:r", label: "Restore", enabled: false }),
      ],
    }),
  ];
  const entries = snapshotEntries(snapshot);
  assertEquals(renderMenu(entries), [
    "Shell >",
    "  New Tile  Super+T  {qutty:new-tile}",
    "  ----",
    "  <close>",
    "  Restore  (disabled)  {r}",
  ]);
});

Deno.test("menus self-test: New Tile With's submenus are found at any level", () => {
  const entries = snapshotEntries([
    item({
      type: "submenu",
      label: "Shell",
      submenu: [
        item({
          type: "submenu",
          label: "New Tile With",
          submenu: [
            item({
              type: "submenu",
              label: "Shell",
              submenu: [
                item({
                  id: "denext:menu:qutty:launch:shell:/bin/zsh",
                  label: "zsh (default)",
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  ]);
  const newTileWith = submenu(entries, "New Tile With")!;
  assertEquals(renderMenu(submenu(newTileWith, "Shell")!), [
    "zsh (default)  {qutty:launch:shell:/bin/zsh}",
  ]);
  assertEquals(submenu(newTileWith, "SSH"), undefined);
});

Deno.test("menus self-test: ⌘T as Denext is given it and as the OS reads it back", () => {
  assertEquals(isNewTileKey("CmdOrCtrl+T"), true);
  assertEquals(isNewTileKey("Super+T"), true);
  assertEquals(isNewTileKey("Ctrl+T"), true);
  assertEquals(isNewTileKey("Super+Shift+T"), false);
  assertEquals(isNewTileKey(undefined), false);
});
