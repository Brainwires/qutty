/**
 * The little markdown an agent tile draws (app/agent-tile.tsx): headings, paragraphs, bullet and
 * numbered lists, block quotes, rules, fenced code blocks, and inline code, bold, italic and
 * links. No HTML passes through: the view builds elements from these blocks. Plus a cheap code
 * highlighter (strings, comments, numbers, keywords) for the code blocks.
 *
 * Streaming-safe: an unclosed code fence is a code block that runs to the end.
 *
 * Pure.
 *
 * @module
 */

/** A block of markdown. */
export type MdBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
  | { kind: "code"; lang: string; text: string };

/** `text` as blocks. */
export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) out.push({ kind: "paragraph", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      flush();
      const close = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) {
        body.push(lines[i]);
        i++;
      }
      out.push({
        kind: "code",
        lang: fence[2].toLowerCase(),
        text: body.join("\n"),
      });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push({
        kind: "heading",
        level: heading[1].length,
        text: heading[2].replace(/\s+#+\s*$/, ""),
      });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push({ kind: "rule" });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = !!numbered;
      const items = [bullet ? bullet[1] : numbered![2]];
      const start = numbered ? Number(numbered[1]) : 1;
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const b = /^\s*[-*+]\s+(.*)$/.exec(next);
        const n = /^\s*\d+[.)]\s+(.*)$/.exec(next);
        if (ordered ? n : b) {
          items.push((ordered ? n! : b!)[1]);
          i++;
        } else if (/^\s{2,}\S/.test(next)) {
          items[items.length - 1] += `\n${next.trim()}`;
          i++;
        } else break;
      }
      out.push({ kind: "list", ordered, start, items });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const body = [quote[1]];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) {
        body.push(lines[++i].replace(/^\s*>\s?/, ""));
      }
      out.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

/** A run of inline text. */
export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "link"; text: string; href: string };

const INLINE =
  /(`+)([\s\S]+?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|(?<![\w])_([^_\s][^_]*)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** Inline markdown as runs. Links keep only http(s) and mailto targets. */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    last = at + m[0].length;
    if (m[2] !== undefined) out.push({ kind: "code", text: m[2] });
    else if (m[3] !== undefined || m[4] !== undefined) {
      out.push({ kind: "strong", text: m[3] ?? m[4] });
    } else if (m[5] !== undefined || m[6] !== undefined) {
      out.push({ kind: "em", text: m[5] ?? m[6] });
    } else if (m[7] !== undefined) {
      const href = m[8];
      out.push(
        safeHref(href)
          ? { kind: "link", text: m[7], href }
          : { kind: "text", text: m[0] },
      );
    } else if (m[9] !== undefined) {
      out.push({ kind: "link", text: m[9], href: m[9] });
    }
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** Whether a link target may be opened (http, https, mailto). */
export function safeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href);
}

/** A highlighted piece of code. */
export interface CodeToken {
  t: "kw" | "str" | "com" | "num" | "plain";
  s: string;
}

const KEYWORDS = new Set(
  (
    "abstract as async await break case catch class const continue def default del delete do " +
    "elif else enum export extends false final finally fn for from func function go if impl " +
    "import in interface is let match mod mut new nil none null of package private protected " +
    "pub public raise return self static struct super switch this throw true try type typeof " +
    "undefined use var void while with yield"
  ).split(" "),
);

const COMMENT_HASH = new Set([
  "sh",
  "bash",
  "zsh",
  "shell",
  "console",
  "py",
  "python",
  "rb",
  "ruby",
  "yaml",
  "yml",
  "toml",
  "dockerfile",
  "makefile",
]);

/** `code` as tokens (one pass, no nesting: cheap and good enough to read). */
export function highlight(code: string, lang: string): CodeToken[] {
  const hash = COMMENT_HASH.has(lang);
  const re = hash
    ? /(#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_.]*\b)|([A-Za-z_][\w]*)/g
    : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_.]*\b)|([A-Za-z_][\w]*)/g;
  const out: CodeToken[] = [];
  let last = 0;
  const plain = (s: string) => {
    if (!s) return;
    const prev = out.at(-1);
    if (prev?.t === "plain") prev.s += s;
    else out.push({ t: "plain", s });
  };
  for (const m of code.matchAll(re)) {
    const at = m.index ?? 0;
    plain(code.slice(last, at));
    last = at + m[0].length;
    if (m[1] !== undefined) out.push({ t: "com", s: m[1] });
    else if (m[2] !== undefined) out.push({ t: "str", s: m[2] });
    else if (m[3] !== undefined) out.push({ t: "num", s: m[3] });
    else if (KEYWORDS.has(m[4])) out.push({ t: "kw", s: m[4] });
    else plain(m[4]);
  }
  plain(code.slice(last));
  return out;
}
