/** @protects bounded and searchable list_rabbitholes MCP contracts. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-list-contract-"));

const { listRabbitholes } = await import("../../src/node/rabbithole.js");
const { toolDefinitions } = await import("../../src/node/tools/manifest.js");

const baseTime = Date.parse("2026-09-01T12:00:00.000Z");
await Promise.all(Array.from({ length: 60 }, async (_, index) => {
  const holeId = index.toString(16).padStart(8, "0");
  const title = index === 39
    ? "Olivetti design systems archive"
    : `Research note ${String(index + 1).padStart(2, "0")}: ${"practical context ".repeat(3).trim()}`;
  const summary = {
    hole_id: holeId,
    title,
    updated_at: new Date(baseTime - index * 60_000).toISOString(),
    node_count: index + 1,
  };
  await Promise.all([
    fs.writeFile(path.join(process.env.RABBITHOLE_DIR, `${holeId}.json`), "{}", "utf8"),
    fs.writeFile(path.join(process.env.RABBITHOLE_DIR, `${holeId}.summary.json`), JSON.stringify(summary), "utf8"),
  ]);
}));

const defaults = await listRabbitholes();
assert.equal(defaults.holes.length, 10);
assert.equal(defaults.total, 60);
assert.deepEqual(Object.keys(defaults.holes[0]), ["hole_id", "title", "updated_at", "node_count"]);

const queried = await listRabbitholes({ query: "oLiVeTtI" });
assert.equal(queried.total, 1, "total counts matches after filtering and before slicing");
assert.equal(queried.holes.length, 1);
assert.equal(queried.holes[0].hole_id, "00000027", "query filtering happens before the default top-ten slice");

const fifty = await listRabbitholes({ limit: 50 });
assert.equal(fifty.holes.length, 50);
assert.equal(fifty.total, 60);
assert(JSON.stringify(fifty).length < 10_000, "fifty realistic list entries stay under the approximate 10K-character budget");

assert.equal((await listRabbitholes({ limit: 0 })).holes.length, 1);
assert.equal((await listRabbitholes({ limit: 500 })).holes.length, 50);
assert.equal((await listRabbitholes({ limit: "7" })).holes.length, 7);
assert.equal((await listRabbitholes({ limit: "abc" })).holes.length, 10);
assert.deepEqual(await listRabbitholes({ query: "does not exist" }), { holes: [], total: 0 });

const listTool = toolDefinitions.find((tool) => tool.name === "list_rabbitholes");
assert(listTool);
assert.equal(listTool.input.limit.safeParse("abc").data, 10, "the MCP schema coerces invalid limits to the default");
assert.deepEqual(await listTool.run({ query: "OLIVETTI", limit: 500 }), queried);

console.log("ok list_rabbitholes: bounded defaults, filtered totals, query-before-slice, and clamped limits");
