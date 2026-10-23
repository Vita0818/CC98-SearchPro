import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/errors.ts";
import { readTopic, topicId } from "../src/reader.ts";
import { readableText, searchText } from "../src/text.ts";
import { FakeForum, post, topic } from "./helpers.ts";

test("long floors resume exactly and eventually advance to the next floor", async () => {
  const forum = new FakeForum();
  const first = "开始" + "正文🌱".repeat(200) + "结尾";
  const rows = [post(first, { total: 2 }), post("第二楼", { id: 1000, floor: 2, total: 2 })];
  forum.onTopic = async id => topic(id, "长帖", { replyCount: 1 });
  forum.onPosts = async (_id, from, size) => rows.slice(from, from + size);
  let next = { from: 0, content_offset: 0 };
  const chunks: string[] = [];
  const floors: number[] = [];
  for (let i = 0; i < 10; i++) {
    const page = await readTopic(forum, { topic: "https://www.cc98.org/topic/42/1#1", ...next, size: 2, max_characters: 300 });
    for (const entry of page.posts) {
      floors.push(entry.floor as number);
      if (entry.floor === 1) chunks.push(entry.content as string);
      assert.doesNotMatch(entry.content as string, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
    if (!page.next) break;
    next = page.next;
  }
  assert.equal(chunks.join(""), first);
  assert.ok(floors.includes(2));
});

test("UBB conversion preserves links, quoted context, code and unknown text", () => {
  const content = '[b]深度[/b]学习\n[quote, 某人]参考资料[/quote][url=https://example.org]原文[/url][code]a[i] < b[/code]';
  const text = readableText(content);
  assert.match(text, /深度学习/);
  assert.match(text, /\[引用\] 参考资料/);
  assert.match(text, /原文 \(https:\/\/example.org\)/);
  assert.match(text, /a\[i\] < b/);
  assert.equal(searchText(readableText('[color=考研]无关正文[/color]')).includes('考研'), false);
  assert.equal(readableText("# Markdown\n\n`a[i]`", 1), "# Markdown\n\n`a[i]`");
});

test("raw reading keeps original markup and uses server floor number for citations", async () => {
  const forum = new FakeForum();
  forum.onPosts = async () => [post("[b]原文[/b]", { floor: 27, total: 1 })];
  const page = await readTopic(forum, { topic: 42, format: "raw" });
  assert.equal(page.posts[0].content, "[b]原文[/b]");
  assert.equal(page.posts[0].url, "https://www.cc98.org/topic/42/3#7");
});

test("topic links with a page and anchor begin at the referenced floor unless from is supplied", async () => {
  const forum = new FakeForum();
  await readTopic(forum, { topic: "https://www.cc98.org/topic/42/3#7" });
  assert.equal(forum.reads[0].from, 26);
  await readTopic(forum, { topic: "https://www.cc98.org/topic/42/3#7", from: 0 });
  assert.equal(forum.reads[1].from, 0);
  await assert.rejects(readTopic(forum, { topic: "https://www.cc98.org/topic/42/0#1" }), (e: AppError) => e.code === "INVALID_TOPIC");
});

test("rejects arbitrary URLs and invalid continuation offsets", async () => {
  assert.equal(topicId("42"), 42);
  for (const value of ["https://evil.test/topic/42", "https://www.cc98.org@evil.test/topic/42", "file:///topic/42", "https://www.cc98.org/topic/0"]) {
    assert.throws(() => topicId(value), AppError);
  }
  const forum = new FakeForum();
  forum.onPosts = async () => [post("正文")];
  await assert.rejects(readTopic(forum, { topic: 42, content_offset: 30 }), (e: AppError) => e.code === "INVALID_OFFSET");
});
