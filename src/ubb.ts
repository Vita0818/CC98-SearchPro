/**
 * Parser for CC98's UBB markup.
 *
 * The dialect is `[name]`, `[name=value]` or `[name, key=value, key]`, closed by
 * `[/name]`. Two shapes carry a "main" value: `[color=red]` stores it under the
 * tag name, while `[quote, 某人]` stores it positionally, so both are surfaced as
 * `mainValue`. Unknown or malformed markup is preserved verbatim instead of being
 * silently dropped, which is what the official renderer does too.
 */

export interface UbbTag {
  type: "tag";
  name: string;
  /** Lower-cased attribute names; valueless flags map to "". */
  attrs: Record<string, string>;
  /** Value carried as `[name=value]` or as the first bare positional item. */
  mainValue: string | null;
  /** Text between an explicit close tag, only used by raw tags such as [code]. */
  raw: string;
  children: UbbNode[];
  /** True when no `[/name]` was ever seen and the tag was closed implicitly. */
  autoClosed: boolean;
}

export interface UbbText {
  type: "text";
  text: string;
}

export type UbbNode = UbbTag | UbbText;

/** Tags whose body must not be interpreted as markup. */
const RAW_TAGS = new Set(["code", "noubb", "md"]);

export function isRawTag(name: string): boolean {
  return RAW_TAGS.has(name);
}

/** Sticker tags, shared by the void-tag test and the plain-text projection. */
const EMOTION_TAGS = "em\\d{2}|tb\\d{2}|ms\\d{2}|ac\\d+|[acf]:\\d+";

const EMOTION_NAME = new RegExp(`^(?:${EMOTION_TAGS})$`, "i");

/** Tags CC98's own editor inserts with no closing counterpart. */
const VOID_TAGS = new RegExp(`^(?:line|${EMOTION_TAGS})$`, "i");

export function isVoidTag(name: string): boolean {
  return VOID_TAGS.test(name);
}

const TAG_START = /^\/?[a-z][a-z0-9_:]*(?:[,=\]])/i;

function isTagStart(source: string, index: number): boolean {
  if (source[index] !== "[") return false;
  return TAG_START.test(source.slice(index + 1));
}

/** Splits `[name, a=1, b]` into its comma-separated parts, honouring quotes. */
function splitParts(body: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quote) {
      if (char === quote) {
        quote = "";
        current += char;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  if ((first === '"' || first === "'") && trimmed.at(-1) === first && trimmed.length > 1) {
    return trimmed.slice(1, -1).replace(first + first, first);
  }
  return trimmed;
}

/** Reads the tag body starting after `[`, returning the index of the closing `]`. */
function scanTag(source: string, start: number): { end: number; inner: string } | null {
  let quote = "";
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "]") return { end: i, inner: source.slice(start, i) };
  }
  return null;
}

interface ParsedTag {
  closing: boolean;
  name: string;
  attrs: Record<string, string>;
  mainValue: string | null;
}

function parseTag(inner: string): ParsedTag | null {
  const closing = inner[0] === "/";
  const body = (closing ? inner.slice(1) : inner).trim();
  if (!body) return null;

  const parts = splitParts(body);
  const head = parts[0].trim();
  const eq = head.indexOf("=");
  const name = (eq === -1 ? head : head.slice(0, eq)).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_:]*$/i.test(name)) return null;

  const attrs: Record<string, string> = {};
  const positional: string[] = [];
  let mainValue: string | null = eq === -1 ? null : unquote(head.slice(eq + 1));

  for (const rawPart of parts.slice(1)) {
    const part = rawPart.trim();
    if (!part) continue;
    const split = part.indexOf("=");
    if (split === -1) {
      const flag = unquote(part).toLowerCase();
      attrs[flag] = "";
      positional.push(unquote(part));
    } else {
      const key = part.slice(0, split).trim().toLowerCase();
      const value = unquote(part.slice(split + 1));
      if (key) attrs[key] = value;
    }
  }

  if (mainValue === null && positional.length > 0) mainValue = positional[0];
  if (mainValue === null && attrs[name]) mainValue = attrs[name];

  return { closing, name, attrs, mainValue };
}

function makeTag(parsed: ParsedTag, raw: string): UbbTag {
  return {
    type: "tag",
    name: parsed.name,
    attrs: parsed.attrs,
    mainValue: parsed.mainValue,
    raw,
    children: [],
    autoClosed: false
  };
}

function findCloseIndex(source: string, from: number, name: string): { start: number; end: number } | null {
  const needle = `/${name}`;
  let cursor = from;
  while (cursor < source.length) {
    const open = source.indexOf("[", cursor);
    if (open === -1) return null;
    const tag = scanTag(source, open + 1);
    if (!tag) return null;
    if (tag.inner.trim().toLowerCase() === needle.trim()) return { start: open, end: tag.end };
    cursor = tag.end + 1;
  }
  return null;
}

/**
 * Turns UBB source into a node tree. Unclosed tags are implicitly closed at the
 * end of the input and an unmatched `[/x]` degrades to literal text, so malformed
 * user content can never swallow the rest of a post.
 */
export function parseUbb(source: string): UbbNode[] {
  const root: UbbNode[] = [];
  const stack: { tag: UbbTag; buffer: UbbNode[] }[] = [];
  let index = 0;
  let pending = "";

  const currentChildren = (): UbbNode[] => (stack.length ? stack[stack.length - 1].buffer : root);

  const flushText = () => {
    if (pending) {
      currentChildren().push({ type: "text", text: pending });
      pending = "";
    }
  };

  while (index < source.length) {
    const char = source[index];

    if (char !== "[" || !isTagStart(source, index)) {
      pending += char;
      index += 1;
      continue;
    }

    const scanned = scanTag(source, index + 1);
    const parsed = scanned ? parseTag(scanned.inner) : null;
    if (!scanned || !parsed) {
      pending += char;
      index += 1;
      continue;
    }

    const rawText = source.slice(index, scanned.end + 1);
    flushText();

    if (parsed.closing) {
      let depth = -1;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag.name === parsed.name) {
          depth = i;
          break;
        }
      }
      if (depth === -1) {
        // Stray close tag: keep it visible rather than guessing an owner.
        currentChildren().push({ type: "text", text: rawText });
      } else {
        while (stack.length > depth + 1) {
          const frame = stack.pop()!;
          frame.tag.autoClosed = true;
          frame.tag.children = frame.buffer;
          currentChildren().push(frame.tag);
        }
        const frame = stack.pop()!;
        frame.tag.children = frame.buffer;
        currentChildren().push(frame.tag);
      }
      index = scanned.end + 1;
      continue;
    }

    const tag = makeTag(parsed, rawText);

    if (RAW_TAGS.has(parsed.name)) {
      const close = findCloseIndex(source, scanned.end + 1, parsed.name);
      if (close) {
        tag.raw = source.slice(scanned.end + 1, close.start);
        stack.push({ tag, buffer: [] });
        // Close it immediately: the body is data, not markup.
        const frame = stack.pop()!;
        frame.tag.children = frame.buffer;
        currentChildren().push(frame.tag);
        index = close.end + 1;
        continue;
      }
    }

    if (isVoidTag(parsed.name)) {
      currentChildren().push(tag);
      index = scanned.end + 1;
      continue;
    }

    stack.push({ tag, buffer: [] });
    index = scanned.end + 1;
  }

  flushText();
  while (stack.length) {
    const frame = stack.pop()!;
    frame.tag.autoClosed = true;
    frame.tag.children = frame.buffer;
    currentChildren().push(frame.tag);
  }
  return root;
}

/** Plain-text projection, handy for search snippets and notification previews. */
export function ubbToPlainText(source: string): string {
  const walk = (nodes: UbbNode[]): string =>
    nodes
      .map((node) => {
        if (node.type === "text") return node.text;
        const name = node.name;
        if (EMOTION_NAME.test(name) || name === "img") return " ";
        if (node.children.length) return walk(node.children);
        if (isRawTag(name)) return node.raw;
        return node.autoClosed ? node.raw : "";
      })
      .join("");
  return walk(parseUbb(source)).replace(/\s+/g, " ").trim();
}
