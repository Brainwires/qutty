// Shared helpers for the font and tile zoom e2e suites (not a test module itself): a terminal's
// grid once its debounced fit landed, and the PTY agreeing with it.

import { type App, type TerminalState, waitFor } from "./harness.ts";

/** Run the demo `size` command until the PTY agrees with xterm; returns xterm's state. */
export async function ptyAgrees(app: App, id: string): Promise<TerminalState> {
  let s = (await app.terminal(id))!;
  await waitFor(
    async () => {
      const out = await app.run(id, "size");
      s = (await app.terminal(id))!;
      const line = out.split("\n").filter((l) => /^\d+ \d+\s*$/.test(l)).at(
        -1,
      ) ?? "";
      const m = /^(\d+) (\d+)/.exec(line);
      return !!m && Number(m[1]) === s.rows && Number(m[2]) === s.cols;
    },
    5000,
    `PTY size = xterm size in ${id}`,
  );
  return s;
}

/** Settle the tiles and let the debounced fit land (the grid stops changing). */
export async function settledGrid(
  app: App,
  id: string,
): Promise<TerminalState> {
  await app.settle();
  let prev = "";
  return await waitFor(
    async () => {
      const s = (await app.terminal(id))!;
      const key = `${s.cols}x${s.rows}`;
      const same = key === prev;
      prev = key;
      if (!same) await new Promise((r) => setTimeout(r, 150));
      return same ? s : null;
    },
    5000,
    `${id} grid to settle`,
  );
}
