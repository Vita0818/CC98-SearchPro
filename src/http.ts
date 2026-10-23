import { setTimeout as delay } from "node:timers/promises";
import { AppError, checkAbort } from "./errors.ts";
import { API_ORIGIN, TOKEN_URL } from "./config.ts";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export interface HttpOptions { fetch?: Fetch; intervalMs?: number; timeoutMs?: number; maxBytes?: number }

/** One queue covers search, reading and authentication, including retry cooldowns. */
export class Http {
  private chain: Promise<unknown> = Promise.resolve();
  private availableAt = 0;
  private readonly fetcher: Fetch;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  constructor(options: HttpOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.intervalMs = options.intervalMs ?? 400;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  }

  json(url: string, init: RequestInit = {}, options: { search?: boolean; signal?: AbortSignal } = {}): Promise<unknown> {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    if (parsed.username || parsed.password ||
        !((parsed.origin === API_ORIGIN && method === "GET") || (url === TOKEN_URL && method === "POST"))) {
      throw new AppError("INVALID_REQUEST", "仅允许读取 CC98 API 或请求登录令牌。");
    }
    const run = this.chain.then(async () => {
      checkAbort(options.signal);
      try {
        const wait = Math.max(0, this.availableAt - Date.now());
        if (wait) await delay(wait, undefined, { signal: options.signal });
        return await this.send(url, init, options);
      } catch (error) {
        if (options.signal?.aborted) throw new AppError("CANCELLED", "操作已取消或达到本次时间上限。");
        throw error;
      } finally {
        this.availableAt = Math.max(this.availableAt, Date.now() + this.intervalMs);
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async send(url: string, init: RequestInit, options: { search?: boolean; signal?: AbortSignal }): Promise<unknown> {
    const signal = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(options.signal ? [options.signal] : [])]);
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, redirect: "error", signal });
    } catch {
      checkAbort(options.signal);
      throw new AppError("NETWORK_ERROR", "无法连接 CC98，请检查校园网／VPN 直连状态。");
    }
    const status = response.status;
    if (status === 429 || (status === 403 && options.search)) {
      const header = response.headers.get("retry-after");
      const seconds = header == null ? NaN : Number(header);
      const wait = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : 1500;
      const retryMs = Math.max(1500, Math.min(Number.isFinite(wait) ? wait : 1500, 86400_000));
      this.availableAt = Math.max(this.availableAt, Date.now() + retryMs);
      await response.body?.cancel();
      throw new AppError("RATE_LIMITED", "搜索受到限流或被拒绝，已暂停后续请求。", { retry_after_ms: retryMs });
    }
    if (!response.ok) {
      await response.body?.cancel();
      const code = status === 401 ? "AUTH_REQUIRED" : status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : "UPSTREAM_ERROR";
      throw new AppError(code, status === 401 ? "登录已失效，请在本机重新配置登录。" : `CC98 返回 HTTP ${status}。`, { http_status: status });
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AppError("SCHEMA_CHANGED", "CC98 返回了空响应。");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > this.maxBytes) {
          await reader.cancel();
          throw new AppError("RESPONSE_TOO_LARGE", "CC98 响应超出大小上限。");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      checkAbort(options.signal);
      throw new AppError("NETWORK_ERROR", "读取 CC98 响应时连接中断。");
    } finally {
      reader.releaseLock();
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new AppError("SCHEMA_CHANGED", "CC98 未返回有效 JSON，可能处于登录或网络验证页面。"); }
  }
}
