import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Auth, importedSession, SessionStore } from "../src/auth.ts";
import { Client } from "../src/client.ts";
import { AppError, safeError } from "../src/errors.ts";
import { Http } from "../src/http.ts";
import { API_ORIGIN, TOKEN_URL } from "../src/config.ts";
import { json, temp } from "./helpers.ts";

test("password login saves private tokens, omits the password, and refreshes only once concurrently", async t => {
  const store = new SessionStore(await temp(t));
  let logins = 0;
  let refreshes = 0;
  const http = new Http({ intervalMs: 0, fetch: async (url, init) => {
    assert.equal(url, TOKEN_URL);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    const form = new URLSearchParams(String(init.body));
    if (form.get("grant_type") === "password") {
      logins++;
      assert.equal(form.get("password"), "secret-password");
      return json({ access_token: "initial-access", refresh_token: "refresh-one", expires_in: 3600 });
    }
    refreshes++;
    await delay(10);
    return json({ access_token: "renewed-access", expires_in: 3600 });
  } });
  const auth = new Auth(store, http);
  await auth.login("tester", "secret-password");
  assert.equal(logins, 1);
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(store.path, "utf8"), /secret-password/);
  assert.doesNotMatch(JSON.stringify(await auth.status()), /initial-access|refresh-one/);
  const previous = (await store.load())!;
  await store.save({ ...previous, expires_at_ms: 0 });
  assert.deepEqual(await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]), ["renewed-access", "renewed-access", "renewed-access"]);
  assert.equal(refreshes, 1);
  assert.equal((await store.load())!.refresh_token, "refresh-one");
  assert.equal(await auth.sessionKey(), previous.session_id);
});

test("401 refresh retries only GET and a second rejection is returned", async t => {
  const store = new SessionStore(await temp(t));
  await store.save(importedSession({ access_token: "old", refresh_token: "refresh" }));
  let gets = 0;
  let refreshes = 0;
  const http = new Http({ intervalMs: 0, fetch: async (url, init) => {
    if (url === TOKEN_URL) { refreshes++; return json({ access_token: "new", expires_in: 3600 }); }
    assert.equal(init.method ?? "GET", "GET");
    assert.ok(url.startsWith(API_ORIGIN));
    gets++;
    return json({ secret: "do-not-echo-upstream" }, 401);
  } });
  const client = new Client(new Auth(store, http), http);
  await assert.rejects(client.me(), (e: AppError) => e.code === "AUTH_REQUIRED" && !e.message.includes("do-not-echo"));
  assert.equal(gets, 2);
  assert.equal(refreshes, 1);
});

test("rejected password is not retried or persisted; subsequent calls require setup", async t => {
  const store = new SessionStore(await temp(t));
  let calls = 0;
  const http = new Http({ intervalMs: 0, fetch: async () => { calls++; return json({ error: "invalid_grant", error_description: "SECRET" }, 400); } });
  const auth = new Auth(store, http);
  await assert.rejects(auth.login("tester", "password"), (e: AppError) => e.code === "AUTH_REJECTED");
  await assert.rejects(auth.accessToken(), (e: AppError) => e.code === "CONFIGURATION_REQUIRED");
  assert.equal(calls, 1);
  assert.equal(await store.load(), null);
  assert.equal(JSON.stringify(safeError(new Error("SECRET"))).includes("SECRET"), false);
});

test("search 403 retries once, whereas a forbidden post is not classified as search throttling", async t => {
  const store = new SessionStore(await temp(t));
  await store.save(importedSession({ access_token: "test-token" }));
  let searches = 0;
  let posts = 0;
  const http = new Http({ intervalMs: 0, fetch: async url => {
    if (url.includes("/topic/search")) { searches++; return json({}, 403); }
    posts++; return json({}, 403);
  } });
  const client = new Client(new Auth(store, http), http);
  await assert.rejects(client.search("test", 88, 0), (e: AppError) => e.code === "RATE_LIMITED");
  assert.equal(searches, 2);
  await assert.rejects(client.posts(42, 0, 1), (e: AppError) => e.code === "FORBIDDEN");
  assert.equal(posts, 1);
});

test("requests run serially and cancellation interrupts a server cooldown", async () => {
  let active = 0;
  let maxActive = 0;
  const http = new Http({ intervalMs: 1, fetch: async () => {
    active++; maxActive = Math.max(maxActive, active);
    await delay(8); active--; return json([]);
  } });
  await Promise.all([1, 2, 3].map(() => http.json(`${API_ORIGIN}/topic/search`)));
  assert.equal(maxActive, 1);
  let calls = 0;
  const limited = new Http({ intervalMs: 0, fetch: async () => { calls++; return json({}, 429, { "retry-after": "120" }); } });
  await assert.rejects(limited.json(`${API_ORIGIN}/topic/search`), (e: AppError) => Number(e.details.retry_after_ms) >= 120_000);
  await assert.rejects(limited.json(`${API_ORIGIN}/topic/search`, {}, { signal: AbortSignal.timeout(15) }), (e: AppError) => e.code === "CANCELLED");
  assert.equal(calls, 1);
});

test("HTTP transport refuses external URLs and forum mutations; response limits and schema errors remain visible", async () => {
  const http = new Http({ intervalMs: 0, maxBytes: 10, fetch: async () => json({ a: "long-response" }) });
  assert.throws(() => http.json("https://example.org"), AppError);
  assert.throws(() => http.json(`${API_ORIGIN}/message`, { method: "POST" }), AppError);
  await assert.rejects(http.json(`${API_ORIGIN}/me`), (e: AppError) => e.code === "RESPONSE_TOO_LARGE");
  const bad = new Http({ intervalMs: 0, fetch: async () => new Response("<html>login</html>") });
  await assert.rejects(bad.json(`${API_ORIGIN}/me`), (e: AppError) => e.code === "SCHEMA_CHANGED");
});

test("imports browser and desktop session formats without retaining arbitrary credential fields", () => {
  const browser = importedSession({ accessToken: "str-Bearer token", refresh_token: "str-refresh", accessToken_expirationTime: "str-1900000000", password: "never-store" });
  assert.equal(browser.access_token, "token");
  assert.equal(browser.refresh_token, "refresh");
  assert.equal(browser.expires_at_ms, 1900000000000);
  assert.equal("password" in browser, false);
  const desktop = importedSession({ account: "test", access_token: "token", refresh_token: "refresh", expires_at: 1900000000 });
  assert.equal(desktop.expires_at_ms, browser.expires_at_ms);
  assert.notEqual(desktop.session_id, browser.session_id);
  assert.throws(() => importedSession({ access_token: "bad\nheader" }), AppError);
});

test("logout or account replacement while a token refresh runs cannot resurrect old credentials", async t => {
  const store = new SessionStore(await temp(t));
  await store.save({ ...importedSession({ access_token: "old", refresh_token: "r" }), expires_at_ms: 0 });
  const http = new Http({ intervalMs: 0, fetch: async () => { await store.clear(); return json({ access_token: "new", expires_in: 3600 }); } });
  await assert.rejects(new Auth(store, http).accessToken(), (e: AppError) => e.code === "SESSION_CHANGED");
  assert.equal(await store.load(), null);
});

test("malformed search data cannot masquerade as an empty successful result", async t => {
  const store = new SessionStore(await temp(t));
  await store.save(importedSession({ access_token: "token" }));
  const http = new Http({ intervalMs: 0, fetch: async () => json({ unexpected: [] }) });
  await assert.rejects(new Client(new Auth(store, http), http).search("test", undefined, 0), (e: AppError) => e.code === "SCHEMA_CHANGED");
});
