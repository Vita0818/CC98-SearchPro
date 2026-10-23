import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/app.ts";
import { importedSession } from "../src/auth.ts";
import { API_ORIGIN } from "../src/config.ts";
import { json, temp } from "./helpers.ts";

test("MCP client can search, page and read; all five tools are read-only and responses omit tokens", async t => {
  let requests = 0;
  const app = buildServer({ dataDir: await temp(t), intervalMs: 0, fetch: async (raw, init) => {
    const url = new URL(raw);
    assert.equal(url.origin, API_ORIGIN);
    assert.equal(init.method ?? "GET", "GET");
    requests++;
    if (url.pathname === "/me") return json({ id: 7, name: "tester" });
    if (url.pathname === "/board/all") return json([{ name: "学习", boards: [{ id: 88, name: "学习天地" }, { id: 99, name: "其他" }] }]);
    if (url.pathname.includes("/topic/search")) return json([1, 2].map(id => ({ id, title: `考研经验${id}`, boardId: 88, boardName: "学习天地", time: "2026-10-01T08:00:00Z", replyCount: 0 })));
    if (/^\/topic\/\d+$/.test(url.pathname)) return json({ id: 1, title: "考研经验1", boardId: 88, replyCount: 0 });
    if (/^\/Topic\/\d+\/post$/.test(url.pathname)) return json([{ id: 991, floor: 1, content: "[b]考研经验[/b]正文", contentType: 0, userName: "tester", length: 1 }]);
    throw new Error("unexpected endpoint");
  } });
  await app.auth.store.save(importedSession({ access_token: "SECRET-ACCESS", refresh_token: "SECRET-REFRESH" }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "test", version: "1" });
  t.after(async () => { await client.close(); await app.server.close(); });
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 5);
  assert.ok(tools.every(tool => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false));
  assert.ok(JSON.stringify(tools).length < 10_000);
  const checked = await client.callTool({ name: "cc98_status", arguments: { check: true } });
  assert.equal(checked.isError, undefined);
  assert.doesNotMatch(JSON.stringify(checked), /SECRET-ACCESS|SECRET-REFRESH/);
  const boards = await client.callTool({ name: "cc98_find_boards", arguments: { keyword: "学习天地" } });
  assert.equal((boards.structuredContent as any).data.boards[0].id, 88);
  const searched = await client.callTool({ name: "cc98_search", arguments: { keyword: "考研经验", depth: "quick", limit: 1, board_id: 88 } });
  assert.equal(searched.isError, undefined);
  const data = (searched.structuredContent as any).data;
  assert.equal(data.results[0].match, "exact-title");
  assert.equal(data.next_offset, 1);
  const before = requests;
  const more = await client.callTool({ name: "cc98_search_results", arguments: { search_id: data.search_id, offset: data.next_offset } });
  assert.equal(requests, before);
  assert.equal((more.structuredContent as any).data.results[0].topic_id, 2);
  const read = await client.callTool({ name: "cc98_read_topic", arguments: { topic: 1 } });
  assert.match((read.structuredContent as any).data.posts[0].content, /考研经验正文/);
  const invalid = await client.callTool({ name: "cc98_search", arguments: { keyword: "test", limit: 5000 } });
  assert.equal(invalid.isError, true);
  await app.auth.store.clear();
  const loggedOut = await client.callTool({ name: "cc98_search_results", arguments: { search_id: data.search_id } });
  assert.equal(loggedOut.isError, true);
  assert.equal((loggedOut.structuredContent as any).error.code, "SESSION_CHANGED");
});

test("real stdio entrypoint handshakes and reports missing login without touching the network", async t => {
  const client = new McpClient({ name: "stdio-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/server.ts", import.meta.url))],
    env: { PATH: process.env.PATH ?? "", CC98_SEARCH_DATA_DIR: await temp(t) }, stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 5);
  const status = await client.callTool({ name: "cc98_status", arguments: {} });
  assert.equal((status.structuredContent as any).data.configured, false);
  const search = await client.callTool({ name: "cc98_search", arguments: { keyword: "test" } });
  assert.equal(search.isError, true);
  assert.equal((search.structuredContent as any).error.code, "CONFIGURATION_REQUIRED");
});
