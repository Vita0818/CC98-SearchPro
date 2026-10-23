#!/usr/bin/env node
import { Auth, importedSession, SessionStore } from "./auth.ts";
import { Client } from "./client.ts";
import { dataDirectory } from "./config.ts";
import { AppError, safeError } from "./errors.ts";
import { Http } from "./http.ts";
import { record } from "./model.ts";

async function stdinJson(): Promise<unknown> {
  if (process.stdin.isTTY) throw new AppError("STDIN_REQUIRED", "会话或凭据必须通过标准输入传入；交互登录请运行 npm run configure。");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of process.stdin) {
    const chunk = Buffer.from(raw as Buffer);
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new AppError("INPUT_TOO_LARGE", "输入超过 64 KiB。");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AppError("INVALID_JSON", "标准输入必须是有效 JSON。"); }
}

async function main() {
  const http = new Http();
  const auth = new Auth(new SessionStore(dataDirectory()), http);
  const client = new Client(auth, http);
  switch (process.argv[2]) {
    case "login": {
      if (!process.argv.includes("--stdin")) throw new AppError("STDIN_REQUIRED", "交互登录请运行 npm run configure。");
      const input = record(await stdinJson());
      if (typeof input.username !== "string" || typeof input.password !== "string") throw new AppError("INVALID_CREDENTIALS", "缺少用户名或密码。");
      await auth.login(input.username, input.password);
      return { ok: true, message: "登录状态已保存；未保存密码。", ...(await auth.status()) };
    }
    case "import-session": {
      const session = importedSession(await stdinJson());
      await auth.store.save(session);
      return { ok: true, message: "会话已导入。运行 npm run status 验证有效性。" };
    }
    case "logout": await auth.store.clear(); return { ok: true, message: "已删除本插件的本地会话。" };
    case "status": {
      const status = await auth.status();
      if (!process.argv.includes("--check") || !status.configured) return status;
      const me = await client.me();
      return { ...status, authenticated: true, user: { id: me.id, name: me.name } };
    }
    default: return { commands: ["npm run configure", "node runtime/cli.mjs status [--check]", "node runtime/cli.mjs import-session < session.json", "node runtime/cli.mjs logout"] };
  }
}
main().then(result => process.stdout.write(JSON.stringify(result, null, 2) + "\n")).catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, error: safeError(error) }) + "\n"); process.exitCode = 1;
});
