import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("standalone release runs CLI and authenticated MCP flows without node_modules or source files", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cc98-searchpro-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL("../runtime", import.meta.url)), join(directory, "runtime"), { recursive: true });
  await mkdir(join(directory, "scripts"));
  await cp(fileURLToPath(new URL("../scripts/login.py", import.meta.url)), join(directory, "scripts/login.py"));
  const env = { PATH: process.env.PATH ?? "", CC98_SEARCHPRO_DATA_DIR: join(directory, "state") };
  const imported = spawnSync(process.execPath, [join(directory, "runtime/cli.mjs"), "import-session"], {
    cwd: directory, env, input: JSON.stringify({ access_token: "FIXTURE-ACCESS" }), encoding: "utf8",
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.doesNotMatch(imported.stdout, /FIXTURE-ACCESS/);
  const mock = join(directory, "mock-http.mjs");
  await writeFile(mock, `globalThis.fetch = async (raw, init) => {
    const url = new URL(raw);
    if (url.origin !== 'https://api.cc98.org' || (init.method ?? 'GET') !== 'GET') throw new Error('Unexpected request');
    const topic = {id: 42, title: '考研经验', boardId: 88, time: '2026-10-01T10:00:00+08:00', replyCount: 0};
    let data;
    if (url.pathname === '/me') data = {id: 1, name: 'fixture'};
    else if (url.pathname.startsWith('/topic/search')) data = [topic];
    else if (url.pathname === '/topic/42') data = topic;
    else if (url.pathname === '/Topic/42/post') data = [{id: 1001, floor: 1, content: '[b]考研经验[/b]正文', contentType: 0, length: 1}];
    else throw new Error('Unexpected endpoint');
    return new Response(JSON.stringify(data), {headers: {'content-type': 'application/json'}});
  };`);
  const client = new Client({ name: "standalone-release-test", version: "1" });
  const manifest = JSON.parse(await readFile(new URL("../.mcp.json", import.meta.url), "utf8"));
  const server = manifest.mcpServers["cc98-searchpro"];
  try {
    await client.connect(new StdioClientTransport({ command: server.command, args: ["--import", mock, ...server.args], cwd: join(directory, server.cwd), env, stderr: "pipe" }));
    assert.equal(client.getServerVersion().name, "cc98-searchpro");
    assert.equal((await client.listTools()).tools.length, 5);
    const status = await client.callTool({ name: "cc98_status", arguments: { check: true } });
    assert.equal(status.structuredContent.data.authenticated, true);
    assert.ok(status.structuredContent.data.setup_command.includes(join(directory, "scripts/login.py")));
    const search = await client.callTool({ name: "cc98_search", arguments: { keyword: "考研", depth: "quick" } });
    assert.equal(search.isError, undefined);
    assert.equal(search.structuredContent.data.results[0].topic_id, 42);
    const read = await client.callTool({ name: "cc98_read_topic", arguments: { topic: 42 } });
    assert.equal(read.structuredContent.data.posts[0].content, "考研经验正文");
    assert.doesNotMatch(JSON.stringify([status, search, read]), /FIXTURE-ACCESS/);
  } finally { await client.close(); }
});
