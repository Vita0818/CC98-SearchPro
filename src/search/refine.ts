/**
 * 标题反馈变体（零词库的自适应召回）：
 * 整串查询精确命中过少时，从返回结果的标题里统计「跨帖子高频二字片段」，
 * 把它们作为新的查询路补查。高频片段近似真实词边界——语料自己告诉我们
 * 该怎么切分，无需维护词典。
 */

const HAN_RUN_RE = /\p{Script=Han}{2,}/gu;

export interface RefineOptions {
  /** 片段至少出现在多少个不同标题中才采纳 */
  minTitles?: number;
  /** 最多返回的片段数 */
  max?: number;
}

const DEFAULTS: Required<RefineOptions> = { minTitles: 2, max: 2 };

/**
 * 从标题集合提取高频汉字二字片段。
 * - 按「出现于不同标题数」（df）计频，避免单条标题刷频；
 * - 已包含在完整短语里的片段不返回（整串查询已覆盖）；
 * - 同频按首次出现顺序稳定排序。
 */
export function topTitleBigrams(
  titles: string[],
  full: string,
  options?: RefineOptions,
): string[] {
  const { minTitles, max } = { ...DEFAULTS, ...options };
  const df = new Map<string, number>();
  for (const title of titles) {
    const grams = new Set<string>();
    for (const run of title.match(HAN_RUN_RE) ?? []) {
      for (let i = 0; i + 2 <= run.length; i++) {
        const gram = run.slice(i, i + 2);
        if (!full.includes(gram)) grams.add(gram);
      }
    }
    for (const g of grams) df.set(g, (df.get(g) ?? 0) + 1);
  }
  return [...df.entries()]
    .filter(([, n]) => n >= minTitles)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([g]) => g);
}
