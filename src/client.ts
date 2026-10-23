import { API_ORIGIN } from "./config.ts";
import { Auth } from "./auth.ts";
import { AppError } from "./errors.ts";
import { Http } from "./http.ts";
import { list, postFrom, record, topicFrom, type Post, type Topic } from "./model.ts";

export interface Forum {
  sessionKey(): Promise<string>;
  search(keyword: string, boardId: number | undefined, from: number, signal?: AbortSignal): Promise<Topic[]>;
  topic(id: number, signal?: AbortSignal): Promise<Topic>;
  posts(id: number, from: number, size: number, signal?: AbortSignal): Promise<Post[]>;
}

export class Client implements Forum {
  readonly auth: Auth;
  private readonly http: Http;
  constructor(auth: Auth, http: Http) { this.auth = auth; this.http = http; }
  sessionKey(): Promise<string> { return this.auth.sessionKey(); }

  private async get(path: string, query: Record<string, string | number> = {}, options: { search?: boolean; anonymous?: boolean; signal?: AbortSignal } = {}): Promise<unknown> {
    const url = new URL(path, API_ORIGIN);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    let token = options.anonymous ? null : await this.auth.accessToken(options.signal);
    let retriedAuth = false;
    let retriedRate = false;
    while (true) {
      try {
        return await this.http.json(url.toString(), { headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, options);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        if (error.code === "AUTH_REQUIRED" && token && !retriedAuth) {
          retriedAuth = true;
          token = await this.auth.accessToken(options.signal, token);
          continue;
        }
        if (error.code === "RATE_LIMITED" && !retriedRate) { retriedRate = true; continue; }
        throw error;
      }
    }
  }
  async me(signal?: AbortSignal) { return record(await this.get("/me", {}, { signal })); }
  async search(keyword: string, boardId: number | undefined, from: number, signal?: AbortSignal): Promise<Topic[]> {
    const path = boardId ? `/topic/search/board/${boardId}` : "/topic/search";
    return list(await this.get(path, { keyword, from, size: 20 }, { search: true, signal }), "topics").map(topicFrom);
  }
  async topic(id: number, signal?: AbortSignal): Promise<Topic> { return topicFrom(await this.get(`/topic/${id}`, {}, { signal })); }
  async posts(id: number, from: number, size: number, signal?: AbortSignal): Promise<Post[]> {
    return list(await this.get(`/Topic/${id}/post`, { from, size }, { signal })).map(postFrom);
  }
  async boards(keyword = "", offset = 0, limit = 30, signal?: AbortSignal) {
    const groups = list(await this.get("/board/all", {}, { anonymous: true, signal }));
    const boards = groups.flatMap(value => {
      const group = record(value);
      return list(group.boards).map(value => {
        const board = record(value);
        if (!Number.isSafeInteger(board.id) || typeof board.name !== "string") throw new AppError("SCHEMA_CHANGED", "版面数据缺少编号或名称。");
        return { id: board.id as number, name: board.name, group: typeof group.name === "string" ? group.name : null };
      });
    }).filter(b => !keyword || `${b.name} ${b.group ?? ""}`.toLowerCase().includes(keyword.toLowerCase()));
    return { boards: boards.slice(offset, offset + limit), total: boards.length, next_offset: offset + limit < boards.length ? offset + limit : null };
  }
}
