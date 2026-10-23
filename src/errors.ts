export class AppError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function safeError(error: unknown) {
  if (error instanceof AppError) return { code: error.code, message: error.message, ...error.details };
  // Upstream responses and fetch errors can contain credentials. Do not echo them.
  return { code: "INTERNAL_ERROR", message: "处理请求失败，请检查本地配置或重试。" };
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError("CANCELLED", "操作已取消。");
}
