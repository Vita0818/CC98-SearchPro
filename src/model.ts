import { AppError } from "./errors.ts";

export type Raw = Record<string, unknown>;
export interface Topic {
  id: number;
  title: string;
  boardId: number | null;
  boardName: string | null;
  author: string | null;
  time: string | null;
  replyCount: number | null;
  hitCount: number | null;
}
export interface Post {
  id: number;
  floor: number | null;
  author: string | null;
  time: string | null;
  content: string;
  contentType: number;
  deleted: boolean;
  total: number | null;
}

export function record(value: unknown): Raw {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("SCHEMA_CHANGED", "CC98 返回的数据结构无法识别。");
  }
  return value as Raw;
}
export function positiveId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError("INVALID_ID", "编号应为正整数。");
  return id;
}
export const optionalNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const optionalText = (value: unknown, max = 300): string | null =>
  typeof value === "string" ? value.slice(0, max) : null;

export function list(value: unknown, key?: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (key && value && typeof value === "object" && Array.isArray((value as Raw)[key])) return (value as Raw)[key] as unknown[];
  throw new AppError("SCHEMA_CHANGED", "CC98 列表格式发生变化，不能把异常当成无结果。");
}
export function topicFrom(value: unknown): Topic {
  const row = record(value);
  if (typeof row.title !== "string") throw new AppError("SCHEMA_CHANGED", "主题缺少标题。");
  return {
    id: positiveId(row.id), title: row.title.slice(0, 500),
    boardId: optionalNumber(row.boardId), boardName: optionalText(row.boardName),
    author: row.isAnonymous ? "匿名" : optionalText(row.userName, 80),
    time: optionalText(row.time), replyCount: optionalNumber(row.replyCount), hitCount: optionalNumber(row.hitCount),
  };
}
export function postFrom(value: unknown): Post {
  const row = record(value);
  if (typeof row.content !== "string" && row.isDeleted !== true) throw new AppError("SCHEMA_CHANGED", "楼层缺少正文。");
  return {
    id: positiveId(row.id), floor: optionalNumber(row.floor),
    author: row.isAnonymous ? "匿名" : optionalText(row.userName, 80), time: optionalText(row.time),
    content: row.isDeleted === true ? "（已删除）" : String(row.content),
    contentType: Number(row.contentType ?? 0), deleted: row.isDeleted === true, total: optionalNumber(row.length),
  };
}
