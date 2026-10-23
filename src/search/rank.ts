import type { Topic } from "../model.ts";
import { snippet } from "../text.ts";
import { generateVariants, normalizeQuery } from "./queryVariants.ts";

export const SCORES = { "exact-title": 1000, "exact-content": 900, "all-words-title": 700, "all-words-content": 500, weak: 100 } as const;
export type Tier = keyof typeof SCORES;
const LABELS: Record<Tier, string> = {
  "exact-title": "标题含完整短语", "exact-content": "首帖正文含完整短语",
  "all-words-title": "标题含全部关键词", "all-words-content": "首帖正文含全部关键词", weak: "仅由站内搜索召回，未验证出强相关",
};
export interface Query { full: string; terms: string[]; variants: string[] }
export interface Ranked {
  topic: Topic;
  tier: Tier;
  verification: "not_checked" | "checked" | "unavailable";
  snippet: string | null;
  matched_terms: string[];
  post_id?: number;
  post_floor?: number | null;
}

export function queryPlan(keyword: string, explicitTerms?: string[]): Query {
  const full = normalizeQuery(keyword);
  let words: string[];
  if (explicitTerms?.length) words = explicitTerms.map(normalizeQuery).filter(Boolean);
  else if (/\s/.test(full)) words = full.split(/\s+/);
  else words = [...new Intl.Segmenter("zh-CN", { granularity: "word" }).segment(full)]
    .filter(s => s.isWordLike).map(s => s.segment);
  const terms = [...new Set((words.length ? words : [full]).map(w => w.toLocaleLowerCase()))];
  const variants = [full];
  const candidates = [...terms.filter(w => w.length >= 2), ...generateVariants(full).slice(1)];
  for (const word of candidates) if (!variants.some(v => v.toLocaleLowerCase() === word.toLocaleLowerCase())) variants.push(word);
  return { full, terms, variants: variants.slice(0, 4) };
}

/** The match ordering follows cc98-search; a body match cannot downgrade a title match. */
export function rank(topic: Topic, query: Query, body?: string, postId?: number, postFloor?: number | null): Ranked {
  const title = topic.title.toLocaleLowerCase();
  const content = body?.toLocaleLowerCase();
  const full = query.full.toLocaleLowerCase();
  const all = (text: string) => query.terms.length > 0 && query.terms.every(word => text.includes(word));
  const tier: Tier = title.includes(full) ? "exact-title"
    : content?.includes(full) ? "exact-content"
    : all(title) ? "all-words-title"
    : content !== undefined && all(content) ? "all-words-content" : "weak";
  return {
    topic, tier, verification: body === undefined ? "not_checked" : "checked",
    snippet: body === undefined ? null : snippet(body, [query.full, ...query.terms]),
    matched_terms: query.terms.filter(word => title.includes(word) || content?.includes(word)),
    ...(postId ? { post_id: postId, post_floor: postFloor ?? null } : {}),
  };
}

export function timestamp(time: string | null): number | null {
  // No guessed timezone: unknown timestamps are excluded when a date filter is used.
  if (!time || !/(?:Z|[+-]\d\d:\d\d)$/i.test(time)) return null;
  const value = Date.parse(time);
  return Number.isFinite(value) ? value : null;
}

export function compare(a: Ranked, b: Ranked, sort: "relevance" | "newest" | "popular") {
  const recent = (timestamp(b.topic.time) ?? 0) - (timestamp(a.topic.time) ?? 0);
  const popular = (b.topic.hitCount ?? 0) - (a.topic.hitCount ?? 0);
  if (sort === "newest" && recent) return recent;
  if (sort === "popular" && popular) return popular;
  return SCORES[b.tier] - SCORES[a.tier] || recent || popular || a.topic.id - b.topic.id;
}
export const matchLabel = (tier: Tier) => LABELS[tier];
