// Asks the installed Codex whether it trusts Qutty's hooks (lib/hub/codex-trust.ts has the
// request, the parsing and the verdict): `codex app-server`, the request lines on its stdin (held
// open, the server exits at EOF before it answers), `hooks/list` read back from its output. No
// model, no network, no login: a read of the config. It runs in a hidden PTY (the packaged app
// has no `--allow-run`: the pattern of desktop/shell-agent.ts), with CODEX_HOME and HOME set to
// the folders the integration edits, and is killed as soon as the answer is in (or after a few
// seconds).

import { PtyHost } from "./pty.ts";
import type { PtyDataEvent } from "./pty.ts";
import {
  codexHooksListRequest,
  type ListedCodexHook,
  parseHooksListAnswer,
} from "../lib/hub/codex-trust.ts";

/** How long Codex may take to answer. */
const LIST_TIMEOUT_MS = 10_000;

/** The hidden PTY's argv: the request on a held-open stdin, Codex's stderr dropped. */
export function codexHooksListArgv(
  codex: string,
  codexHome: string,
  home: string,
): { program: string; args: string[] } {
  return {
    program: "/bin/bash",
    args: [
      "-c",
      'unset QUTTY_SOCK QUTTY_TILE_ID QUTTY_HUB QUTTY_TILE_TOKEN; { printf "%s" "$1"; sleep 30; } | CODEX_HOME="$2" HOME="$3" "$0" app-server 2>/dev/null',
      codex,
      codexHooksListRequest(home),
      codexHome,
      home,
    ],
  };
}

/** `hooks/list` from the Codex at `codex` (`undefined`: no answer in time, or it failed). */
export async function listCodexHooks(
  opts: {
    codex: string;
    /** `~/.codex` (the folder holding config.toml). */
    codexHome: string;
    home: string;
    appSupportDir?: string;
    timeoutMs?: number;
  },
): Promise<ListedCodexHook[] | undefined> {
  let output = "";
  let settle: (hooks: ListedCodexHook[] | undefined) => void = () => {};
  const answered = new Promise<ListedCodexHook[] | undefined>((r) =>
    settle = r
  );
  const host = new PtyHost((event, data) => {
    if (event === "data") {
      output += (data as PtyDataEvent).data;
      const hooks = parseHooksListAnswer(output);
      if (hooks) settle(hooks);
    } else {
      settle(parseHooksListAnswer(output));
    }
  });
  const { program, args } = codexHooksListArgv(
    opts.codex,
    opts.codexHome,
    opts.home,
  );
  const { id } = await host.spawn(
    { cols: 400, rows: 50, program, args, cwd: opts.home },
    { appSupportDir: opts.appSupportDir, owner: "codex-trust" },
  );
  const timer = setTimeout(
    () => settle(undefined),
    opts.timeoutMs ?? LIST_TIMEOUT_MS,
  );
  try {
    return await answered;
  } finally {
    clearTimeout(timer);
    host.kill(id);
  }
}
