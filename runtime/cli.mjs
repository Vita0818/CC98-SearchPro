#!/usr/bin/env node
import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);

// src/auth.ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join as join2 } from "node:path";

// src/errors.ts
var AppError = class extends Error {
  code;
  details;
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
};
function safeError(error) {
  if (error instanceof AppError) return { code: error.code, message: error.message, ...error.details };
  return { code: "INTERNAL_ERROR", message: "\u5904\u7406\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u672C\u5730\u914D\u7F6E\u6216\u91CD\u8BD5\u3002" };
}
function checkAbort(signal) {
  if (signal?.aborted) throw new AppError("CANCELLED", "\u64CD\u4F5C\u5DF2\u53D6\u6D88\u3002");
}

// src/config.ts
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var API_ORIGIN = "https://api.cc98.org";
var TOKEN_URL = "https://openid.cc98.org/connect/token";
var SERVER_NAME = "cc98-searchpro";
function setupCommand() {
  const path = fileURLToPath(new URL("../scripts/login.py", import.meta.url));
  return `python3 '${path.replaceAll("'", "'\\''")}'`;
}
function dataDirectory(env = process.env) {
  const explicit = env.CC98_SEARCHPRO_DATA_DIR || env.CC98_SEARCH_DATA_DIR;
  if (explicit) return resolve(explicit);
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const current = join(base, SERVER_NAME);
  const legacy = join(base, "cc98-search-mcp");
  return !existsSync(join(current, "session.json")) && existsSync(join(legacy, "session.json")) ? legacy : current;
}

// src/http.ts
import { setTimeout as delay } from "node:timers/promises";
var Http = class {
  chain = Promise.resolve();
  availableAt = 0;
  fetcher;
  intervalMs;
  timeoutMs;
  maxBytes;
  constructor(options = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.intervalMs = options.intervalMs ?? 400;
    this.timeoutMs = options.timeoutMs ?? 15e3;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  }
  json(url, init = {}, options = {}) {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    if (parsed.username || parsed.password || !(parsed.origin === API_ORIGIN && method === "GET" || url === TOKEN_URL && method === "POST")) {
      throw new AppError("INVALID_REQUEST", "\u4EC5\u5141\u8BB8\u8BFB\u53D6 CC98 API \u6216\u8BF7\u6C42\u767B\u5F55\u4EE4\u724C\u3002");
    }
    const run = this.chain.then(async () => {
      checkAbort(options.signal);
      try {
        const wait = Math.max(0, this.availableAt - Date.now());
        if (wait) await delay(wait, void 0, { signal: options.signal });
        return await this.send(url, init, options);
      } catch (error) {
        if (options.signal?.aborted) throw new AppError("CANCELLED", "\u64CD\u4F5C\u5DF2\u53D6\u6D88\u6216\u8FBE\u5230\u672C\u6B21\u65F6\u95F4\u4E0A\u9650\u3002");
        throw error;
      } finally {
        this.availableAt = Math.max(this.availableAt, Date.now() + this.intervalMs);
      }
    });
    this.chain = run.catch(() => void 0);
    return run;
  }
  async send(url, init, options) {
    const signal = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...options.signal ? [options.signal] : []]);
    let response;
    try {
      response = await this.fetcher(url, { ...init, redirect: "error", signal });
    } catch {
      checkAbort(options.signal);
      throw new AppError("NETWORK_ERROR", "\u65E0\u6CD5\u8FDE\u63A5 CC98\uFF0C\u8BF7\u68C0\u67E5\u6821\u56ED\u7F51\uFF0FVPN \u76F4\u8FDE\u72B6\u6001\u3002");
    }
    const status = response.status;
    if (status === 429 || status === 403 && options.search) {
      const header = response.headers.get("retry-after");
      const seconds = header == null ? NaN : Number(header);
      const wait = Number.isFinite(seconds) ? seconds * 1e3 : header ? Date.parse(header) - Date.now() : 1500;
      const retryMs = Math.max(1500, Math.min(Number.isFinite(wait) ? wait : 1500, 864e5));
      this.availableAt = Math.max(this.availableAt, Date.now() + retryMs);
      await response.body?.cancel();
      throw new AppError("RATE_LIMITED", "\u641C\u7D22\u53D7\u5230\u9650\u6D41\u6216\u88AB\u62D2\u7EDD\uFF0C\u5DF2\u6682\u505C\u540E\u7EED\u8BF7\u6C42\u3002", { retry_after_ms: retryMs });
    }
    if (!response.ok) {
      await response.body?.cancel();
      const code = status === 401 ? "AUTH_REQUIRED" : status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : "UPSTREAM_ERROR";
      throw new AppError(code, status === 401 ? "\u767B\u5F55\u5DF2\u5931\u6548\uFF0C\u8BF7\u5728\u672C\u673A\u91CD\u65B0\u914D\u7F6E\u767B\u5F55\u3002" : `CC98 \u8FD4\u56DE HTTP ${status}\u3002`, { http_status: status });
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AppError("SCHEMA_CHANGED", "CC98 \u8FD4\u56DE\u4E86\u7A7A\u54CD\u5E94\u3002");
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > this.maxBytes) {
          await reader.cancel();
          throw new AppError("RESPONSE_TOO_LARGE", "CC98 \u54CD\u5E94\u8D85\u51FA\u5927\u5C0F\u4E0A\u9650\u3002");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      checkAbort(options.signal);
      throw new AppError("NETWORK_ERROR", "\u8BFB\u53D6 CC98 \u54CD\u5E94\u65F6\u8FDE\u63A5\u4E2D\u65AD\u3002");
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new AppError("SCHEMA_CHANGED", "CC98 \u672A\u8FD4\u56DE\u6709\u6548 JSON\uFF0C\u53EF\u80FD\u5904\u4E8E\u767B\u5F55\u6216\u7F51\u7EDC\u9A8C\u8BC1\u9875\u9762\u3002");
    }
  }
};

// src/model.ts
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("SCHEMA_CHANGED", "CC98 \u8FD4\u56DE\u7684\u6570\u636E\u7ED3\u6784\u65E0\u6CD5\u8BC6\u522B\u3002");
  }
  return value;
}
function positiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError("INVALID_ID", "\u7F16\u53F7\u5E94\u4E3A\u6B63\u6574\u6570\u3002");
  return id;
}
var optionalNumber = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
var optionalText = (value, max = 300) => typeof value === "string" ? value.slice(0, max) : null;
function list(value, key) {
  if (Array.isArray(value)) return value;
  if (key && value && typeof value === "object" && Array.isArray(value[key])) return value[key];
  throw new AppError("SCHEMA_CHANGED", "CC98 \u5217\u8868\u683C\u5F0F\u53D1\u751F\u53D8\u5316\uFF0C\u4E0D\u80FD\u628A\u5F02\u5E38\u5F53\u6210\u65E0\u7ED3\u679C\u3002");
}
function topicFrom(value) {
  const row = record(value);
  if (typeof row.title !== "string") throw new AppError("SCHEMA_CHANGED", "\u4E3B\u9898\u7F3A\u5C11\u6807\u9898\u3002");
  return {
    id: positiveId(row.id),
    title: row.title.slice(0, 500),
    boardId: optionalNumber(row.boardId),
    boardName: optionalText(row.boardName),
    author: row.isAnonymous ? "\u533F\u540D" : optionalText(row.userName, 80),
    time: optionalText(row.time),
    replyCount: optionalNumber(row.replyCount),
    hitCount: optionalNumber(row.hitCount)
  };
}
function postFrom(value) {
  const row = record(value);
  if (typeof row.content !== "string" && row.isDeleted !== true) throw new AppError("SCHEMA_CHANGED", "\u697C\u5C42\u7F3A\u5C11\u6B63\u6587\u3002");
  return {
    id: positiveId(row.id),
    floor: optionalNumber(row.floor),
    author: row.isAnonymous ? "\u533F\u540D" : optionalText(row.userName, 80),
    time: optionalText(row.time),
    content: row.isDeleted === true ? "\uFF08\u5DF2\u5220\u9664\uFF09" : String(row.content),
    contentType: Number(row.contentType ?? 0),
    deleted: row.isDeleted === true,
    total: optionalNumber(row.length)
  };
}

// src/auth.ts
var CLIENT_ID = "9a1fd200-8687-44b1-4c20-08d50a96e5cd";
var CLIENT_SECRET = "8b53f727-08e2-4509-8857-e34bf92b27f2";
function tokenText(value) {
  if (typeof value !== "string") return null;
  let result = value.trim().replace(/^str-/, "");
  if (result.startsWith('"')) {
    try {
      result = JSON.parse(result);
    } catch {
      return null;
    }
  }
  if (typeof result !== "string") return null;
  result = result.replace(/^Bearer\s+/i, "");
  if (!result || result.length > 16384 || /[\s\r\n]/.test(result)) return null;
  return result;
}
function importedSession(value) {
  const row = record(value);
  const access = tokenText(row.access_token ?? row.accessToken);
  const refresh = tokenText(row.refresh_token ?? row.refreshToken);
  if (!access) throw new AppError("INVALID_SESSION", "\u5BFC\u5165\u6570\u636E\u7F3A\u5C11\u6709\u6548 access_token\uFF0FaccessToken\u3002");
  const rawExpiry = row.expires_at_ms ?? row.expires_at ?? row.accessToken_expirationTime;
  const expiry = typeof rawExpiry === "string" ? Number(rawExpiry.replace(/^str-/, "")) : Number(rawExpiry);
  const expiresAt = Number.isFinite(expiry) && expiry > 0 ? expiry < 1e12 ? expiry * 1e3 : expiry : null;
  return {
    version: 1,
    session_id: randomUUID(),
    account: typeof row.account === "string" ? row.account.slice(0, 80) : null,
    access_token: access,
    refresh_token: refresh,
    expires_at_ms: expiresAt
  };
}
var SessionStore = class {
  directory;
  path;
  constructor(directory) {
    this.directory = directory;
    this.path = join2(directory, "session.json");
  }
  async load() {
    let raw;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new AppError("STORAGE_ERROR", "\u65E0\u6CD5\u8BFB\u53D6\u672C\u5730 CC98 \u767B\u5F55\u72B6\u6001\u3002");
    }
    try {
      const row = record(JSON.parse(raw));
      if (row.version !== 1 || typeof row.session_id !== "string" || !tokenText(row.access_token) || !(row.expires_at_ms === null || typeof row.expires_at_ms === "number" && Number.isFinite(row.expires_at_ms))) throw new Error();
      return row;
    } catch {
      throw new AppError("INVALID_SESSION", "\u767B\u5F55\u72B6\u6001\u6587\u4EF6\u65E0\u6548\uFF0C\u8BF7\u5728\u672C\u673A\u91CD\u65B0\u914D\u7F6E\u767B\u5F55\u3002");
    }
  }
  async save(session) {
    const temporary = join2(this.directory, `.session-${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 448 });
      await writeFile(temporary, JSON.stringify(session) + "\n", { encoding: "utf8", mode: 384, flag: "wx" });
      await rename(temporary, this.path);
    } catch {
      throw new AppError("STORAGE_ERROR", "\u4FDD\u5B58\u672C\u5730 CC98 \u767B\u5F55\u72B6\u6001\u5931\u8D25\u3002");
    } finally {
      await rm(temporary, { force: true }).catch(() => void 0);
    }
  }
  async clear() {
    await rm(this.path, { force: true });
  }
};
var Auth = class {
  store;
  http;
  refreshing = null;
  constructor(store, http) {
    this.store = store;
    this.http = http;
  }
  async sessionKey() {
    return (await this.store.load())?.session_id ?? "anonymous";
  }
  async status() {
    const session = await this.store.load();
    return {
      configured: session !== null,
      account: session?.account ?? null,
      expires_at: session?.expires_at_ms ? new Date(session.expires_at_ms).toISOString() : null,
      can_refresh: Boolean(session?.refresh_token),
      setup_command: setupCommand(),
      setup: "\u5728\u63D2\u4EF6\u76EE\u5F55\u8FD0\u884C npm run configure\uFF1B\u5BC6\u7801\u53EA\u5728\u672C\u673A\u7EC8\u7AEF\u8F93\u5165\u3002\u4E5F\u53EF\u5C06\u4F1A\u8BDD JSON \u901A\u8FC7 stdin \u4EA4\u7ED9 node runtime/cli.mjs import-session\u3002"
    };
  }
  async login(username, password) {
    if (!username.trim() || !password) throw new AppError("INVALID_CREDENTIALS", "\u7528\u6237\u540D\u548C\u5BC6\u7801\u4E0D\u80FD\u4E3A\u7A7A\u3002");
    let data;
    try {
      data = await this.requestToken({ grant_type: "password", username: username.trim(), password });
    } catch (error) {
      if (error instanceof AppError && error.details.http_status === 400) throw new AppError("AUTH_REJECTED", "CC98 \u672A\u63A5\u53D7\u767B\u5F55\u8BF7\u6C42\uFF0C\u8BF7\u6838\u5BF9\u8D26\u53F7\u6216\u5728\u7F51\u9875\u5904\u7406\u9A8C\u8BC1\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u91CD\u8BD5\u5BC6\u7801\u3002");
      throw error;
    }
    const session = this.fromTokenResponse(data, { account: username.trim().slice(0, 80), session_id: randomUUID(), refresh_token: null });
    await this.store.save(session);
  }
  async accessToken(signal, rejectedToken) {
    const session = await this.store.load();
    if (!session) throw new AppError("CONFIGURATION_REQUIRED", "\u5C1A\u672A\u914D\u7F6E CC98 \u767B\u5F55\u3002\u8BF7\u5728\u672C\u673A\u7EC8\u7AEF\u8FD0\u884C setup_command\u3002", { setup_command: setupCommand() });
    if (rejectedToken && session.access_token !== rejectedToken) return session.access_token;
    if (!rejectedToken && (session.expires_at_ms === null || session.expires_at_ms > Date.now() + 6e4)) return session.access_token;
    if (!session.refresh_token) throw new AppError("AUTH_REQUIRED", "\u767B\u5F55\u5DF2\u8FC7\u671F\u4E14\u6CA1\u6709\u5237\u65B0\u4EE4\u724C\uFF0C\u8BF7\u5728\u672C\u673A\u8FD0\u884C setup_command\u3002", { setup_command: setupCommand() });
    if (!this.refreshing) {
      this.refreshing = this.refresh(session, signal).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }
  async refresh(previous, signal) {
    let data;
    try {
      data = await this.requestToken({ grant_type: "refresh_token", refresh_token: previous.refresh_token }, signal);
    } catch (error) {
      if (error instanceof AppError && [400, 401].includes(Number(error.details.http_status))) {
        throw new AppError("AUTH_REQUIRED", "CC98 \u767B\u5F55\u65E0\u6CD5\u81EA\u52A8\u5237\u65B0\uFF0C\u8BF7\u5728\u672C\u673A\u91CD\u65B0\u914D\u7F6E\u767B\u5F55\u3002", { setup_command: setupCommand() });
      }
      throw error;
    }
    const current = await this.store.load();
    if (current?.session_id !== previous.session_id) throw new AppError("SESSION_CHANGED", "\u767B\u5F55\u8D26\u53F7\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u641C\u7D22\u3002");
    if (current.access_token !== previous.access_token) return current.access_token;
    const updated = this.fromTokenResponse(data, previous);
    await this.store.save(updated);
    return updated.access_token;
  }
  requestToken(form, signal) {
    return this.http.json(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, scope: "cc98-api openid offline_access", ...form }).toString()
    }, { signal });
  }
  fromTokenResponse(value, previous) {
    const row = record(value);
    const access = tokenText(row.access_token);
    const expires = Number(row.expires_in);
    if (!access || !Number.isFinite(expires) || expires <= 0 || expires > 365 * 86400) throw new AppError("SCHEMA_CHANGED", "CC98 \u4EE4\u724C\u54CD\u5E94\u7F3A\u5C11\u6709\u6548\u4EE4\u724C\u6216\u8FC7\u671F\u65F6\u95F4\u3002");
    return { version: 1, ...previous, access_token: access, refresh_token: tokenText(row.refresh_token) ?? previous.refresh_token, expires_at_ms: Date.now() + expires * 1e3 };
  }
};

// src/client.ts
var Client = class {
  auth;
  http;
  constructor(auth, http) {
    this.auth = auth;
    this.http = http;
  }
  sessionKey() {
    return this.auth.sessionKey();
  }
  async get(path, query = {}, options = {}) {
    const url = new URL(path, API_ORIGIN);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    let token = options.anonymous ? null : await this.auth.accessToken(options.signal);
    let retriedAuth = false;
    let retriedRate = false;
    while (true) {
      try {
        return await this.http.json(url.toString(), { headers: { Accept: "application/json", ...token ? { Authorization: `Bearer ${token}` } : {} } }, options);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        if (error.code === "AUTH_REQUIRED" && token && !retriedAuth) {
          retriedAuth = true;
          token = await this.auth.accessToken(options.signal, token);
          continue;
        }
        if (error.code === "RATE_LIMITED" && !retriedRate) {
          retriedRate = true;
          continue;
        }
        throw error;
      }
    }
  }
  async me(signal) {
    return record(await this.get("/me", {}, { signal }));
  }
  async search(keyword, boardId, from, signal) {
    const path = boardId ? `/topic/search/board/${boardId}` : "/topic/search";
    return list(await this.get(path, { keyword, from, size: 20 }, { search: true, signal }), "topics").map(topicFrom);
  }
  async topic(id, signal) {
    return topicFrom(await this.get(`/topic/${id}`, {}, { signal }));
  }
  async posts(id, from, size, signal) {
    return list(await this.get(`/Topic/${id}/post`, { from, size }, { signal })).map(postFrom);
  }
  async boards(keyword = "", offset = 0, limit = 30, signal) {
    const groups = list(await this.get("/board/all", {}, { anonymous: true, signal }));
    const boards = groups.flatMap((value) => {
      const group = record(value);
      return list(group.boards).map((value2) => {
        const board = record(value2);
        if (!Number.isSafeInteger(board.id) || typeof board.name !== "string") throw new AppError("SCHEMA_CHANGED", "\u7248\u9762\u6570\u636E\u7F3A\u5C11\u7F16\u53F7\u6216\u540D\u79F0\u3002");
        return { id: board.id, name: board.name, group: typeof group.name === "string" ? group.name : null };
      });
    }).filter((b) => !keyword || `${b.name} ${b.group ?? ""}`.toLowerCase().includes(keyword.toLowerCase()));
    return { boards: boards.slice(offset, offset + limit), total: boards.length, next_offset: offset + limit < boards.length ? offset + limit : null };
  }
};

// src/cli.ts
async function stdinJson() {
  if (process.stdin.isTTY) throw new AppError("STDIN_REQUIRED", "\u4F1A\u8BDD\u6216\u51ED\u636E\u5FC5\u987B\u901A\u8FC7\u6807\u51C6\u8F93\u5165\u4F20\u5165\uFF1B\u4EA4\u4E92\u767B\u5F55\u8BF7\u8FD0\u884C npm run configure\u3002");
  const chunks = [];
  let bytes = 0;
  for await (const raw of process.stdin) {
    const chunk = Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new AppError("INPUT_TOO_LARGE", "\u8F93\u5165\u8D85\u8FC7 64 KiB\u3002");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("INVALID_JSON", "\u6807\u51C6\u8F93\u5165\u5FC5\u987B\u662F\u6709\u6548 JSON\u3002");
  }
}
async function main() {
  const http = new Http();
  const auth = new Auth(new SessionStore(dataDirectory()), http);
  const client = new Client(auth, http);
  switch (process.argv[2]) {
    case "login": {
      if (!process.argv.includes("--stdin")) throw new AppError("STDIN_REQUIRED", "\u4EA4\u4E92\u767B\u5F55\u8BF7\u8FD0\u884C npm run configure\u3002");
      const input = record(await stdinJson());
      if (typeof input.username !== "string" || typeof input.password !== "string") throw new AppError("INVALID_CREDENTIALS", "\u7F3A\u5C11\u7528\u6237\u540D\u6216\u5BC6\u7801\u3002");
      await auth.login(input.username, input.password);
      return { ok: true, message: "\u767B\u5F55\u72B6\u6001\u5DF2\u4FDD\u5B58\uFF1B\u672A\u4FDD\u5B58\u5BC6\u7801\u3002", ...await auth.status() };
    }
    case "import-session": {
      const session = importedSession(await stdinJson());
      await auth.store.save(session);
      return { ok: true, message: "\u4F1A\u8BDD\u5DF2\u5BFC\u5165\u3002\u8FD0\u884C npm run status \u9A8C\u8BC1\u6709\u6548\u6027\u3002" };
    }
    case "logout":
      await auth.store.clear();
      return { ok: true, message: "\u5DF2\u5220\u9664\u672C\u63D2\u4EF6\u7684\u672C\u5730\u4F1A\u8BDD\u3002" };
    case "status": {
      const status = await auth.status();
      if (!process.argv.includes("--check") || !status.configured) return status;
      const me = await client.me();
      return { ...status, authenticated: true, user: { id: me.id, name: me.name } };
    }
    default:
      return { commands: ["npm run configure", "node runtime/cli.mjs status [--check]", "node runtime/cli.mjs import-session < session.json", "node runtime/cli.mjs logout"] };
  }
}
main().then((result) => process.stdout.write(JSON.stringify(result, null, 2) + "\n")).catch((error) => {
  process.stderr.write(JSON.stringify({ ok: false, error: safeError(error) }) + "\n");
  process.exitCode = 1;
});
