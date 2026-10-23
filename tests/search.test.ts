import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../src/errors.ts";
import { SearchEngine } from "../src/search/engine.ts";
import { queryPlan, rank } from "../src/search/rank.ts";
import { generateVariants } from "../src/search/queryVariants.ts";
import { FakeForum, post, topic } from "./helpers.ts";

test("Chinese recall variants and explicit segmentation retain the original phrase", () => {
  assert.deepEqual(generateVariants("考研经验"), ["考研经验", "考研", "经验"]);
  assert.deepEqual(queryPlan(" 深度  学习 ", ["深度", "学习"]).variants, ["深度 学习", "深度", "学习"]);
  assert.equal(rank(topic(1, "深度理解机器学习"), queryPlan("深度学习", ["深度", "学习"])).tier, "all-words-title");
});

test("merges recall, verifies bodies, keeps topic IDs distinct from post IDs, and pages without network", async () => {
  const forum = new FakeForum();
  forum.onSearch = async keyword => keyword === "考研经验"
    ? [topic(1, "考研经验汇总"), topic(2, "复习记录"), topic(3, "今天吃什么")]
    : [topic(1, "考研经验汇总"), topic(4, "经验分享：考研资料")];
  forum.onPosts = async id => [post(id === 2 ? "[b]我的考研经验[/b]分享给大家" : "正文不相关", { id: 9000 + id })];
  const engine = new SearchEngine(forum);
  const found = await engine.search({ keyword: "考研经验", terms: ["考研", "经验"], depth: "quick", limit: 1 });
  assert.equal(found.status, "complete");
  assert.equal(found.total_candidates, 4);
  assert.equal(found.results[0].topic_id, 1);
  assert.equal(found.results[0].match, "exact-title");
  assert.equal(found.next_offset, 1);
  const calls = forum.queries.length + forum.reads.length;
  const page = await engine.results(found.search_id, 1, 10);
  assert.equal(page.results[0].topic_id, 2);
  assert.equal(page.results[0].evidence_post_id, 9002);
  assert.equal(page.results[0].match, "exact-content");
  assert.match(page.results[0].snippet!, /我的考研经验/);
  assert.equal(page.results[1].match, "all-words-title");
  assert.equal(forum.queries.length + forum.reads.length, calls);
  const reused = await engine.search({ keyword: "考研经验", terms: ["考研", "经验"], depth: "quick", limit: 3 });
  assert.equal(reused.search_id, found.search_id);
  assert.equal(reused.cached, true);
  assert.equal(forum.queries.length + forum.reads.length, calls);
  const fresh = await engine.search({ keyword: "考研经验", terms: ["考研", "经验"], depth: "quick", refresh: true });
  assert.notEqual(fresh.search_id, found.search_id);
});

test("date range includes the final Beijing day, reports unknown timezone, and keeps board restriction", async () => {
  const forum = new FakeForum();
  forum.onSearch = async (_keyword, boardId) => {
    assert.equal(boardId, 88);
    return [
      topic(1, "考研", { time: "2026-09-30T16:00:00Z" }),
      topic(2, "考研", { time: "2026-10-01T15:59:59Z" }),
      topic(3, "考研", { time: "2026-10-01T16:00:00Z" }),
      topic(4, "考研", { time: "2026-10-01T12:00:00" }),
      topic(5, "考研", { time: "2026-10-01T10:00:00Z", boardId: 99 }),
    ];
  };
  const found = await new SearchEngine(forum).search({ keyword: "考研", board_id: 88, created_after: "2026-10-01", created_before: "2026-10-01", depth: "quick" });
  assert.deepEqual(found.results.map(t => t.topic_id), [2, 1]);
  assert.equal(found.coverage.unknown_dates, 1);
  assert.equal(found.coverage.filtered_out, 2);
  assert.equal(found.coverage.exhaustive, false);
});

test("invalid calendar dates fail before any request", async () => {
  const forum = new FakeForum();
  const engine = new SearchEngine(forum);
  await assert.rejects(engine.search({ keyword: "test", created_after: "2026-02-30" }), (e: AppError) => e.code === "INVALID_DATE");
  await assert.rejects(engine.search({ keyword: "test", created_after: "2026-10-02", created_before: "2026-10-01" }), (e: AppError) => e.code === "INVALID_DATE");
  assert.equal(forum.queries.length, 0);
});

test("a limit during recall returns already collected results without claiming completion", async () => {
  const forum = new FakeForum();
  forum.onSearch = async keyword => {
    if (keyword !== "考研经验") throw new AppError("RATE_LIMITED", "暂时限流");
    return [topic(1, "考研经验")];
  };
  const found = await new SearchEngine(forum).search({ keyword: "考研经验", depth: "quick" });
  assert.equal(found.status, "partial");
  assert.equal(found.stop_reason?.code, "RATE_LIMITED");
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].first_post_verification, "not_checked");
  assert.equal(forum.reads.length, 0);
});

test("unavailable bodies are distinct from verification; inaccessible topics do not abort other checks", async () => {
  const forum = new FakeForum();
  forum.onSearch = async () => [topic(1), topic(2)];
  forum.onPosts = async id => {
    if (id === 1) throw new AppError("FORBIDDEN", "无权限");
    return [post("test 内容", { floor: 2 })];
  };
  const found = await new SearchEngine(forum).search({ keyword: "test", depth: "quick" });
  assert.equal(found.status, "complete");
  assert.equal(found.results[0].topic_id, 2);
  assert.equal(found.results[0].evidence_floor, 2);
  assert.equal(found.results[1].first_post_verification, "unavailable");
  assert.equal(found.coverage.first_posts_checked, 1);
  assert.equal(found.coverage.first_posts_unavailable, 1);
});

test("snapshots expire and cannot be read after changing the account", async () => {
  const forum = new FakeForum();
  forum.onSearch = async () => [topic(1)];
  const engine = new SearchEngine(forum);
  const found = await engine.search({ keyword: "test", depth: "quick" });
  forum.session = "account-two";
  await assert.rejects(engine.results(found.search_id), (e: AppError) => e.code === "SESSION_CHANGED");
  const expiring = new SearchEngine(forum, { ttlMs: 1 });
  const old = await expiring.search({ keyword: "test", depth: "quick" });
  await delay(5);
  await assert.rejects(expiring.results(old.search_id), (e: AppError) => e.code === "SEARCH_EXPIRED");
});

test("account switches during a search do not return the previous account's data", async () => {
  const forum = new FakeForum();
  forum.onSearch = async () => { forum.session = "another-account"; return [topic(1)]; };
  await assert.rejects(new SearchEngine(forum).search({ keyword: "test" }), (e: AppError) => e.code === "SESSION_CHANGED");
});

test("deadline preserves completed recall; client cancellation rejects the operation", async () => {
  const forum = new FakeForum();
  forum.onSearch = async () => [topic(1)];
  forum.onPosts = async (_id, _from, _size, signal) => { await delay(1000, undefined, { signal }); return []; };
  const found = await new SearchEngine(forum, { timeLimitMs: 15 }).search({ keyword: "test" });
  assert.equal(found.status, "partial");
  assert.equal(found.stop_reason?.code, "TIME_BUDGET");
  assert.equal(found.results.length, 1);
  const controller = new AbortController();
  const operation = new SearchEngine(forum).search({ keyword: "test" }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(operation, (e: AppError) => e.code === "CANCELLED");
});

test("recall pages, verification and request count stay within the chosen depth", async () => {
  const forum = new FakeForum();
  forum.onSearch = async (_keyword, _board, from) => Array.from({ length: 20 }, (_, i) => topic(from + i + 1, "测试内容"));
  forum.onPosts = async () => [post("测试内容")];
  const found = await new SearchEngine(forum).search({ keyword: "测试", depth: "quick" });
  assert.equal(forum.queries.length, 1);
  assert.equal(forum.reads.length, 5);
  assert.equal(found.total_candidates, 20);
  assert.ok(found.coverage.limits_reached.includes("verification_cap"));
  assert.ok(found.coverage.limits_reached.includes("search_page_cap:测试"));
  assert.equal(found.coverage.api_calls, 6);
});

test("feedback broadens recall without giving unrelated titles a positive match", async () => {
  const forum = new FakeForum();
  forum.onSearch = async keyword => keyword === "深度学习"
    ? [topic(1, "机器学习入门"), topic(2, "机器学习实战")]
    : keyword === "机器" ? [topic(3, "机器维修")] : [];
  const found = await new SearchEngine(forum).search({ keyword: "深度学习", terms: ["深度", "学习"] });
  assert.ok(forum.queries.some(q => q.keyword === "机器"));
  assert.equal(found.results.find(t => t.topic_id === 3)?.match, "weak");
});
