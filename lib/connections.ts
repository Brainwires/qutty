/**
 * The connection manager's logic, pure: the grouped and filtered host list, keyboard selection,
 * quick connect, and the Edit / New form (its fields ↔ `SshHostInput`, with the same checks the
 * backend applies so a mistake shows up next to the field before a round trip).
 *
 * @module
 */

import {
  isSafeAlias,
  isSafeConfigValue,
  isSafeHost,
  isSafeProxyJump,
  isSafeUser,
  parseQuickTarget,
  type SshHost,
  type SshHostInput,
  type SshQuickTarget,
  type SshTarget,
  targetLabel,
} from "./ssh-config.ts";
import type { SshRecent } from "./ssh-command.ts";
import { isTintId } from "./workspace/themes.ts";

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------

/** A group of the list, top to bottom. */
export type ConnectionGroupId = "favorites" | "qutty" | "config" | "recent";

const GROUP_LABELS: Record<ConnectionGroupId, string> = {
  favorites: "Favorites",
  qutty: "Qutty hosts",
  config: "~/.ssh/config",
  recent: "Recent",
};

/** One row of the list. */
export interface ConnectionItem {
  /** Unique across the whole list (a favorite also appears nowhere else; a recent may). */
  key: string;
  group: ConnectionGroupId;
  /** The alias, or `user@host:port`. */
  label: string;
  /** `user@hostname:port`, the row's second line. */
  detail: string;
  target: SshTarget;
  /** The saved host (for a recent, when its alias is still known). */
  host?: SshHost;
}

export interface ConnectionGroup {
  id: ConnectionGroupId;
  label: string;
  items: ConnectionItem[];
}

/** How many recents the list shows. */
const MAX_RECENT_ROWS = 8;

/** `user@hostname:port` (the alias when there is no HostName). */
export function hostDetail(host: SshHost): string {
  return targetLabel({
    host: host.hostName ?? host.alias,
    ...(host.user ? { user: host.user } : {}),
    ...(host.port ? { port: host.port } : {}),
  });
}

/** The lower-cased words a host is found by: aliases, HostName, User and tags. */
function haystack(host: SshHost | undefined, extra: string[] = []): string[] {
  const words = [
    ...extra,
    ...(host?.aliases ?? []),
    host?.hostName,
    host?.user,
    ...(host?.tags ?? []),
  ];
  return words.filter((w): w is string => !!w).map((w) => w.toLowerCase());
}

/** Whether every whitespace-separated word of `query` is in one of `words` (case-insensitive). */
function matches(words: string[], query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((t) => words.some((w) => w.includes(t)));
}

/** Whether `host` matches the filter text (by alias, HostName, User or tag). */
export function hostMatches(host: SshHost, query: string): boolean {
  return matches(haystack(host), query);
}

function hostItem(group: ConnectionGroupId, host: SshHost): ConnectionItem {
  return {
    key: `${group}:${host.alias}`,
    group,
    label: host.alias,
    detail: hostDetail(host),
    target: { alias: host.alias },
    host,
  };
}

/**
 * The list for `query`: Favorites (from either file), Qutty hosts (qutty.conf), `~/.ssh/config`
 * hosts and the most recent connections, each filtered; empty groups are left out.
 */
export function connectionGroups(
  hosts: readonly SshHost[],
  recents: readonly SshRecent[],
  query: string,
): ConnectionGroup[] {
  const shown = hosts.filter((h) => hostMatches(h, query));
  const byAlias = new Map(hosts.flatMap((h) => h.aliases.map((a) => [a, h])));
  const recent = [...recents]
    .sort((a, b) => b.at - a.at)
    .flatMap((r): ConnectionItem[] => {
      const host = "alias" in r.target
        ? byAlias.get(r.target.alias)
        : undefined;
      if (!matches(haystack(host, [r.label]), query)) return [];
      return [{
        key: `recent:${r.label}`,
        group: "recent",
        label: r.label,
        detail: host ? hostDetail(host) : r.label,
        target: r.target,
        ...(host ? { host } : {}),
      }];
    })
    .slice(0, MAX_RECENT_ROWS);
  const groups: [ConnectionGroupId, ConnectionItem[]][] = [
    [
      "favorites",
      shown.filter((h) => h.favorite).map((h) => hostItem("favorites", h)),
    ],
    [
      "qutty",
      shown.filter((h) => !h.favorite && h.editable).map((h) =>
        hostItem("qutty", h)
      ),
    ],
    [
      "config",
      shown.filter((h) => !h.favorite && !h.editable).map((h) =>
        hostItem("config", h)
      ),
    ],
    ["recent", recent],
  ];
  return groups
    .filter(([, items]) => items.length > 0)
    .map(([id, items]) => ({ id, label: GROUP_LABELS[id], items }));
}

/** Every row, top to bottom (the order ↑ / ↓ walk). */
export function flattenGroups(
  groups: readonly ConnectionGroup[],
): ConnectionItem[] {
  return groups.flatMap((g) => g.items);
}

/**
 * The row after (`dir` 1) or before (-1) `current`, clamped at the ends. A missing or unknown
 * `current` selects the first row; an empty list selects nothing.
 */
export function moveSelection(
  items: readonly ConnectionItem[],
  current: string | null,
  dir: 1 | -1,
): string | null {
  if (items.length === 0) return null;
  const i = items.findIndex((it) => it.key === current);
  if (i < 0) return items[0].key;
  return items[Math.min(items.length - 1, Math.max(0, i + dir))].key;
}

/** The selection to keep after the list changed: the same row if it is still there, else the first. */
export function keepSelection(
  items: readonly ConnectionItem[],
  current: string | null,
): string | null {
  return items.some((it) => it.key === current)
    ? current
    : items[0]?.key ?? null;
}

/** Quick connect: the filter text as `user@host:port`, offered only when no row matches. */
export function quickConnectTarget(
  query: string,
  groups: readonly ConnectionGroup[],
): SshQuickTarget | undefined {
  if (groups.some((g) => g.items.length > 0)) return undefined;
  return parseQuickTarget(query);
}

// ---------------------------------------------------------------------------------------------
// The Edit / New form
// ---------------------------------------------------------------------------------------------

/** The form's fields, as typed. */
export interface HostForm {
  alias: string;
  hostName: string;
  user: string;
  port: string;
  identityFile: string;
  proxyJump: string;
  /** Comma- or space-separated. */
  tags: string;
  tint: string;
  favorite: boolean;
  tmux: boolean;
  remoteCommand: string;
}

export const EMPTY_FORM: HostForm = {
  alias: "",
  hostName: "",
  user: "",
  port: "",
  identityFile: "",
  proxyJump: "",
  tags: "",
  tint: "",
  favorite: false,
  tmux: false,
  remoteCommand: "",
};

/** A saved host's fields, for editing. */
export function formFromHost(host: SshHost): HostForm {
  return {
    alias: host.alias,
    hostName: host.hostName ?? "",
    user: host.user ?? "",
    port: host.port ? String(host.port) : "",
    identityFile: host.identityFile ?? "",
    proxyJump: host.proxyJump ?? "",
    tags: (host.tags ?? []).join(", "),
    tint: isTintId(host.tint) ? host.tint : "",
    favorite: !!host.favorite,
    tmux: !!host.tmux,
    remoteCommand: host.remoteCommand ?? "",
  };
}

/**
 * A `~/.ssh/config` host copied into a new Qutty host. It needs its own alias: qutty.conf is
 * included first, so the same alias there would shadow the user's entry.
 */
export function formForDuplicate(
  host: SshHost,
  taken: readonly SshHost[],
): HostForm {
  const aliases = new Set(taken.flatMap((h) => h.aliases));
  let alias = `${host.alias}-copy`;
  for (let n = 2; aliases.has(alias); n++) alias = `${host.alias}-copy${n}`;
  return { ...formFromHost(host), alias };
}

/** A quick-connect destination, as a new host to save (the alias is the host name). */
export function formFromQuickTarget(target: SshQuickTarget): HostForm {
  const alias = target.host.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "");
  return {
    ...EMPTY_FORM,
    alias,
    hostName: target.host,
    user: target.user ?? "",
    port: target.port ? String(target.port) : "",
  };
}

/** The form's problems, by field (empty when it can be saved). */
export type FormErrors = Partial<Record<keyof HostForm, string>>;

const TAG = /^[A-Za-z0-9._-]{1,32}$/;

/** The form's tags, split on commas and spaces. */
function splitTags(raw: string): string[] {
  return raw.split(/[\s,]+/).filter(Boolean);
}

function checkTextFields(f: HostForm, errors: FormErrors): void {
  const host = f.hostName.trim();
  const user = f.user.trim();
  const jump = f.proxyJump.trim();
  if (!isSafeAlias(f.alias.trim())) {
    errors.alias =
      "Letters, digits, dot, dash and underscore; no leading dash.";
  }
  if (host && !isSafeHost(host)) {
    errors.hostName = "Not a host name or address.";
  }
  if (user && !isSafeUser(user)) errors.user = "Not a user name ssh accepts.";
  if (jump && !isSafeProxyJump(jump)) {
    errors.proxyJump = "Use [user@]host[:port], comma separated.";
  }
  for (const key of ["identityFile", "remoteCommand"] as const) {
    const v = f[key].trim();
    if (v && !isSafeConfigValue(v)) {
      errors[key] = "No double quotes or line breaks.";
    }
  }
}

/** Check the form and turn it into what `sshSaveHost` takes. */
export function hostInputFromForm(
  f: HostForm,
  previousAlias?: string,
): { input: SshHostInput; errors?: undefined } | {
  input?: undefined;
  errors: FormErrors;
} {
  const errors: FormErrors = {};
  checkTextFields(f, errors);
  const portText = f.port.trim();
  const port = portText ? Number(portText) : undefined;
  if (
    port !== undefined &&
    (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535)
  ) errors.port = "1 to 65535.";
  const tags = splitTags(f.tags);
  if (tags.some((t) => !TAG.test(t))) {
    errors.tags = "Tags are letters, digits, dot, dash and underscore.";
  }
  if (f.tint && !isTintId(f.tint)) errors.tint = "Unknown tint.";
  if (Object.keys(errors).length > 0) return { errors };
  const text = (
    k: "hostName" | "user" | "identityFile" | "proxyJump" | "remoteCommand",
  ) => {
    const v = f[k].trim();
    return v ? { [k]: v } : {};
  };
  const alias = f.alias.trim();
  return {
    input: {
      alias,
      ...(previousAlias && previousAlias !== alias ? { previousAlias } : {}),
      ...text("hostName"),
      ...text("user"),
      ...(port !== undefined ? { port } : {}),
      ...text("identityFile"),
      ...text("proxyJump"),
      ...text("remoteCommand"),
      ...(tags.length ? { tags } : {}),
      ...(f.tint ? { tint: f.tint } : {}),
      ...(f.favorite ? { favorite: true } : {}),
      ...(f.tmux ? { tmux: true } : {}),
    },
  };
}
