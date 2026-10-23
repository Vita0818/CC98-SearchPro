import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Forum } from "../src/client.ts";
import type { Post, Topic } from "../src/model.ts";

export async function temp(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "cc98-search-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
export function json(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
export function topic(id: number, title = "普通标题", extra: Partial<Topic> = {}): Topic {
  return { id, title, boardId: 88, boardName: "学习天地", author: "tester", time: "2026-09-01T08:00:00Z", replyCount: 0, hitCount: 10, ...extra };
}
export function post(content: string, extra: Partial<Post> = {}): Post {
  return { id: 999, floor: 1, author: "tester", time: "2026-09-01T08:00:00Z", content, contentType: 0, deleted: false, total: 1, ...extra };
}
export class FakeForum implements Forum {
  session = "account-one";
  queries: { keyword: string; boardId: number | undefined; from: number }[] = [];
  reads: { id: number; from: number; size: number }[] = [];
  onSearch: (keyword: string, boardId: number | undefined, from: number, signal?: AbortSignal) => Promise<Topic[]> = async () => [];
  onPosts: (id: number, from: number, size: number, signal?: AbortSignal) => Promise<Post[]> = async () => [];
  onTopic: (id: number) => Promise<Topic> = async id => topic(id);
  async sessionKey() { return this.session; }
  async search(keyword: string, boardId: number | undefined, from: number, signal?: AbortSignal) {
    this.queries.push({ keyword, boardId, from }); return this.onSearch(keyword, boardId, from, signal);
  }
  async topic(id: number) { return this.onTopic(id); }
  async posts(id: number, from: number, size: number, signal?: AbortSignal) {
    this.reads.push({ id, from, size }); return this.onPosts(id, from, size, signal);
  }
}
