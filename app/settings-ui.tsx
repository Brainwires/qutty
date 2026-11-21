// The Settings dialog's building blocks, shared by app/settings-panel.tsx and the section
// components it renders:
//
// - `SettingsGroup`: a small heading over a few rows (label left, control right, hint under
//   it: the `.field` rows of public/styles.css). The dialog's search hides groups and rows that
//   do not match.
// - `SettingsLink`: a cross-reference to another tab ("Settings → Agents"), a button that
//   switches to it (and scrolls to `target`, a `data-testid`) inside the dialog, plain text
//   anywhere else.

import { createContext, type ReactNode, useContext } from "denext";
import type { SettingsTab } from "../lib/workspace/store.ts";

/** What a settings link does: show `tab`, and the row holding `target` (a `data-testid`). */
type SettingsNavigate = (tab: SettingsTab, target?: string) => void;

export const SettingsNav = createContext<SettingsNavigate | null>(null);

export function SettingsGroup(props: {
  title: string;
  /** `data-testid` of the group (the old section's, where it had one). */
  testid?: string;
  children: ReactNode;
}) {
  return (
    <section
      class="settings-group"
      data-part="settings-group"
      data-testid={props.testid}
      aria-label={props.title}
    >
      <h4 class="settings-group-title">{props.title}</h4>
      <div class="settings-group-body">{props.children}</div>
    </section>
  );
}

export function SettingsLink(props: {
  tab: SettingsTab;
  target?: string;
  children: ReactNode;
}) {
  const go = useContext(SettingsNav);
  if (!go) return <>{props.children}</>;
  return (
    <button
      type="button"
      class="settings-link"
      data-testid="settings-link"
      data-tab={props.tab}
      onClick={() => go(props.tab, props.target)}
    >
      {props.children}
    </button>
  );
}
