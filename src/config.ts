import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const API_ORIGIN = "https://api.cc98.org";
export const TOKEN_URL = "https://openid.cc98.org/connect/token";
export const WEB_ORIGIN = "https://www.cc98.org";
export const VERSION = "0.1.0";
export const SERVER_NAME = "cc98-searchpro";

export function setupCommand(): string {
  const path = fileURLToPath(new URL("../scripts/login.py", import.meta.url));
  return `python3 '${path.replaceAll("'", "'\\''")}'`;
}

/** CC98 web pages contain ten floors; anchors are positions within the page. */
export function topicUrl(id: number, floor?: number | null): string {
  const base = `${WEB_ORIGIN}/topic/${id}`;
  return floor && Number.isSafeInteger(floor) && floor > 0
    ? `${base}/${Math.ceil(floor / 10)}#${((floor - 1) % 10) + 1}` : base;
}

export function dataDirectory(env = process.env): string {
  const explicit = env.CC98_SEARCHPRO_DATA_DIR || env.CC98_SEARCH_DATA_DIR;
  if (explicit) return resolve(explicit);
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const current = join(base, SERVER_NAME);
  const legacy = join(base, "cc98-search-mcp");
  return !existsSync(join(current, "session.json")) && existsSync(join(legacy, "session.json")) ? legacy : current;
}
