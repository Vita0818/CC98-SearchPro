/**
 * 查询变体生成：绕过服务端错误切分，用多路查询提升召回。
 *
 * 策略（零词库）：
 * - 完整短语优先（用户直觉语义）；
 * - 有空格：按空格拆词逐个补查；
 * - 无空格的连写中文：把汉字连续段按「假设两字词」切成不重叠二元切片
 *   补查。切片可能跨界产生噪音，但下游有本地验证重排兜底。
 */

/** 匹配连续汉字段（至少 2 字） */
const HAN_RUN_RE = /\p{Script=Han}{2,}/gu;

export interface VariantOptions {
  /** 除整串外最多追加的变体数（单词或汉字切片） */
  maxWordVariants?: number;
  /** 参与拆查的最小词长（过短词噪音大） */
  minWordLength?: number;
}

const DEFAULTS: Required<VariantOptions> = {
  maxWordVariants: 3,
  minWordLength: 2,
};

export function normalizeQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * 把单个汉字连续段切成不重叠的二字切片。
 * - 长度 <4 不切（2~3 字大概率是完整词）；
 * - 恰好 4 字取头尾两片（最常见「双词复合」形态，如 考研经验→考研/经验）；
 * - 更长按位置不重叠推进，奇数长度时末尾补一个跨界的尾字切片
 *   （如 abcde→ab/cd/de，de 兜住末尾成词的可能）。
 */
export function hanRunSlices(run: string): string[] {
  if (run.length < 4) return [];
  if (run.length === 4) return [run.slice(0, 2), run.slice(2, 4)];
  const out: string[] = [];
  for (let i = 0; i + 2 <= run.length; i += 2) {
    out.push(run.slice(i, i + 2));
  }
  if (run.length % 2 === 1) out.push(run.slice(run.length - 2));
  return [...new Set(out)];
}

export function generateVariants(
  raw: string,
  options?: VariantOptions,
): string[] {
  const { maxWordVariants, minWordLength } = { ...DEFAULTS, ...options };
  const full = normalizeQuery(raw);
  if (!full) return [];

  const extras: string[] = [];
  const seen = new Set([full.toLowerCase()]);
  const push = (w: string): void => {
    const k = w.toLowerCase();
    // 过短、等于整串或重复的直接排除
    if (w.length < minWordLength || w.length >= full.length || seen.has(k)) {
      return;
    }
    seen.add(k);
    extras.push(w);
  };

  if (full.includes(" ")) {
    const words = full
      .split(" ")
      .map((w) => w.trim())
      // 更长的词更具体，优先补查
      .sort((a, b) => b.length - a.length);
    for (const w of words) push(w);
  } else {
    // 连写输入：汉字段切成二字切片补查（长段优先）
    const runs = (full.match(HAN_RUN_RE) ?? []).sort(
      (a, b) => b.length - a.length,
    );
    for (const run of runs) {
      for (const s of hanRunSlices(run)) push(s);
    }
  }

  return [full, ...extras.slice(0, maxWordVariants)];
}
