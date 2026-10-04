/** @protects machine preference patch validation and document-boundary capability contracts. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RabbitholeSession } from "../../src/node/mcp/hole-session/session.js";

process.env.RABBITHOLE_NO_BROWSER = "1";
const previousDir = process.env.RABBITHOLE_DIR;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-preferences-wire-"));
process.env.RABBITHOLE_DIR = dir;

const session = new RabbitholeSession({
  holeId: "preferences-wire",
  title: "Preferences wire",
  rootId: "root",
  nodes: [{ id: "root", parent_id: null, title: "Root", markdown: "Body", status: "answered" }],
  assetNames: new Set(),
  isResume: false,
  renderPage: () => "",
});

async function post(payload) {
  const response = await fetch(session.url + "/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

try {
  await session.start();
  assert.deepEqual(await post({
    type: "preferences_patch",
    values: { "rh-theme": "dark", "rh-future-setting": "preserve" },
  }), { status: 200, body: { ok: true } });
  assert.deepEqual(session.outboundEvents.at(-1)?.data, {
    type: "preferences",
    values: { "rh-theme": "dark", "rh-future-setting": "preserve" },
  }, "a successful merge broadcasts the exact patch to same-session clients");

  for (const fixture of [
    { values: null, message: "values must be a plain object" },
    { values: [], message: "values must be a plain object" },
    { values: { theme: "dark" }, message: "invalid preference key" },
    { values: { "rh-theme": 3 }, message: "must be a string or null" },
    { values: { "rh-theme": "x".repeat(64 * 1024 + 1) }, message: "exceeds 64 KB" },
    {
      values: Object.fromEntries(Array.from({ length: 5 }, (_, index) => ["rh-large-" + index, "x".repeat(60 * 1024)])),
      message: "exceeds 256 KB",
    },
  ]) {
    const result = await post({ type: "preferences_patch", values: fixture.values });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.match(result.body.error, new RegExp(fixture.message));
  }

  const hydration = session.buildHydration();
  const snapshot = session.toHole();
  assert.equal(Object.hasOwn(hydration, "preferences"), false, "engine hydration remains preference-free");
  assert.equal(Object.hasOwn(snapshot, "preferences"), false, "snapshot projection remains preference-free");
  assert.equal(JSON.stringify(snapshot).includes("rh-theme"), false);
} finally {
  await session.close("preferences_wire_complete");
  if (previousDir === undefined) delete process.env.RABBITHOLE_DIR;
  else process.env.RABBITHOLE_DIR = previousDir;
  await fs.rm(dir, { recursive: true, force: true });
}

console.log("machine preference wire contracts ok");
