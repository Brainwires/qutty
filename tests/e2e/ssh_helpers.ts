// SSH helpers for the e2e suites: the connection manager, SSH tiles of the demo backend (its
// hosts are in lib/ssh-demo.ts) and simulated file drops.

import { type App, waitFor } from "./harness.ts";

export const DIALOG = "[data-testid=connections-dialog]";
export const FILTER = "[data-testid=conn-filter]";

export const tileSel = (id: string) => `[data-testid=tile][data-id="${id}"]`;

/** Open the connection manager with the bar button and wait for the filter to have focus. */
export async function openConnections(
  app: App,
  via: "button" | "shortcut" = "button",
): Promise<void> {
  if (via === "button") await app.click("[data-testid=bar-connections]");
  else await app.shortcut("KeyO", { shift: true });
  await waitFor(() => app.exists(DIALOG), 2000, "the connections dialog");
  await waitFor(
    () =>
      app.eval(
        (s: string) => document.activeElement?.matches(s) ?? false,
        FILTER,
      ),
    2000,
    "the filter field to have focus",
  );
}

/** Type into the (focused) filter field. */
export async function filter(app: App, text: string): Promise<void> {
  await app.eval((s: string) => {
    const el = document.querySelector<HTMLInputElement>(s)!;
    el.focus();
    el.select();
  }, FILTER);
  if (text) await app.page.keyboard.type(text);
  else await app.press("Backspace");
}

/** The list's row keys, top to bottom. */
export function rowKeys(app: App): Promise<string[]> {
  return app.eval(() =>
    [...document.querySelectorAll<HTMLElement>("[data-testid=conn-row]")].map(
      (el) => el.dataset.key!,
    )
  );
}

export function selectedKey(app: App): Promise<string | null> {
  return app.attr("[data-testid=conn-row].is-selected", "data-key");
}

/** Wait for a new focused terminal and return its id. */
async function newFocused(app: App, before: Set<string>): Promise<string> {
  return await waitFor(
    async () => {
      const f = await app.focusedId();
      return f && !before.has(f) ? f : null;
    },
    5000,
    "a new focused terminal",
  );
}

/** Wait until an SSH tile shows the demo's remote prompt. */
export async function waitForRemotePrompt(app: App, id: string): Promise<void> {
  await app.waitForText(id, /\S+@\S+:\S*\$/);
}

/**
 * Connect through the dialog: filter for `query`, press Enter (the first row, or the quick
 * connect offer) and return the new SSH tile's id once its remote prompt is up.
 */
export async function connectVia(app: App, query: string): Promise<string> {
  const before = new Set((await app.chips()).map((c) => c.id));
  if (!(await app.exists(DIALOG))) await openConnections(app);
  await filter(app, query);
  await waitFor(
    async () =>
      (await selectedKey(app)) !== null ||
      (await app.exists("[data-testid=conn-quick]")),
    2000,
    `a row for ${query}`,
  );
  await app.press("Enter");
  const id = await newFocused(app, before);
  await waitFor(async () => !(await app.exists(DIALOG)), 2000, "dialog closed");
  await waitForRemotePrompt(app, id);
  return id;
}

/** Drop files named `names` on tile `id` (the DOM drag events the demo backend handles). */
export async function dropFiles(
  app: App,
  id: string,
  names: string[],
): Promise<void> {
  await app.eval(
    (sel: string, files: string[]) => {
      const el = document.querySelector(`${sel} [data-testid=tile-body]`)!;
      const dt = new DataTransfer();
      for (const n of files) dt.items.add(new File(["x"], n));
      for (const type of ["dragenter", "dragover", "drop"]) {
        el.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          }),
        );
      }
    },
    tileSel(id),
    names,
  );
  await waitFor(
    () => app.exists(`${tileSel(id)} [data-testid=upload-confirm]`),
    2000,
    "the upload confirmation",
  );
}

/** The text of the first element matching `selector` (`""` when there is none). */
export function textOf(app: App, selector: string): Promise<string> {
  return app.eval(
    (s: string) => document.querySelector(s)?.textContent?.trim() ?? "",
    selector,
  );
}
