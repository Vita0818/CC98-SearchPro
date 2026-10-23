import { parseUbb, type UbbNode } from "./ubb.ts";

/** Preserve readable text and links; do not render or execute forum markup. */
export function readableText(content: string, contentType = 0): string {
  if (contentType === 1) return content.trim();
  const pending: (UbbNode | string)[] = parseUbb(content).reverse();
  const output: string[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    if (typeof node === "string") { output.push(node); continue; }
    if (node.type === "text") { output.push(node.text); continue; }
    if (/^(?:em\d+|tb\d+|ms\d+|ac\d+|[acf]:\d+)$/.test(node.name)) continue;
    if (["code", "noubb", "md"].includes(node.name) && node.raw && !node.autoClosed) {
      output.push(node.name === "code" ? `\n\`\`\`\n${node.raw}\n\`\`\`\n` : node.raw); continue;
    }
    if (node.name === "line") { output.push("\n---\n"); continue; }
    const block = ["quote", "quotex", "align", "table", "tr"].includes(node.name);
    if (block) { output.push(node.name.startsWith("quote") ? "\n[引用] " : "\n"); pending.push("\n"); }
    if (node.name === "img" || node.name === "upload") output.push(node.name === "img" ? "[图片] " : "[附件] ");
    if (node.name === "url" && node.mainValue) pending.push(` (${node.mainValue})`);
    if (node.children.length) pending.push(...[...node.children].reverse());
    else if (node.autoClosed) output.push(node.raw);
  }
  return output.join("").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function searchText(raw: string): string {
  return raw.replace(/<[^>]+>/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_`#~]/g, "").replace(/\s+/g, " ").trim();
}

/** Adapted from cc98-search's context-snippet extraction. */
export function snippet(text: string, needles: string[], maxLength = 220): string | null {
  const lower = text.toLocaleLowerCase();
  for (const needle of needles) {
    const at = needle ? lower.indexOf(needle.toLocaleLowerCase()) : -1;
    if (at < 0) continue;
    const start = Math.max(0, at - 65);
    const end = Math.min(text.length, start + maxLength);
    return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
  }
  return null;
}
