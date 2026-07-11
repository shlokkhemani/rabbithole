import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FsStore } from "../../src/node/fs-store.js";
import { extractAssetRefsFromMarkdown } from "../../src/core/assets.js";
import { createSnapshotProjection } from "../../src/core/snapshot-projection.js";
import { buildSnapshotHtml } from "../../src/core/snapshot-html.js";
import { binaryToBase64 } from "../../src/core/portable-projection.js";
import { buildRabbitholeExport, importRabbitholeFile, importSnapshotFile } from "../../src/web/portable.js";

const corpusDir = new URL("../fixtures/corpus/", import.meta.url);
const fixtureNames = (await fs.readdir(corpusDir)).filter((name) => name.endsWith(".rabbithole")).sort();
assert.equal(fixtureNames.length, 20, "the curated corpus must contain exactly 20 portable fixtures");

async function storeAt(label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `rabbithole-artifact-roundtrip-${label}-`));
  // FsStore deliberately reads RABBITHOLE_DIR at operation time, so each store
  // round trip is completed before selecting the next isolated directory.
  process.env.RABBITHOLE_DIR = dir;
  return { store: new FsStore(), dir };
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
async function exporterSnapshot(store, hole) {
  const referencedSet = new Set();
  for (const node of hole.nodes) {
    for (const name of extractAssetRefsFromMarkdown(node.markdown)) referencedSet.add(name);
  }
  const referenced = [...referencedSet].sort();
  const assets = {};
  for (const name of referenced) assets[name] = await binaryToBase64(await store.getAsset(hole.hole_id, name));
  const projection = createSnapshotProjection(hole, hole.view_state, assets);
  return {
    html: buildSnapshotHtml({ title: hole.title, stylesheetText: "", dompurifySource: "", frozenClientSource: "", snapshotProjection: projection }),
    referenced,
  };
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

  selectDir(first.dir);
  const persisted = await first.store.loadHole(imported1.hole_id);
  const snapshot = await exporterSnapshot(first.store, persisted);
  const snapshotStore = await storeAt("snapshot");
  const snapshotImported = await importSnapshotFile(snapshotStore.store, snapshot.html);
  const snapshotExport = await buildRabbitholeExport(snapshotStore.store, snapshotImported.hole_id);
  const expected = structuredClone(exported1);
  expected.assets = Object.fromEntries(Object.entries(expected.assets).filter(([assetName]) => snapshot.referenced.includes(assetName)));
  assert.deepEqual(
    normalized(snapshotExport), normalized(expected),
    `${name}: portable -> FsStore -> canonical snapshot HTML -> web snapshot import -> portable is a fixed point; referenced assets are byte-exact and unreferenced assets drop at the snapshot hop by design (referenced=${JSON.stringify(snapshot.referenced)}, before=${JSON.stringify(exported1)}, after=${JSON.stringify(snapshotExport)})`
  );
}
console.log(`ok artifact round trip: all ${fixtureNames.length} corpus fixtures are normalized three-projection fixed points and export-idempotent`);

{
  const source = JSON.parse(await fs.readFile(new URL("01-empty-root.rabbithole", corpusDir), "utf8"));
  const bag = { future_primitive: { attempts: [0, null, "雪", { correct: false }] } };
  source.hole.nodes[0].extensions = bag;
  const portableStore = await storeAt("extensions-portable");
  const imported = await importRabbitholeFile(portableStore.store, JSON.stringify(source));
  const exported = await buildRabbitholeExport(portableStore.store, imported.hole_id);
  assert.deepEqual(exported.hole.nodes[0].extensions, bag, "portable backup carries learner progress with structural JSON fidelity");

  selectDir(portableStore.dir);
  const persisted = await portableStore.store.loadHole(imported.hole_id);
  const snapshot = await exporterSnapshot(portableStore.store, persisted);
  const payload = JSON.parse(snapshot.html.match(/<script type="application\/vnd\.rabbithole\+json" id="rabbithole-portable">([\s\S]*?)<\/script>/)[1]);
  assert.equal(Object.hasOwn(payload.hole.nodes[0], "extensions"), false, "snapshot normalization strips the personal extension bag");
  const snapshotStore = await storeAt("extensions-snapshot");
  const snapshotImported = await importSnapshotFile(snapshotStore.store, snapshot.html);
  assert.deepEqual((await snapshotStore.store.loadHole(snapshotImported.hole_id)).nodes[0].extensions, {}, "snapshot import re-normalizes the omitted bag to empty");
}
console.log("ok artifact round trip: extension bags survive portable round trips and are stripped from snapshots");

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

  selectDir(target.dir);
  const persisted = await target.store.loadHole(original.hole_id);
  const snapshot = await exporterSnapshot(target.store, persisted);
  const snapshotImported = await importSnapshotFile(target.store, snapshot.html);
  assert.equal(snapshotImported.collision, true);
  assert.notEqual(snapshotImported.hole_id, original.hole_id);
  const snapshotFixedPoint = await buildRabbitholeExport(target.store, snapshotImported.hole_id);
  assert.deepEqual(normalized(snapshotFixedPoint), normalized(before), "snapshot import exports to the canonical .rabbithole fixed point");
}
console.log("ok artifact round trip: portable and snapshot import collisions mint fresh ids and preserve the .rabbithole fixed point");

console.log("artifact round-trip verification passed");
