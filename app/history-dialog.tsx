// History: the pages web tiles visited (lib/web/visits.ts), newest first, with a search, and
// Clear (every page, or the picked one). A click opens a page in the focused web tile (else a new
// one); a middle click or ⌘-click (Ctrl elsewhere) in a new tile. Opened from "History…" (the
// bar's right-click menu, the `+` menu).
//
// Keyboard: the search has the focus; ↓ goes to the list (↑/↓, Home/End, Enter opens, Delete
// forgets the page); Escape clears the search, then closes.

import { useMemo, useRef, useState } from "denext";
import { removeVisits, searchVisits } from "../lib/web/visits.ts";
import { hostLabel } from "../lib/web/url.ts";
import { Modal } from "./modal.tsx";
import type { OpenWhere } from "./bookmarks-bar.tsx";
import { WebIcon } from "./web-icons.tsx";
import { useSynced, visitsStore } from "./web-stores.ts";

export interface HistoryDialogProps {
  open(url: string, where: OpenWhere): void;
  onClose(): void;
  now?: number;
}

/** A visit's time, as the list shows it: today's as a time, older ones as a date. */
function when(at: number, now: number): string {
  if (!at) return "";
  const d = new Date(at);
  const today = new Date(now);
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function HistoryDialog(props: HistoryDialogProps) {
  const visits = useSynced(visitsStore);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rows = useMemo(() => searchVisits(visits, query).slice(0, 500), [
    visits,
    query,
  ]);
  const now = props.now ?? Date.now();

  const openAt = (i: number, where: OpenWhere) => {
    const v = rows[i];
    if (!v) return;
    props.onClose();
    props.open(v.url, where);
  };

  return (
    <Modal
      label="History"
      testid="history-dialog"
      class="history-dialog"
      onClose={props.onClose}
    >
      <div class="modal-head">
        <h2>History</h2>
        <label class="bmm-search">
          <WebIcon name="search" size={13} />
          <input
            type="search"
            data-testid="history-search"
            placeholder="Search history"
            aria-label="Search history"
            spellcheck={false}
            autocomplete="off"
            value={query}
            ref={(el: HTMLInputElement | null) => {
              if (el && !el.dataset.focused) {
                el.dataset.focused = "1";
                el.focus();
              }
            }}
            onInput={(e) => {
              setQuery((e.target as HTMLInputElement).value);
              setActive(-1);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && rows.length) {
                e.preventDefault();
                setActive(0);
                listRef.current?.focus();
              } else if (e.key === "Enter" && rows.length) {
                e.preventDefault();
                openAt(0, e.metaKey || e.ctrlKey ? "tile" : "here");
              } else if (e.key === "Escape" && query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
        </label>
        <button
          type="button"
          class="btn-quiet is-danger"
          data-testid="history-clear"
          disabled={visits.visits.length === 0}
          title="Forget every visited page"
          onClick={() => visitsStore.set({ visits: [] })}
        >
          Clear history
        </button>
        <button
          type="button"
          class="btn-quiet"
          data-testid="history-close"
          onClick={props.onClose}
        >
          Done
        </button>
      </div>
      <div
        class="history-list"
        role="listbox"
        aria-label="Visited pages"
        data-testid="history-list"
        tabIndex={0}
        ref={listRef}
        aria-activedescendant={active >= 0
          ? `history-row-${active}`
          : undefined}
        onKeyDown={(e) => {
          const last = rows.length - 1;
          let to = -1;
          if (e.key === "ArrowDown") to = Math.min(last, active + 1);
          else if (e.key === "ArrowUp") to = Math.max(0, active - 1);
          else if (e.key === "Home") to = 0;
          else if (e.key === "End") to = last;
          else if (e.key === "Enter" && active >= 0) {
            e.preventDefault();
            return openAt(active, e.metaKey || e.ctrlKey ? "tile" : "here");
          } else if (
            (e.key === "Delete" || e.key === "Backspace") && rows[active]
          ) {
            e.preventDefault();
            visitsStore.set(
              removeVisits(visitsStore.get(), [rows[active].url]),
            );
            return;
          } else return;
          e.preventDefault();
          setActive(to);
          listRef.current?.querySelector(`#history-row-${to}`)?.scrollIntoView({
            block: "nearest",
          });
        }}
      >
        {rows.length === 0 && (
          <div class="bmm-empty" data-testid="history-empty">
            {query ? "No visited page matches." : "No pages visited yet."}
          </div>
        )}
        {rows.map((v, i) => (
          <div
            key={v.url}
            id={`history-row-${i}`}
            role="option"
            aria-selected={i === active}
            class={`history-row${i === active ? " is-active" : ""}`}
            data-testid="history-row"
            title={v.url}
            onClick={(e) => openAt(i, e.metaKey || e.ctrlKey ? "tile" : "here")}
            onMouseUp={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                openAt(i, "tile");
              }
            }}
          >
            <span class="history-title">{v.title || hostLabel(v.url)}</span>
            <span class="bmm-url">{v.url}</span>
            <span class="history-when">{when(v.at, now)}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
