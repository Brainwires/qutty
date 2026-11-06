// The Ollama dialog (the `+` menu's "Ollama models…"): launch a terminal harness on a local
// model, pull a model, or browse the ollama.com library.
//
// - Local models: two lists, models (size, capabilities, loaded now) and harnesses (the
//   installed ones, plus the ones the model's library page lists under Applications, greyed
//   while not installed). ↑/↓ move within a list, Tab moves between them, Enter launches.
//   A model without tool calling is marked, and launching an agent harness on it asks first.
// - Pull a model…: a name, then a tile running `ollama pull <name>`; the list picks the model up
//   when the pull ends (the tracking reads Ollama every few seconds while this is open).
// - Library: search ollama.com (popular or newest, tools only), each model's capabilities,
//   sizes, downloads and last update ("new" since the last look), with Pull and Pull & launch
//   (a tile that pulls, then runs `ollama launch` with the chosen harness).
//
// The facts come from app/use-ollama.ts and the backend's library methods; the rules from
// lib/ollama/.

import { useEffect, useMemo, useRef, useState } from "denext";
import type { PtyBackend } from "../lib/pty-client.ts";
import {
  isModelName,
  type OllamaModel,
  type OllamaStatus,
  withTag,
} from "../lib/ollama/cli.ts";
import {
  type HarnessChoice,
  harnessChoices,
  harnessLabel,
} from "../lib/ollama/harnesses.ts";
import type {
  LibraryModel,
  LibraryOrder,
  LibraryPageResult,
  LibraryResult,
} from "../lib/ollama/library.ts";
import type { OllamaPair, OllamaSettings } from "../lib/ollama/settings.ts";
import { Modal } from "./modal.tsx";

export interface OllamaDialogProps {
  backend: PtyBackend;
  status: OllamaStatus;
  settings: OllamaSettings;
  /** Library models updated since the last look. */
  newCount: number;
  /** Start `pair` in a new tile (pulling the model first when `pullFirst`). */
  onLaunch(pair: OllamaPair, pullFirst: boolean): void;
  /** A tile running `ollama pull <model>`. */
  onPull(model: string): void;
  /** The library was looked at (its "new" badge resets). */
  onLooked(): void;
  onClose(): void;
}

/** A model's library page name: `qwen3.8:27b-mlx` → `qwen3.8`. */
const baseOf = (model: string) => model.replace(/:.*$/, "");

/** ↑/↓ (and Home/End) within the buttons of one list; returns whether it moved. */
function moveInList(
  e: { key: string; preventDefault(): void; currentTarget: EventTarget },
): boolean {
  const el = e.currentTarget as HTMLElement;
  const list = el.closest("[role=listbox]");
  if (!list) return false;
  const items = [...list.querySelectorAll<HTMLElement>("[role=option]")];
  const at = items.indexOf(el);
  const next = e.key === "ArrowDown"
    ? Math.min(items.length - 1, at + 1)
    : e.key === "ArrowUp"
    ? Math.max(0, at - 1)
    : e.key === "Home"
    ? 0
    : e.key === "End"
    ? items.length - 1
    : -1;
  if (next < 0) return false;
  e.preventDefault();
  items[next]?.focus();
  items[next]?.click();
  return true;
}

function Caps(props: { caps: readonly string[] }) {
  return (
    <span class="ollama-caps">
      {props.caps.filter((c) => c !== "completion").map((c) => (
        <span class={`ollama-cap cap-${c}`} key={c}>{c}</span>
      ))}
    </span>
  );
}

/** The model pages read so far (by library name), shared by both tabs. */
function usePages(backend: PtyBackend) {
  const [pages, setPages] = useState<Record<string, LibraryPageResult>>({});
  const asked = useRef(new Set<string>());
  const want = (name: string) => {
    const base = baseOf(name);
    if (asked.current.has(base)) return;
    asked.current.add(base);
    void backend.ollamaLibraryModel(base).then(
      (r) => setPages((p) => ({ ...p, [base]: r })),
      () => {},
    );
  };
  return { pages, want };
}

export function OllamaDialog(props: OllamaDialogProps) {
  const { status, settings, backend } = props;
  const [tab, setTab] = useState<"local" | "library">("local");
  const installed = useMemo(
    () =>
      new Set(status.harnesses.filter((h) => h.installed).map((h) => h.name)),
    [status.harnesses],
  );
  const models = status.models;
  const [model, setModel] = useState<string | null>(
    settings.model && models.some((m) => m.name === settings.model)
      ? settings.model
      : models[0]?.name ?? null,
  );
  // The list arrives (or changes) after opening: keep a valid selection.
  useEffect(() => {
    if (model && models.some((m) => m.name === model)) return;
    setModel(models[0]?.name ?? null);
  }, [models.map((m) => m.name).join("\n")]);
  const firstInstalled = status.harnesses.find((h) => h.installed)?.name ??
    null;
  const [harness, setHarness] = useState<string | null>(
    settings.harness && installed.has(settings.harness)
      ? settings.harness
      : firstInstalled,
  );
  useEffect(() => {
    if (!harness || !installed.has(harness)) setHarness(firstInstalled);
  }, [firstInstalled]);
  const { pages, want } = usePages(backend);
  useEffect(() => {
    if (model) want(model);
  }, [model]);
  const selected = models.find((m) => m.name === model);
  const apps = model ? pages[baseOf(model)]?.page?.applications : undefined;
  const choices = harnessChoices(installed, apps);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setConfirm(false), [model, harness]);
  const [pullName, setPullName] = useState("");

  const canLaunch = !!selected && !!harness && installed.has(harness) &&
    status.serverUp;
  const noTools = selected?.details !== undefined &&
    !selected.details.capabilities.includes("tools");
  const launch = () => {
    if (!canLaunch || !selected || !harness) return;
    if (noTools && !confirm) {
      setConfirm(true);
      return;
    }
    props.onLaunch({ harness, model: selected.name }, false);
  };
  const pull = () => {
    const name = pullName.trim();
    if (!isModelName(name)) return;
    props.onPull(name);
    setPullName("");
  };

  const running = new Set(status.running.map((r) => r.name));
  const modelRow = (m: OllamaModel) => (
    <button
      type="button"
      role="option"
      aria-selected={m.name === model}
      class={`ollama-row${m.name === model ? " is-selected" : ""}`}
      data-testid="ollama-model"
      data-name={m.name}
      key={m.name}
      tabIndex={m.name === model ? 0 : -1}
      onClick={() => setModel(m.name)}
      onKeyDown={(e) => {
        if (moveInList(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          launch();
        }
      }}
    >
      <span class="ollama-name">{m.name}</span>
      <span class="ollama-meta">
        {m.size}
        {m.details?.parameters ? ` · ${m.details.parameters}` : ""}
        {m.details?.quantization ? ` · ${m.details.quantization}` : ""}
        {` · ${m.modified}`}
      </span>
      {m.details && <Caps caps={m.details.capabilities} />}
      {m.details && !m.details.capabilities.includes("tools") && (
        <span class="ollama-warn" data-testid="ollama-no-tools">
          no tools
        </span>
      )}
      {running.has(m.name) && <span class="ollama-loaded">loaded</span>}
    </button>
  );
  const harnessRow = (h: HarnessChoice) => (
    <button
      type="button"
      role="option"
      aria-selected={h.name === harness}
      aria-disabled={!h.installed}
      class={`ollama-row${h.name === harness ? " is-selected" : ""}${
        h.installed ? "" : " is-missing"
      }`}
      data-testid="ollama-harness"
      data-name={h.name}
      data-installed={String(h.installed)}
      key={h.name}
      tabIndex={h.name === harness ? 0 : -1}
      title={h.installed
        ? `ollama launch ${h.name}`
        : `${h.label} is not installed: install it first (ollama launch offers to)`}
      onClick={() => h.installed && setHarness(h.name)}
      onKeyDown={(e) => {
        if (moveInList(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          launch();
        }
      }}
    >
      <span class="ollama-name">{h.label}</span>
      <span class="ollama-meta">{h.name}</span>
      {h.listed && <span class="ollama-listed">listed for this model</span>}
      {!h.installed && <span class="ollama-meta">not installed</span>}
    </button>
  );

  const first = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    first.current?.querySelector<HTMLElement>("[aria-selected=true]")?.focus();
  }, [tab]);

  return (
    <Modal
      label="Ollama"
      testid="ollama-dialog"
      class="ollama"
      onClose={props.onClose}
    >
      <div class="modal-head">
        <h2>Ollama</h2>
        <div class="segmented" role="tablist" aria-label="Ollama">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "local"}
            class={tab === "local" ? "is-active" : ""}
            data-testid="ollama-tab-local"
            onClick={() => setTab("local")}
          >
            Local models
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "library"}
            class={tab === "library" ? "is-active" : ""}
            data-testid="ollama-tab-library"
            onClick={() => {
              setTab("library");
              props.onLooked();
            }}
          >
            Library{props.newCount > 0 ? ` · ${props.newCount} new` : ""}
          </button>
        </div>
        <button
          type="button"
          class="btn-quiet"
          data-testid="ollama-close"
          onClick={props.onClose}
        >
          Close
        </button>
      </div>
      <OllamaStatusLine status={status} backend={backend} />
      {tab === "local"
        ? (
          <div class="ollama-body" ref={first}>
            <div class="ollama-cols">
              <div
                class="ollama-list"
                role="listbox"
                aria-label="Models"
                data-testid="ollama-models"
              >
                <div class="launch-heading">Model</div>
                {models.length === 0 && (
                  <div class="field-hint">
                    {status.serverUp
                      ? "No models pulled yet: pull one below, or from the Library."
                      : "No models (the server is not running)."}
                  </div>
                )}
                {models.map(modelRow)}
              </div>
              <div
                class="ollama-list"
                role="listbox"
                aria-label="Harness"
                data-testid="ollama-harnesses"
              >
                <div class="launch-heading">Harness</div>
                {choices.map(harnessRow)}
              </div>
            </div>
            <div class="modal-foot">
              <form
                class="ollama-pull"
                onSubmit={(e) => {
                  e.preventDefault();
                  pull();
                }}
              >
                <input
                  class="field-select field-text"
                  data-testid="ollama-pull-name"
                  placeholder="Pull a model… (mimo-v2.6, qwen3.8:4b)"
                  spellcheck={false}
                  value={pullName}
                  onInput={(e) =>
                    setPullName((e.target as HTMLInputElement).value)}
                />
                <button
                  type="submit"
                  class="btn-quiet"
                  data-testid="ollama-pull"
                  disabled={!isModelName(pullName.trim()) || !status.serverUp}
                >
                  Pull
                </button>
              </form>
              <span class="modal-foot-end">
                {confirm && (
                  <span class="ollama-warn" data-testid="ollama-confirm">
                    {selected?.name} has no tool calling, which{" "}
                    {harness ? harnessLabel(harness) : "the harness"}{" "}
                    needs. Launch anyway?
                  </span>
                )}
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="ollama-launch"
                  disabled={!canLaunch}
                  onClick={launch}
                >
                  {confirm ? "Launch anyway" : "Launch"}
                </button>
              </span>
            </div>
          </div>
        )
        : (
          <LibraryTab
            backend={backend}
            status={status}
            harness={harness && installed.has(harness) ? harness : null}
            installed={installed}
            lookedAt={settings.libraryLookedAt}
            pages={pages}
            want={want}
            onLaunch={props.onLaunch}
            onPull={props.onPull}
          />
        )}
    </Modal>
  );
}

/** Installed? version, server; Open Ollama when the app is there but its server is not up. */
export function OllamaStatusLine(
  props: { status: OllamaStatus; backend: PtyBackend },
) {
  const s = props.status;
  const [opening, setOpening] = useState(false);
  if (s.installed && s.serverUp) return null;
  return (
    <div class="ollama-status" data-testid="ollama-status">
      {!s.installed
        ? "Ollama is not installed (https://ollama.com/download)."
        : `The Ollama server is not running${
          s.error ? ` (${s.error})` : ""
        }. Start the Ollama app, or run ollama serve.`}
      {s.installed && s.app && (
        <button
          type="button"
          class="btn-quiet"
          data-testid="ollama-open-app"
          disabled={opening}
          onClick={() => {
            setOpening(true);
            void props.backend.ollamaOpenApp().finally(() => setOpening(false));
          }}
        >
          Open Ollama
        </button>
      )}
    </div>
  );
}

interface LibraryTabProps {
  backend: PtyBackend;
  status: OllamaStatus;
  /** The harness picked on the Local tab (installed), for Pull & launch. */
  harness: string | null;
  installed: ReadonlySet<string>;
  lookedAt: number | null;
  pages: Record<string, LibraryPageResult>;
  want(name: string): void;
  onLaunch(pair: OllamaPair, pullFirst: boolean): void;
  onPull(model: string): void;
}

function LibraryTab(props: LibraryTabProps) {
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<LibraryOrder>("popular");
  const [toolsOnly, setToolsOnly] = useState(true);
  const [result, setResult] = useState<LibraryResult | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // The look that the "new" marks compare against: the one before this visit.
  const [since] = useState(props.lookedAt);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void props.backend.ollamaLibrary(query, { order, toolsOnly }).then(
        (r) => live && setResult(r),
        (e) =>
          live &&
          setResult({ models: [], fetchedAt: 0, error: String(e) }),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, order, toolsOnly]);
  const pulled = new Set(props.status.models.map((m) => m.name));

  const row = (m: LibraryModel) => {
    const page = props.pages[m.name]?.page;
    const tag = withTag(m.name);
    const here = pulled.has(tag);
    const isNew = since !== null && (m.updatedAt ?? 0) > since;
    const listed = page ? page.applications : undefined;
    // Pull & launch needs a harness that is installed and (when the page says) listed.
    const harness = props.harness &&
        (!listed || listed.length === 0 || listed.includes(props.harness))
      ? props.harness
      : listed?.find((h) => props.installed.has(h)) ?? props.harness;
    return (
      <div
        class={`ollama-lib${open === m.name ? " is-open" : ""}`}
        data-testid="ollama-lib-model"
        data-name={m.name}
        key={m.name}
      >
        <button
          type="button"
          class="ollama-lib-head"
          aria-expanded={open === m.name}
          onClick={() => {
            setOpen(open === m.name ? null : m.name);
            props.want(m.name);
          }}
        >
          <span class="ollama-name">{m.name}</span>
          {isNew && (
            <span class="launch-badge is-new" data-testid="ollama-lib-new">
              new
            </span>
          )}
          {m.cloud && <span class="ollama-cap cap-cloud">cloud</span>}
          <Caps caps={m.capabilities} />
          <span class="ollama-meta">
            {m.sizes.join(" · ")}
            {m.downloads !== undefined
              ? ` · ${m.downloads.toLocaleString()} downloads`
              : ""}
            {m.updated ? ` · updated ${m.updated}` : ""}
          </span>
        </button>
        <div class="ollama-desc">{m.description}</div>
        {open === m.name && (
          <div class="ollama-lib-detail" data-testid="ollama-lib-detail">
            {page
              ? (
                <>
                  <div class="field-hint" data-testid="ollama-lib-apps">
                    {page.applications.length > 0
                      ? `Listed for: ${
                        page.applications.map(harnessLabel).join(", ")
                      }`
                      : "Not listed for any harness."}
                  </div>
                  {page.variants.length > 0 && (
                    <div class="ollama-variants">
                      {page.variants.map((v) => (
                        <button
                          type="button"
                          class="btn-quiet"
                          data-testid="ollama-lib-variant"
                          key={v.tag}
                          disabled={!props.status.serverUp ||
                            pulled.has(v.tag)}
                          title={`ollama pull ${v.tag}`}
                          onClick={() => props.onPull(v.tag)}
                        >
                          {v.tag} · {v.size}
                          {pulled.has(v.tag) ? " · pulled" : ""}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )
              : <div class="field-hint">Reading the model's page…</div>}
          </div>
        )}
        <div class="ollama-lib-actions">
          {!m.cloud && (
            <button
              type="button"
              class="btn-quiet"
              data-testid="ollama-lib-pull"
              disabled={here || !props.status.serverUp}
              onClick={() => props.onPull(m.name)}
            >
              {here ? "Pulled" : "Pull"}
            </button>
          )}
          <button
            type="button"
            class="btn-quiet"
            data-testid="ollama-lib-launch"
            disabled={!harness || !props.status.serverUp}
            title={harness
              ? `${
                here ? "" : `ollama pull ${m.name}, then `
              }ollama launch ${harness} --model ${tag}`
              : "Pick an installed harness on the Local models tab"}
            onClick={() =>
              harness &&
              props.onLaunch({ harness, model: tag }, !here && !m.cloud)}
          >
            {here || m.cloud ? "Launch" : "Pull & launch"} with{" "}
            {harness ? harnessLabel(harness) : "…"}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div class="ollama-body">
      <div class="ollama-search">
        <input
          class="field-select field-text"
          data-testid="ollama-lib-query"
          placeholder="Search ollama.com"
          spellcheck={false}
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        <div class="segmented" role="radiogroup" aria-label="Order">
          {(["popular", "newest"] as const).map((o) => (
            <button
              type="button"
              role="radio"
              key={o}
              aria-checked={order === o}
              class={order === o ? "is-active" : ""}
              data-testid="ollama-lib-order"
              data-value={o}
              onClick={() => setOrder(o)}
            >
              {o === "popular" ? "Popular" : "Newest"}
            </button>
          ))}
        </div>
        <label class="field-check">
          <input
            type="checkbox"
            data-testid="ollama-lib-tools"
            checked={toolsOnly}
            onChange={(e) =>
              setToolsOnly((e.target as HTMLInputElement).checked)}
          />
          <span class="field-label">Tools only</span>
        </label>
      </div>
      <div class="ollama-lib-list" data-testid="ollama-lib-list">
        {result?.error && (
          <div class="field-hint" data-testid="ollama-lib-error">
            {result.error}
          </div>
        )}
        {result === null && <div class="field-hint">Searching…</div>}
        {result && result.models.length === 0 && !result.error && (
          <div class="field-hint">No models match.</div>
        )}
        {result?.models.map(row)}
      </div>
    </div>
  );
}
