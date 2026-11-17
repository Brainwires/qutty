/**
 * The scripts the companion's web tools run inside a web tile's page (the native view's
 * `evaluate`, an isolated world that shares the page's DOM), and the parsers for what they
 * return. Pure and client-safe: the scripts are strings, built here and run by the page's web
 * control (lib/web/web-control.ts); the hub formats their results (lib/hub/web-tools.ts).
 *
 * - `read`: the page's visible text, roughly as markdown (headings, paragraphs, list items), with
 *   every interactive element (links, buttons, fields, checkboxes, `role=` widgets) numbered
 *   inline (`[#12 link: Sign in]`) and listed with its role, name, href and value. Each numbered
 *   element is tagged `data-qutty-ref="12"` in the DOM, so a later click or type finds it by its
 *   number. A read clears the previous numbers: they are valid until the next read.
 * - `click`: an element by number, CSS selector or visible text: scrolled into view, then the
 *   pointer events and `click()`.
 * - `type`: into a field by number or selector: `execCommand("insertText")` (what typing does:
 *   the page's input events, frameworks that track the value), else the native value setter and
 *   an `input` event; then `change`. `clear` empties it first, `submit` presses Enter and, unless
 *   the page handled the key, submits the field's form (`requestSubmit`).
 * - `scroll`: to the top or bottom, to an element, or by a number of pixels.
 *
 * Every script is self-contained (it runs in the page, where nothing of the app exists), never
 * throws (a failure is `{ ok: false, error }`), and returns JSON.
 *
 * @module
 */

/** The DOM attribute a read numbers the interactive elements with. */
export const REF_ATTR = "data-qutty-ref";

/** The default and largest number of characters of page text a read returns. */
export const DEFAULT_READ_CHARS = 12_000;
export const MAX_READ_CHARS = 60_000;
/** How many interactive elements a read numbers at most. */
const MAX_ELEMENTS = 300;

/** Which element an action is for: a number from the last read, a CSS selector, or its text. */
export type PageTarget =
  | { ref: number }
  | { selector: string }
  | { text: string };

/** What a page script is asked to do. */
export type PageRequest =
  | { op: "read"; maxChars: number; selector?: string }
  | { op: "click"; target: PageTarget }
  | {
    op: "type";
    target: PageTarget;
    text: string;
    clear: boolean;
    submit: boolean;
  }
  | { op: "scroll"; to?: "top" | "bottom"; ref?: number; by?: number };

/** One numbered element of a read. */
export interface PageElement {
  ref: number;
  role: string;
  name: string;
  href?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
}

/** Where the page is scrolled. */
export interface PageScroll {
  y: number;
  height: number;
  viewport: number;
}

/** A read of the page. */
export interface PageRead {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
  /** The text was cut at `maxChars`. */
  truncated: boolean;
  /** Interactive elements past {@linkcode MAX_ELEMENTS} (not numbered). */
  more: number;
  scroll?: PageScroll;
}

/** What an action (click, type, scroll) reports. */
export interface PageAction {
  element?: { ref?: number; role: string; name: string };
  value?: string;
  submitted?: "form" | "enter" | "handled";
  scroll?: PageScroll;
}

/** The runtime every page script shares (plain JS, run in the page). */
const RUNTIME = String.raw`
const REF = ${JSON.stringify(REF_ATTR)};
const MAX_ELEMENTS = ${MAX_ELEMENTS};
const ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option", "switch", "textbox", "searchbox", "combobox",
  "slider", "spinbutton", "treeitem"]);
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "svg",
  "SVG", "CANVAS", "OBJECT", "EMBED"]);
const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "NAV", "MAIN",
  "ASIDE", "FORM", "TABLE", "TR", "UL", "OL", "DL", "DT", "DD", "BLOCKQUOTE", "PRE", "FIGURE",
  "FIGCAPTION", "FIELDSET", "DETAILS", "ADDRESS", "BODY", "CENTER", "HR"]);
const INTERACTIVE = "a[href],button,input,select,textarea,summary,[role],[contenteditable]";
const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const styleOf = (el) => {
  try { return el.ownerDocument.defaultView.getComputedStyle(el); } catch (_) { return null; }
};
const shown = (el) => {
  if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
  const s = styleOf(el);
  if (!s) return true;
  if (s.display === "contents") return true;
  if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") {
    return false;
  }
  if (Number(s.opacity) === 0) return false;
  return el.getClientRects().length > 0;
};
const typeOf = (el) => String(el.type || "text").toLowerCase();
const roleOf = (el) => {
  const explicit = clean(el.getAttribute("role")).split(" ")[0].toLowerCase();
  if (explicit && ROLES.has(explicit)) return explicit;
  const tag = String(el.tagName).toUpperCase();
  if (tag === "A" && el.hasAttribute("href")) return "link";
  if (tag === "BUTTON" || tag === "SUMMARY") return "button";
  if (tag === "SELECT") return el.multiple ? "listbox" : "combobox";
  if (tag === "TEXTAREA") return "textbox";
  if (tag === "INPUT") {
    const t = typeOf(el);
    if (t === "hidden") return null;
    if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
    if (t === "checkbox" || t === "radio") return t;
    if (t === "range") return "slider";
    if (t === "search") return "searchbox";
    if (t === "file") return "file";
    return "textbox";
  }
  if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) {
    return "textbox";
  }
  return null;
};
const isField = (el) => {
  const tag = String(el.tagName).toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const t = typeOf(el);
    return !["button", "submit", "reset", "image", "checkbox", "radio", "range", "file",
      "hidden", "color"].includes(t);
  }
  return !!el.isContentEditable;
};
const nameOf = (el, role) => {
  const doc = el.ownerDocument;
  const tag = String(el.tagName).toUpperCase();
  let n = clean(el.getAttribute("aria-label"));
  if (!n) {
    const ids = clean(el.getAttribute("aria-labelledby"));
    if (ids) {
      n = clean(ids.split(" ").map((id) => {
        const t = doc.getElementById(id);
        return t ? t.textContent : "";
      }).join(" "));
    }
  }
  if (!n && el.labels && el.labels.length) {
    n = clean(Array.from(el.labels).map((l) => l.textContent).join(" "));
  }
  if (!n && tag === "INPUT") {
    const t = typeOf(el);
    if (t === "button" || t === "submit" || t === "reset") {
      n = clean(el.value) || (t === "submit" ? "Submit" : t === "reset" ? "Reset" : "");
    } else if (t === "image") n = clean(el.alt);
  }
  if (!n && !isField(el)) n = clean(el.innerText == null ? el.textContent : el.innerText);
  if (!n && el.querySelector) {
    const img = el.querySelector("img[alt]");
    if (img) n = clean(img.alt);
  }
  if (!n) {
    n = clean(el.getAttribute("placeholder")) || clean(el.getAttribute("title")) ||
      clean(el.getAttribute("name"));
  }
  return cut(n, 120);
};
const valueOf = (el) => {
  const tag = String(el.tagName).toUpperCase();
  if (tag === "SELECT") {
    const o = el.selectedOptions && el.selectedOptions[0];
    return o ? cut(clean(o.textContent), 120) : "";
  }
  if (tag === "INPUT" && typeOf(el) === "password") return "•".repeat(Math.min(el.value.length, 12));
  if ((tag === "INPUT" && isField(el)) || tag === "TEXTAREA") return cut(String(el.value), 200);
  if (el.isContentEditable) return cut(clean(el.innerText), 200);
  return undefined;
};
const describe = (el, ref) => {
  const role = roleOf(el) || String(el.tagName).toLowerCase();
  const out = { role, name: nameOf(el, role) };
  if (ref !== undefined) out.ref = ref;
  return out;
};
const scrollerOf = (doc) => {
  const root = doc.scrollingElement || doc.documentElement;
  if (root && root.scrollHeight > root.clientHeight + 1) return root;
  // The page scrolls inside a container: the largest one that can.
  let best = null;
  let area = 0;
  for (const el of doc.querySelectorAll("*")) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const s = styleOf(el);
    if (!s || (s.overflowY !== "auto" && s.overflowY !== "scroll")) continue;
    const a = el.clientWidth * el.clientHeight;
    if (a > area) { area = a; best = el; }
  }
  return best || root;
};
const scrollInfo = () => {
  const el = scrollerOf(document);
  return el
    ? { y: Math.round(el.scrollTop), height: Math.round(el.scrollHeight),
      viewport: Math.round(el.clientHeight) }
    : undefined;
};
/** Every element under root, into open shadow roots and same-origin frames. */
const deepAll = (root, selector, out) => {
  for (const el of root.querySelectorAll(selector)) out.push(el);
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) deepAll(el.shadowRoot, selector, out);
    const tag = String(el.tagName).toUpperCase();
    if (tag === "IFRAME" || tag === "FRAME") {
      let d = null;
      try { d = el.contentDocument; } catch (_) { /* cross-origin */ }
      if (d) deepAll(d, selector, out);
    }
  }
  return out;
};
const find = (target) => {
  if (target.ref !== undefined) {
    const hit = deepAll(document, "[" + REF + '="' + target.ref + '"]', [])[0];
    return hit ? { el: hit } : { error: "no element #" + target.ref +
      " (numbers come from the last read_page; read the page again)" };
  }
  if (target.selector !== undefined) {
    let hit = null;
    try { hit = document.querySelector(target.selector); } catch (_) {
      return { error: "not a valid CSS selector: " + target.selector };
    }
    return hit ? { el: hit } : { error: "nothing matches " + target.selector };
  }
  const want = clean(target.text).toLowerCase();
  const all = deepAll(document, INTERACTIVE, []).filter((el) => roleOf(el) && shown(el));
  const named = all.map((el) => [el, nameOf(el, roleOf(el)).toLowerCase()]);
  const exact = named.find(([, n]) => n === want);
  if (exact) return { el: exact[0] };
  const part = named.find(([, n]) => n.includes(want));
  if (part) return { el: part[0] };
  return { error: 'nothing clickable says "' + target.text + '"' };
};
const refOf = (el) => {
  const r = Number(el.getAttribute(REF));
  return Number.isInteger(r) && r > 0 ? r : undefined;
};

function read(req) {
  for (const el of deepAll(document, "[" + REF + "]", [])) el.removeAttribute(REF);
  let root = document.body || document.documentElement;
  if (req.selector) {
    try { root = document.querySelector(req.selector); } catch (_) {
      return { ok: false, error: "not a valid CSS selector: " + req.selector };
    }
    if (!root) return { ok: false, error: "nothing matches " + req.selector };
  }
  const max = req.maxChars;
  const parts = [];
  let size = 0;
  let truncated = false;
  let visited = 0;
  const emit = (s) => {
    if (truncated || !s) return;
    if (size + s.length > max) {
      parts.push(s.slice(0, Math.max(0, max - size)));
      size = max;
      truncated = true;
      return;
    }
    parts.push(s);
    size += s.length;
  };
  const elements = [];
  let more = 0;
  let next = 0;
  const walk = (node) => {
    if (++visited > 50000) return;
    if (node.nodeType === 3) { emit(node.data); return; }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    if (node.nodeType === 11) {
      for (const c of node.childNodes) walk(c);
      return;
    }
    const el = node;
    const tag = String(el.tagName).toUpperCase();
    if (SKIP.has(tag) || SKIP.has(el.tagName)) return;
    if (!shown(el)) return;
    if (tag === "BR") { emit("\n"); return; }
    if (tag === "IFRAME" || tag === "FRAME") {
      let d = null;
      try { d = el.contentDocument; } catch (_) { /* cross-origin */ }
      if (d && d.body) walk(d.body);
      return;
    }
    const role = roleOf(el);
    if (role) {
      const name = nameOf(el, role);
      if (elements.length >= MAX_ELEMENTS) {
        more++;
        emit(" " + name + " ");
        return;
      }
      const ref = ++next;
      el.setAttribute(REF, String(ref));
      const item = { ref, role, name };
      if (role === "link" && el.href) item.href = cut(String(el.href), 300);
      const value = valueOf(el);
      if (value !== undefined) item.value = value;
      if (role === "checkbox" || role === "radio" || role === "switch") {
        item.checked = el.checked === true || el.getAttribute("aria-checked") === "true";
      }
      if (el.disabled === true || el.getAttribute("aria-disabled") === "true") {
        item.disabled = true;
      }
      elements.push(item);
      const shownValue = value ? ' = "' + value + '"' : "";
      emit(" [#" + ref + " " + role + ": " + name + shownValue + "] ");
      return;
    }
    if (tag === "IMG") {
      const alt = clean(el.getAttribute("alt"));
      if (alt) emit(" [image: " + cut(alt, 80) + "] ");
      return;
    }
    const heading = /^H([1-6])$/.exec(tag);
    if (heading) emit("\n\n" + "#".repeat(Number(heading[1])) + " ");
    else if (tag === "LI") emit("\n- ");
    else if (tag === "TD" || tag === "TH") emit(" | ");
    else if (BLOCK.has(tag)) emit("\n");
    if (el.shadowRoot) walk(el.shadowRoot);
    for (const c of el.childNodes) walk(c);
    if (heading) emit("\n\n");
    else if (BLOCK.has(tag)) emit("\n");
  };
  walk(root);
  const text = parts.join("")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    ok: true,
    url: String(location.href),
    title: String(document.title || ""),
    text,
    elements,
    truncated,
    more,
    scroll: scrollInfo(),
  };
}

function click(req) {
  const found = find(req.target);
  if (!found.el) return { ok: false, error: found.error };
  const el = found.el;
  const element = describe(el, refOf(el));
  if (el.disabled === true || el.getAttribute("aria-disabled") === "true") {
    return { ok: false, error: element.role + ' "' + element.name + '" is disabled' };
  }
  try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) { /* old engine */ }
  const r = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, composed: true, button: 0,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  const P = globalThis.PointerEvent;
  if (P) el.dispatchEvent(new P("pointerdown", { ...at, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", at));
  if (typeof el.focus === "function") el.focus({ preventScroll: true });
  if (P) el.dispatchEvent(new P("pointerup", { ...at, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseup", at));
  if (typeof el.click === "function") el.click();
  else el.dispatchEvent(new MouseEvent("click", at));
  return { ok: true, element };
}

const setValue = (el, v) => {
  const tag = String(el.tagName).toUpperCase();
  const proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const d = Object.getOwnPropertyDescriptor(proto, "value");
  if (d && d.set) d.set.call(el, v);
  else el.value = v;
};
const inputEvent = (el, data) => {
  const I = globalThis.InputEvent;
  el.dispatchEvent(I
    ? new I("input", { bubbles: true, composed: true, inputType: "insertText", data })
    : new Event("input", { bubbles: true }));
};

function type(req) {
  const found = find(req.target);
  if (!found.el) return { ok: false, error: found.error };
  const el = found.el;
  const element = describe(el, refOf(el));
  if (!isField(el)) {
    return { ok: false, error: element.role + ' "' + element.name + '" is not a text field' };
  }
  if (el.disabled === true || el.readOnly === true) {
    return { ok: false, error: element.role + ' "' + element.name + '" is read-only' };
  }
  const doc = el.ownerDocument;
  const tag = String(el.tagName).toUpperCase();
  try { el.scrollIntoView({ block: "center" }); } catch (_) { /* old engine */ }
  if (typeof el.focus === "function") el.focus({ preventScroll: true });
  if (tag === "SELECT") {
    const want = clean(req.text).toLowerCase();
    const opts = Array.from(el.options);
    const o = opts.find((x) => clean(x.textContent).toLowerCase() === want) ||
      opts.find((x) => String(x.value).toLowerCase() === want) ||
      opts.find((x) => clean(x.textContent).toLowerCase().includes(want));
    if (!o) return { ok: false, error: 'no option "' + req.text + '"' };
    el.value = o.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    if (req.clear) {
      const range = doc.createRange();
      range.selectNodeContents(el);
      const sel = doc.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      try { doc.execCommand("delete"); } catch (_) { el.textContent = ""; }
    }
    let ok = false;
    try { ok = doc.execCommand("insertText", false, req.text); } catch (_) { ok = false; }
    if (!ok) { el.append(doc.createTextNode(req.text)); inputEvent(el, req.text); }
  } else {
    const before = req.clear ? "" : String(el.value);
    if (req.clear && el.value !== "") {
      setValue(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) { /* email */ }
    let ok = false;
    try { ok = doc.execCommand("insertText", false, req.text); } catch (_) { ok = false; }
    if (!ok || String(el.value) !== before + req.text) {
      setValue(el, before + req.text);
      inputEvent(el, req.text);
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const out = { ok: true, element, value: valueOf(el) };
  if (req.submit) {
    const key = (t) => el.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter",
      keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }));
    const free = key("keydown");
    if (free) key("keypress");
    key("keyup");
    const form = el.form || (el.closest && el.closest("form"));
    if (!free) out.submitted = "handled";
    else if (form) {
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
      out.submitted = "form";
    } else out.submitted = "enter";
  }
  return out;
}

function scroll(req) {
  if (req.ref !== undefined) {
    const found = find({ ref: req.ref });
    if (!found.el) return { ok: false, error: found.error };
    found.el.scrollIntoView({ block: "center" });
    return { ok: true, element: describe(found.el, req.ref), scroll: scrollInfo() };
  }
  const el = scrollerOf(document);
  if (!el) return { ok: false, error: "the page cannot scroll" };
  if (req.to === "top") el.scrollTop = 0;
  else if (req.to === "bottom") el.scrollTop = el.scrollHeight;
  if (typeof req.by === "number") el.scrollTop = el.scrollTop + req.by;
  return { ok: true, scroll: scrollInfo() };
}
`;

/** The script that carries out `request` in the page (it evaluates to the result as JSON). */
export function pageScript(request: PageRequest): string {
  return `(() => {
${RUNTIME}
  const req = ${JSON.stringify(request)};
  try {
    if (req.op === "read") return read(req);
    if (req.op === "click") return click(req);
    if (req.op === "type") return type(req);
    if (req.op === "scroll") return scroll(req);
    return { ok: false, error: "unknown request" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
})()`;
}

// --- parsing what the page answered (it is the page's data: checked, never trusted) ----------------

const MAX_FIELD = 300;

const s = (v: unknown, max = MAX_FIELD): string =>
  typeof v === "string" ? v.slice(0, max) : "";
const n = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;

/** A failed page script's reason, or `undefined` when it went through. */
export function pageError(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return "the page gave no answer";
  const r = raw as Record<string, unknown>;
  if (r.ok === true) return undefined;
  return s(r.error, 500) || "the page script failed";
}

function scrollOf(v: unknown): PageScroll | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  return { y: n(r.y), height: n(r.height), viewport: n(r.viewport) };
}

function elementOf(v: unknown): PageElement | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const ref = n(r.ref);
  if (ref < 1) return null;
  return {
    ref,
    role: s(r.role, 40) || "element",
    name: s(r.name, 200),
    ...(typeof r.href === "string" ? { href: s(r.href) } : {}),
    ...(typeof r.value === "string" ? { value: s(r.value) } : {}),
    ...(typeof r.checked === "boolean" ? { checked: r.checked } : {}),
    ...(r.disabled === true ? { disabled: true } : {}),
  };
}

/** A read's result, checked and capped (`maxChars` of text). Throws with the page's reason. */
export function parsePageRead(raw: unknown, maxChars: number): PageRead {
  const error = pageError(raw);
  if (error) throw new Error(error);
  const r = raw as Record<string, unknown>;
  const text = s(r.text, maxChars);
  const list = Array.isArray(r.elements) ? r.elements : [];
  const elements = list.slice(0, MAX_ELEMENTS).map(elementOf).filter((
    e,
  ): e is PageElement => e !== null);
  const scroll = scrollOf(r.scroll);
  return {
    url: s(r.url, 2000),
    title: s(r.title),
    text,
    elements,
    truncated: r.truncated === true || (typeof r.text === "string" &&
      r.text.length > maxChars),
    more: n(r.more) + Math.max(0, list.length - MAX_ELEMENTS),
    ...(scroll ? { scroll } : {}),
  };
}

/** An action's result, checked. Throws with the page's reason. */
export function parsePageAction(raw: unknown): PageAction {
  const error = pageError(raw);
  if (error) throw new Error(error);
  const r = raw as Record<string, unknown>;
  const out: PageAction = {};
  if (r.element && typeof r.element === "object") {
    const e = r.element as Record<string, unknown>;
    const ref = n(e.ref);
    out.element = {
      ...(ref > 0 ? { ref } : {}),
      role: s(e.role, 40) || "element",
      name: s(e.name, 200),
    };
  }
  if (typeof r.value === "string") out.value = s(r.value);
  if (
    r.submitted === "form" || r.submitted === "enter" ||
    r.submitted === "handled"
  ) out.submitted = r.submitted;
  const scroll = scrollOf(r.scroll);
  if (scroll) out.scroll = scroll;
  return out;
}

/** One element of a read as a line: `#3 link "Sign in" → https://…`. */
function elementLine(e: PageElement): string {
  const bits = [`#${e.ref} ${e.role} "${e.name}"`];
  if (e.value !== undefined && e.value !== "") bits.push(`= "${e.value}"`);
  if (e.checked !== undefined) {
    bits.push(e.checked ? "(checked)" : "(unchecked)");
  }
  if (e.disabled) bits.push("(disabled)");
  if (e.href) bits.push(`→ ${e.href}`);
  return bits.join(" ");
}

/** A read as the model sees it: the page, its text, then the numbered elements. */
export function formatPageRead(read: PageRead): string {
  const lines = [`${read.title || "(untitled)"} — ${read.url}`];
  if (read.scroll && read.scroll.height > read.scroll.viewport) {
    lines.push(
      `(scrolled to ${read.scroll.y} of ${read.scroll.height}px; ${read.scroll.viewport}px visible)`,
    );
  }
  lines.push("", read.text || "(no visible text)");
  if (read.truncated) {
    lines.push(
      "… (cut: pass maxChars for more, or a selector to read one part)",
    );
  }
  lines.push("");
  if (read.elements.length === 0) {
    lines.push("No interactive elements.");
  } else {
    lines.push(
      "Interactive elements (act on them by number: web_click, web_type):",
      ...read.elements.map(elementLine),
    );
  }
  if (read.more > 0) {
    lines.push(
      `(+${read.more} more not numbered; read a part with selector)`,
    );
  }
  return lines.join("\n");
}
