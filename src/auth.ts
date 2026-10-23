import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "./errors.ts";
import { TOKEN_URL, setupCommand } from "./config.ts";
import { Http } from "./http.ts";
import { record } from "./model.ts";

// Public parameters embedded in CC98 clients; these are not account credentials.
const CLIENT_ID = "9a1fd200-8687-44b1-4c20-08d50a96e5cd";
const CLIENT_SECRET = "8b53f727-08e2-4509-8857-e34bf92b27f2";
export interface Session {
  version: 1;
  session_id: string;
  account: string | null;
  access_token: string;
  refresh_token: string | null;
  expires_at_ms: number | null;
}

function tokenText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let result = value.trim().replace(/^str-/, "");
  if (result.startsWith('"')) {
    try { result = JSON.parse(result) as string; } catch { return null; }
  }
  if (typeof result !== "string") return null;
  result = result.replace(/^Bearer\s+/i, "");
  if (!result || result.length > 16_384 || /[\s\r\n]/.test(result)) return null;
  return result;
}

export function importedSession(value: unknown): Session {
  const row = record(value);
  const access = tokenText(row.access_token ?? row.accessToken);
  const refresh = tokenText(row.refresh_token ?? row.refreshToken);
  if (!access) throw new AppError("INVALID_SESSION", "导入数据缺少有效 access_token／accessToken。");
  const rawExpiry = row.expires_at_ms ?? row.expires_at ?? row.accessToken_expirationTime;
  const expiry = typeof rawExpiry === "string" ? Number(rawExpiry.replace(/^str-/, "")) : Number(rawExpiry);
  const expiresAt = Number.isFinite(expiry) && expiry > 0 ? (expiry < 1e12 ? expiry * 1000 : expiry) : null;
  return {
    version: 1, session_id: randomUUID(),
    account: typeof row.account === "string" ? row.account.slice(0, 80) : null,
    access_token: access, refresh_token: refresh, expires_at_ms: expiresAt,
  };
}

export class SessionStore {
  readonly directory: string;
  readonly path: string;
  constructor(directory: string) { this.directory = directory; this.path = join(directory, "session.json"); }
  async load(): Promise<Session | null> {
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new AppError("STORAGE_ERROR", "无法读取本地 CC98 登录状态。");
    }
    try {
      const row = record(JSON.parse(raw));
      if (row.version !== 1 || typeof row.session_id !== "string" || !tokenText(row.access_token) ||
          !(row.expires_at_ms === null || (typeof row.expires_at_ms === "number" && Number.isFinite(row.expires_at_ms)))) throw new Error();
      return row as unknown as Session;
    } catch { throw new AppError("INVALID_SESSION", "登录状态文件无效，请在本机重新配置登录。"); }
  }
  async save(session: Session): Promise<void> {
    const temporary = join(this.directory, `.session-${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(session) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } catch { throw new AppError("STORAGE_ERROR", "保存本地 CC98 登录状态失败。"); }
    finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
  async clear(): Promise<void> { await rm(this.path, { force: true }); }
}

export class Auth {
  readonly store: SessionStore;
  private readonly http: Http;
  private refreshing: Promise<string> | null = null;
  constructor(store: SessionStore, http: Http) { this.store = store; this.http = http; }

  async sessionKey(): Promise<string> { return (await this.store.load())?.session_id ?? "anonymous"; }

  async status() {
    const session = await this.store.load();
    return {
      configured: session !== null, account: session?.account ?? null,
      expires_at: session?.expires_at_ms ? new Date(session.expires_at_ms).toISOString() : null,
      can_refresh: Boolean(session?.refresh_token),
      setup_command: setupCommand(),
      setup: "在插件目录运行 npm run configure；密码只在本机终端输入。也可将会话 JSON 通过 stdin 交给 node runtime/cli.mjs import-session。",
    };
  }

  async login(username: string, password: string): Promise<void> {
    if (!username.trim() || !password) throw new AppError("INVALID_CREDENTIALS", "用户名和密码不能为空。");
    let data: unknown;
    try { data = await this.requestToken({ grant_type: "password", username: username.trim(), password }); }
    catch (error) {
      if (error instanceof AppError && error.details.http_status === 400) throw new AppError("AUTH_REJECTED", "CC98 未接受登录请求，请核对账号或在网页处理验证；不会自动重试密码。");
      throw error;
    }
    const session = this.fromTokenResponse(data, { account: username.trim().slice(0, 80), session_id: randomUUID(), refresh_token: null });
    await this.store.save(session);
  }

  async accessToken(signal?: AbortSignal, rejectedToken?: string): Promise<string> {
    const session = await this.store.load();
    if (!session) throw new AppError("CONFIGURATION_REQUIRED", "尚未配置 CC98 登录。请在本机终端运行 setup_command。", { setup_command: setupCommand() });
    if (rejectedToken && session.access_token !== rejectedToken) return session.access_token;
    if (!rejectedToken && (session.expires_at_ms === null || session.expires_at_ms > Date.now() + 60_000)) return session.access_token;
    if (!session.refresh_token) throw new AppError("AUTH_REQUIRED", "登录已过期且没有刷新令牌，请在本机运行 setup_command。", { setup_command: setupCommand() });
    if (!this.refreshing) {
      this.refreshing = this.refresh(session, signal).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  private async refresh(previous: Session, signal?: AbortSignal): Promise<string> {
    let data: unknown;
    try { data = await this.requestToken({ grant_type: "refresh_token", refresh_token: previous.refresh_token! }, signal); }
    catch (error) {
      if (error instanceof AppError && [400, 401].includes(Number(error.details.http_status))) {
        throw new AppError("AUTH_REQUIRED", "CC98 登录无法自动刷新，请在本机重新配置登录。", { setup_command: setupCommand() });
      }
      throw error;
    }
    const current = await this.store.load();
    if (current?.session_id !== previous.session_id) throw new AppError("SESSION_CHANGED", "登录账号已变化，请重新搜索。");
    // Another process may already have refreshed this session. Never overwrite newer tokens.
    if (current.access_token !== previous.access_token) return current.access_token;
    const updated = this.fromTokenResponse(data, previous);
    await this.store.save(updated);
    return updated.access_token;
  }

  private requestToken(form: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    return this.http.json(TOKEN_URL, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, scope: "cc98-api openid offline_access", ...form }).toString(),
    }, { signal });
  }
  private fromTokenResponse(value: unknown, previous: Pick<Session, "account" | "session_id" | "refresh_token">): Session {
    const row = record(value);
    const access = tokenText(row.access_token);
    const expires = Number(row.expires_in);
    if (!access || !Number.isFinite(expires) || expires <= 0 || expires > 365 * 86400) throw new AppError("SCHEMA_CHANGED", "CC98 令牌响应缺少有效令牌或过期时间。");
    return { version: 1, ...previous, access_token: access, refresh_token: tokenText(row.refresh_token) ?? previous.refresh_token, expires_at_ms: Date.now() + expires * 1000 };
  }
}
