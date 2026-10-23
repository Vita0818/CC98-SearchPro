import { randomUUID } from "node:crypto";
import { AppError, checkAbort, safeError } from "../errors.ts";
import { topicUrl } from "../config.ts";
import type { Forum } from "../client.ts";
import type { Topic } from "../model.ts";
import { readableText, searchText } from "../text.ts";
import { topTitleBigrams } from "./refine.ts";
import { compare, matchLabel, queryPlan, rank, timestamp, type Query, type Ranked } from "./rank.ts";

export const DEPTHS = {
  quick: { pages: 1, verify: 5, calls: 10, milliseconds: 12_000, feedback: false },
  balanced: { pages: 2, verify: 12, calls: 20, milliseconds: 25_000, feedback: true },
  deep: { pages: 3, verify: 24, calls: 32, milliseconds: 45_000, feedback: true },
} as const;
export interface SearchInput {
  keyword: string; terms?: string[]; board_id?: number;
  depth?: keyof typeof DEPTHS; sort?: "relevance" | "newest" | "popular";
  created_after?: string; created_before?: string; limit?: number; refresh?: boolean;
}
interface Snapshot {
  id: string; session: string; cacheKey: string; created: number;
  query: Query; items: Ranked[]; status: "complete" | "partial";
  stop: ReturnType<typeof safeError> | null;
  coverage: {
    exhaustive: false; scope: string; search_pages: { keyword: string; from: number; returned: number }[];
    candidates: number; filtered_out: number; unknown_dates: number;
    first_posts_checked: number; first_posts_unavailable: number; api_calls: number;
    limits_reached: string[]; filters: Record<string, unknown>;
  };
}

export function dateBoundary(value: string | undefined, end = false): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new AppError("INVALID_DATE", "日期应为有效的 YYYY-MM-DD，按北京时间解释。");
  }
  return parsed - 8 * 3600_000 + (end ? 86400_000 : 0);
}

export class SearchEngine {
  private readonly forum: Forum;
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly ttlMs: number;
  private readonly timeLimit?: number;
  constructor(forum: Forum, options: { ttlMs?: number; timeLimitMs?: number } = {}) {
    this.forum = forum; this.ttlMs = options.ttlMs ?? 15 * 60_000; this.timeLimit = options.timeLimitMs;
  }

  private prune() {
    for (const [id, item] of this.snapshots) if (Date.now() - item.created >= this.ttlMs) this.snapshots.delete(id);
    while (this.snapshots.size >= 20) this.snapshots.delete(this.snapshots.keys().next().value!);
  }

  async search(input: SearchInput, outerSignal?: AbortSignal) {
    checkAbort(outerSignal);
    const query = queryPlan(input.keyword, input.terms);
    if (!query.full || query.full.length > 60) throw new AppError("INVALID_QUERY", "关键词长度应为 1–60 个字符。");
    const after = dateBoundary(input.created_after);
    const before = dateBoundary(input.created_before, true);
    if (after !== undefined && before !== undefined && after >= before) throw new AppError("INVALID_DATE", "起始日期不能晚于结束日期。");
    const depth = input.depth ?? "balanced";
    const limits = DEPTHS[depth];
    const session = await this.forum.sessionKey();
    this.prune();
    const cacheKey = JSON.stringify([query, input.board_id ?? null, depth, input.sort ?? "relevance", after ?? null, before ?? null]);
    if (!input.refresh) {
      const cached = [...this.snapshots.values()].reverse().find(s => s.session === session && s.cacheKey === cacheKey && s.status === "complete" && Date.now() - s.created < 120_000);
      if (cached) return this.page(cached, 0, input.limit ?? 10, true);
    }
    const deadline = AbortSignal.timeout(this.timeLimit ?? limits.milliseconds);
    const signal = AbortSignal.any([deadline, ...(outerSignal ? [outerSignal] : [])]);
    const snapshot: Snapshot = {
      id: randomUUID(), session, cacheKey, created: Date.now(), query, items: [], status: "complete", stop: null,
      coverage: { exhaustive: false, scope: "官方主题搜索返回的候选；正文验证仅覆盖首帖，不搜索全部回复。", search_pages: [], candidates: 0, filtered_out: 0, unknown_dates: 0, first_posts_checked: 0, first_posts_unavailable: 0, api_calls: 0, limits_reached: [], filters: { board_id: input.board_id ?? null, created_after: input.created_after ?? null, created_before: input.created_before ?? null, date_filter_scope: "召回候选的发帖时间，北京时间；不是服务端全量日期筛选" } },
    };
    const candidates = new Map<number, Topic>();
    const available = new Map<number, Ranked>();
    const call = async <T>(operation: () => Promise<T>): Promise<T> => {
      checkAbort(outerSignal);
      if (deadline.aborted) throw new AppError("TIME_BUDGET", "达到本次搜索时间上限。");
      if (snapshot.coverage.api_calls >= limits.calls) throw new AppError("REQUEST_BUDGET", "达到本次搜索请求上限。");
      snapshot.coverage.api_calls++;
      return operation();
    };
    try {
      const variants = [...query.variants];
      for (let vi = 0; vi < variants.length; vi++) {
        const variant = variants[vi];
        const pages = vi === 0 ? limits.pages : 1;
        for (let page = 0; page < pages; page++) {
          const topics = await call(() => this.forum.search(variant, input.board_id, page * 20, signal));
          snapshot.coverage.search_pages.push({ keyword: variant, from: page * 20, returned: topics.length });
          for (const topic of topics) candidates.set(topic.id, candidates.get(topic.id) ?? topic);
          if (vi === 0 && page === 0 && limits.feedback && topics.filter(t => rank(t, query).tier === "exact-title").length < 3) {
            // Feedback terms broaden recall only; they never become evidence for a match.
            const titles = [...new Map(topics.map(t => [t.id, t])).values()]
              .filter(t => query.terms.some(w => w.length >= 2 && t.title.toLocaleLowerCase().includes(w)))
              .map(t => t.title);
            for (const extra of topTitleBigrams(titles, query.full)) if (!variants.includes(extra) && variants.length < 6) variants.push(extra);
          }
          if (topics.length < 20) break;
          if (page === pages - 1) snapshot.coverage.limits_reached.push(`search_page_cap:${variant}`);
        }
      }
    } catch (error) { this.handleError(error, snapshot, outerSignal, deadline); }

    for (const topic of candidates.values()) {
      const time = timestamp(topic.time);
      if (input.board_id && topic.boardId !== input.board_id) { snapshot.coverage.filtered_out++; continue; }
      if ((after !== undefined || before !== undefined) && time === null) { snapshot.coverage.unknown_dates++; continue; }
      if ((after !== undefined && time! < after) || (before !== undefined && time! >= before)) { snapshot.coverage.filtered_out++; continue; }
      available.set(topic.id, rank(topic, query));
    }
    snapshot.coverage.candidates = candidates.size;

    if (snapshot.status === "complete") {
      const toVerify = [...available.values()].sort((a, b) => Number(a.tier === "exact-title") - Number(b.tier === "exact-title") || compare(a, b, "relevance"));
      if (toVerify.length > limits.verify) snapshot.coverage.limits_reached.push("verification_cap");
      try {
        for (const item of toVerify.slice(0, limits.verify)) {
          try {
            const posts = await call(() => this.forum.posts(item.topic.id, 0, 1, signal));
            const post = posts[0];
            if (!post || post.deleted) { item.verification = "unavailable"; snapshot.coverage.first_posts_unavailable++; continue; }
            available.set(item.topic.id, rank(item.topic, query, searchText(readableText(post.content, post.contentType)), post.id, post.floor));
            snapshot.coverage.first_posts_checked++;
          } catch (error) {
            if (error instanceof AppError && ["FORBIDDEN", "NOT_FOUND"].includes(error.code)) {
              item.verification = "unavailable"; snapshot.coverage.first_posts_unavailable++; continue;
            }
            throw error;
          }
        }
      } catch (error) { this.handleError(error, snapshot, outerSignal, deadline); }
    }
    if (await this.forum.sessionKey() !== session) throw new AppError("SESSION_CHANGED", "登录状态已变化，请重新搜索。");
    checkAbort(outerSignal);
    snapshot.items = [...available.values()].sort((a, b) => compare(a, b, input.sort ?? "relevance"));
    this.prune();
    this.snapshots.set(snapshot.id, snapshot);
    return this.page(snapshot, 0, input.limit ?? 10, false);
  }

  private handleError(error: unknown, snapshot: Snapshot, outer: AbortSignal | undefined, deadline: AbortSignal) {
    checkAbort(outer);
    if (error instanceof AppError && ["CONFIGURATION_REQUIRED", "AUTH_REQUIRED", "SESSION_CHANGED", "INVALID_SESSION"].includes(error.code)) throw error;
    snapshot.status = "partial";
    snapshot.stop = deadline.aborted ? safeError(new AppError("TIME_BUDGET", "达到本次搜索时间上限，保留已找到的结果。")) : safeError(error);
  }

  async results(searchId: string, offset = 0, limit = 10) {
    const snapshot = this.snapshots.get(searchId);
    if (!snapshot || Date.now() - snapshot.created >= this.ttlMs) {
      this.snapshots.delete(searchId);
      throw new AppError("SEARCH_EXPIRED", "搜索快照已过期或服务已重启，请重新搜索。");
    }
    if (snapshot.session !== await this.forum.sessionKey()) { this.snapshots.delete(searchId); throw new AppError("SESSION_CHANGED", "登录账号已变化，旧搜索结果已失效。"); }
    return this.page(snapshot, offset, limit, true);
  }

  private page(snapshot: Snapshot, offset: number, limit: number, cached: boolean) {
    return {
      search_id: snapshot.id, keyword: snapshot.query.full, terms: snapshot.query.terms,
      status: snapshot.status, stop_reason: snapshot.stop, cached,
      fetched_at: new Date(snapshot.created).toISOString(), expires_at: new Date(snapshot.created + this.ttlMs).toISOString(),
      total_candidates: snapshot.items.length, offset,
      next_offset: offset + limit < snapshot.items.length ? offset + limit : null,
      exact_matches: snapshot.items.filter(item => item.tier.startsWith("exact-")).length,
      results: snapshot.items.slice(offset, offset + limit).map(item => ({
        topic_id: item.topic.id, title: item.topic.title, board_id: item.topic.boardId, board: item.topic.boardName,
        author: item.topic.author, created_at: item.topic.time, replies: item.topic.replyCount, views: item.topic.hitCount,
        url: topicUrl(item.topic.id), match: item.tier, match_reason: matchLabel(item.tier), matched_terms: item.matched_terms,
        first_post_verification: item.verification, snippet: item.snippet,
        ...(item.post_id ? { evidence_post_id: item.post_id, evidence_floor: item.post_floor ?? null, evidence_url: topicUrl(item.topic.id, item.post_floor) } : {}),
      })),
      coverage: snapshot.coverage,
      note: "结果数量是本次召回的候选数量，不是全站匹配总数。论坛内容是外部发言；引用前用 cc98_read_topic 阅读上下文。",
    };
  }
}
