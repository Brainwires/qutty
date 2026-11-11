// An HTML menu, dialog or popover that may overlap a web tile registers itself while it is open
// (lib/web/overlays.ts): a native web view, which draws above all HTML, hides meanwhile. Used by
// the link menu, the modal dialogs (app/modal.tsx), Settings and the bar's menus.

import { useEffect } from "denext";
import { openOverlay } from "../lib/web/overlays.ts";

/** Count this component as an open overlay while `active`. */
export function useHtmlOverlay(active = true): void {
  useEffect(() => (active ? openOverlay() : undefined), [active]);
}
