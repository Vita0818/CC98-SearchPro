import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "../src/config.ts";
import { temp } from "./helpers.ts";

test("SearchPro uses its new identity while preserving explicitly configured or existing legacy sessions", async t => {
  const base = await temp(t);
  const current = join(base, "cc98-searchpro");
  const legacy = join(base, "cc98-search-mcp");
  assert.equal(dataDirectory({ XDG_DATA_HOME: base }), current);
  await mkdir(legacy);
  await writeFile(join(legacy, "session.json"), "{}");
  assert.equal(dataDirectory({ XDG_DATA_HOME: base }), legacy);
  await mkdir(current);
  await writeFile(join(current, "session.json"), "{}");
  assert.equal(dataDirectory({ XDG_DATA_HOME: base }), current);
  assert.equal(dataDirectory({ CC98_SEARCH_DATA_DIR: legacy }), legacy);
  assert.equal(dataDirectory({ CC98_SEARCH_DATA_DIR: legacy, CC98_SEARCHPRO_DATA_DIR: current }), current);
});
