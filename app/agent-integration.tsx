// Settings → Agent integration: connect agents the user starts by hand in a shell (an agent
// launched from the `+` picker is connected already) by registering Qutty's MCP server and hooks
// in the agent's user-scope config. One row per agent: installed or not, any note (a partial
// install, an entry named `qutty` that Qutty did not write), exactly what Install writes (each
// file and the text it adds), and Install / Uninstall. Errors from the installer (an unreadable
// file, a foreign entry) are shown as they come. When the installed Codex does not trust Qutty's
// hooks (it skips them; asked once per start, lib/hub/codex-trust.ts), the Codex row shows why,
// with Re-trust (Install again: it rewrites the trust entries, and Codex is asked again).
//
// The backend does the work (desktop/hub.ts over lib/hub/integration.ts; the demo runs the same
// installer over an in-memory home, lib/hub-demo.ts). The status is read when the panel mounts.

import { useEffect, useState } from "denext";
import type {
  IntegrationStatus,
  IntegrationTarget,
} from "../lib/hub/protocol.ts";
import type { PtyBackend } from "../lib/pty-client.ts";

export interface AgentIntegrationProps {
  backend: PtyBackend;
}

const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);

export function AgentIntegration(props: AgentIntegrationProps) {
  const { backend } = props;
  const [rows, setRows] = useState<IntegrationStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<IntegrationTarget | null>(null);

  useEffect(() => {
    let live = true;
    backend.integrationStatus().then(
      (status) => live && setRows(status),
      (e) => live && setError(messageOf(e)),
    );
    return () => {
      live = false;
    };
  }, [backend]);

  const change = async (target: IntegrationTarget, install: boolean) => {
    setBusy(target);
    setError(null);
    try {
      setRows(
        await (install
          ? backend.integrationInstall(target)
          : backend.integrationUninstall(target)),
      );
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="integration" data-testid="integration-panel">
      <p class="field-hint">
        Agents launched from the + picker are connected automatically; this is
        only for agents you start by hand in a shell. Uninstall removes exactly
        these entries (backups are kept as{" "}
        <code>&lt;file&gt;.qutty-backup</code>).
      </p>
      {error && (
        <p class="form-error" role="alert" data-testid="integration-error">
          {error}
        </p>
      )}
      {rows === null && !error && <p class="field-hint">Reading…</p>}
      {rows?.map((row) => (
        <div
          key={row.target}
          class="integration-row"
          data-testid="integration-row"
          data-target={row.target}
          data-installed={row.installed ? "true" : "false"}
          data-trust={row.trust ?? ""}
        >
          <div class="integration-head">
            <span class="integration-label">{row.label}</span>
            <span
              class={`integration-state${row.installed ? " is-installed" : ""}`}
              data-testid="integration-state"
            >
              {row.installed ? "Installed" : "Not installed"}
            </span>
            {row.installed
              ? (
                <button
                  type="button"
                  class="btn-quiet is-danger"
                  data-testid="integration-uninstall"
                  disabled={busy !== null}
                  onClick={() => void change(row.target, false)}
                >
                  Uninstall
                </button>
              )
              : (
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="integration-install"
                  disabled={busy !== null}
                  onClick={() => void change(row.target, true)}
                >
                  Install
                </button>
              )}
          </div>
          {row.note && (
            <p
              class="field-hint integration-note"
              data-testid="integration-note"
            >
              {row.note}
            </p>
          )}
          {row.warning && (
            <div
              class="integration-warning"
              role="alert"
              data-testid="integration-warning"
            >
              <p>{row.warning}</p>
              {row.installed && (
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="integration-retrust"
                  disabled={busy !== null}
                  onClick={() => void change(row.target, true)}
                >
                  Re-trust
                </button>
              )}
            </div>
          )}
          <span class="field-hint">
            {row.installed ? "Installed entries:" : "Install adds:"}
          </span>
          {row.changes.map((c) => (
            <div
              key={c.path}
              class="integration-change"
              data-testid="integration-change"
            >
              <span class="integration-path">{c.path}</span>
              <pre>{c.adds}</pre>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
