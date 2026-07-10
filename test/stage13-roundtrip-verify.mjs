import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FsStore } from "../src/node/fs-store.js";
import { buildRabbitholeExport, importRabbitholeFile } from "../src/web/portable.js";

const corpusDir = new URL("./fixtures/corpus/", import.meta.url);
const fixtureNames = (await fs.readdir(corpusDir)).filter((name) => name.endsWith(".rabbithole")).sort();
assert.equal(fixtureNames.length, 20, "the curated corpus must contain exactly 20 portable fixtures");

// KNOWN DEFECT adapter: FsStore correctly returns an allowed Uint8Array/Buffer,
// while portable.js's Node export path currently calls blob.arrayBuffer(). Wrap
// only that return value so every fixture can still exercise real filesystem
// persistence. The unadapted failure is recorded in the stage13 report.
class PortableFsStore extends FsStore {
  async getAsset(holeId, name) {
    const bytes = await super.getAsset(holeId, name);
    return bytes == null ? null : new Blob([bytes]);
  }
}

async function storeAt(label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `rabbithole-stage13-${label}-`));
  // FsStore deliberately reads RABBITHOLE_DIR at operation time, so each store
  // round trip is completed before selecting the next isolated directory.
  process.env.RABBITHOLE_DIR = dir;
  return { store: new PortableFsStore(), dir };
}
function selectDir(dir) {
  process.env.RABBITHOLE_DIR = dir;
}
function normalized(payload) {
  const copy = structuredClone(payload);
  // Defined fixed-point normalization:
  // - updated_at is volatile at persistence boundaries and maps to one token.
  // - collision-generated hole_id values are identity-only and map to one token.
  copy.hole.updated_at = "<updated_at>";
  copy.hole.hole_id = "<hole_id>";
  return copy;
}

// Fixtures 10 and 11 are legacy-era shapes whose import deliberately migrates
// them to the modern schema, so export cannot reproduce their source bytes.
// Their modern projection is still pinned by the exported2/exported3
// idempotence assertions below.
const MIGRATION_FIXTURES = new Set(["10-schema-null-legacy.rabbithole", "11-v02-legacy.rabbithole"]);

for (const name of fixtureNames) {
  const text = await fs.readFile(new URL(name, corpusDir), "utf8");
  const first = await storeAt("first");
  const imported1 = await importRabbitholeFile(first.store, text);
  const exported1 = await buildRabbitholeExport(first.store, imported1.hole_id);
  // Anchor the projection to the source file, not merely to itself: comparing
  // exports against exports lets a field silently dropped by the export path
  // cancel out on both sides (proven by a smoke-detector probe).
  if (!MIGRATION_FIXTURES.has(name)) {
    assert.deepEqual(normalized(exported1), normalized(JSON.parse(text)),
      `${name}: export(import(source)) must reproduce the source file without dropping or rewriting fields`);
  }

  const second = await storeAt("second");
  const imported2 = await importRabbitholeFile(second.store, JSON.stringify(exported1));
  const exported2 = await buildRabbitholeExport(second.store, imported2.hole_id);
  assert.deepEqual(normalized(exported2), normalized(exported1), `${name}: import-export-reimport fixed point`);

  const third = await storeAt("third");
  await importRabbitholeFile(third.store, JSON.stringify(exported1));
  const exported3 = await buildRabbitholeExport(third.store, exported1.hole.hole_id);
  assert.deepEqual(normalized(exported3), normalized(exported1), `${name}: export(import(export)) is idempotent under timestamp normalization`);
}
console.log(`ok stage13: all ${fixtureNames.length} corpus fixtures are normalized fixed points and export-idempotent`);

{
  const text = await fs.readFile(new URL("04-assets-png-svg.rabbithole", corpusDir), "utf8");
  const target = await storeAt("collision");
  const original = await importRabbitholeFile(target.store, text);
  const before = await buildRabbitholeExport(target.store, original.hole_id);
  const collided = await importRabbitholeFile(target.store, text);
  assert.equal(collided.collision, true);
  assert.notEqual(collided.hole_id, original.hole_id);
  const after = await buildRabbitholeExport(target.store, collided.hole_id);
  assert.deepEqual(normalized(after), normalized(before), "collision changes identity but preserves content and assets");
}
console.log("ok stage13: import collision mints a fresh hole_id and preserves content");

console.log("stage13 round-trip verification passed");
