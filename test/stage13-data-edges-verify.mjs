import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_ASSET_BYTES } from "../src/core/assets.js";
import { migratePersistedHole, toPersistedHole, validatePersistedHole } from "../src/core/schema.js";
import { assertRabbitholeStore, RABBITHOLE_STORE_METHODS } from "../src/core/store.js";
import { FsStore } from "../src/node/fs-store.js";
import { importRabbitholeFile, parseRabbitholeFile } from "../src/web/portable.js";
import {
  nullSchemaLegacyFixture,
  persistedHoleFixture,
  portableArtifactFixture,
} from "./fixtures/contracts/artifact-fixture.js";
import { storeFixture } from "./fixtures/contracts/store-fixture.js";
import { brainFixture, generationEventFixtures } from "./fixtures/contracts/generation-fixture.js";
import {
  hydratableBlockFixture,
  markdownExtensionFixture,
  primitiveFixture,
} from "./fixtures/contracts/content-fixture.js";

const stamp = "2026-01-01T00:00:00.000Z";
const validNode = (overrides = {}) => ({
  id: "root", parent_id: null, title: "Root", markdown: "Body",
  base_url: null, base_url_source: null, origin: null,
  position: { x: 0, y: 0 }, size: null, font_scale: 1, collapsed: false,
  status: "answered", read: true, created_at: stamp, ...overrides,
});
const validHole = (overrides = {}) => ({
  schema_version: 1, hole_id: "edge-hole", title: "Edge Hole", root_id: "root",
  created_at: stamp, updated_at: stamp, view_state: null, nodes: [validNode()], ...overrides,
});
const portable = (hole = validHole(), assets = {}) => JSON.stringify({
  format: "rabbithole", format_version: 1, hole, assets,
});
async function newStore() {
  process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-stage13-"));
  return new FsStore();
}

assert.equal(assertRabbitholeStore(storeFixture), storeFixture);
for (const missing of RABBITHOLE_STORE_METHODS) {
  const invalidStore = { ...storeFixture };
  delete invalidStore[missing];
  assert.throws(() => assertRabbitholeStore(invalidStore), new RegExp(`missing ${missing}\\(\\)`));
}
console.log("ok stage13: typed store fixture satisfies the port and missing capabilities are rejected");

assert.equal(validatePersistedHole(persistedHoleFixture), true);
assert.throws(
  () => validatePersistedHole({ ...persistedHoleFixture, nodes: [{ ...persistedHoleFixture.nodes[0], status: "lost" }] }),
  /status is invalid/,
);
assert.throws(
  () => parseRabbitholeFile(JSON.stringify({ ...portableArtifactFixture, assets: [] })),
  /assets must be an object/,
);
console.log("ok stage13: typed artifact fixtures validate and invalid persisted/portable shapes are rejected");

const isGenerationEvent = (event) => event !== null && typeof event === "object" && (
  (event.type === "text" && typeof event.delta === "string") ||
  (event.type === "title" && typeof event.title === "string")
);
for (const event of generationEventFixtures) assert.equal(isGenerationEvent(event), true);
for (const malformed of [
  { type: "text", delta: 42 },
  { type: "title", title: null },
  { type: "usage", input_tokens: 1, output_tokens: 2 },
  { type: "text", title: "wrong field" },
]) assert.equal(isGenerationEvent(malformed), false);
const generated = [];
for await (const event of brainFixture.answerBranch({}, new AbortController().signal)) generated.push(event);
assert.deepEqual(generated, generationEventFixtures);
console.log("ok stage13: typed generation fixture distinguishes the two-event vocabulary from malformed events");

const isMarkdownExtension = (value) => value !== null && typeof value === "object" &&
  typeof value.language === "string" && typeof value.render === "function";
const isHydratableBlock = (value) => value !== null && typeof value === "object" &&
  typeof value.type === "string" && Number.isInteger(value.version) &&
  typeof value.parse === "function" && typeof value.renderStatic === "function" &&
  typeof value.hydrate === "function";
const isPrimitive = (value) => value !== null && typeof value === "object" && typeof value.mount === "function";
assert.equal(isMarkdownExtension(markdownExtensionFixture), true);
assert.equal(isHydratableBlock(hydratableBlockFixture), true);
assert.equal(isPrimitive(primitiveFixture), true);
for (const malformed of [
  { language: "show", render: "html" },
  { type: "check", version: "1", parse() {}, renderStatic() {}, hydrate() {} },
  { type: "check", version: 1, parse() {}, renderStatic() {} },
]) {
  assert.equal(isMarkdownExtension(malformed), false);
  assert.equal(isHydratableBlock(malformed), false);
}
assert.equal(isPrimitive({ mount: null }), false);
console.log("ok stage13: typed content fixtures distinguish extension, hydratable-block, and primitive shapes from malformed values");

{
  const migrated = migratePersistedHole(JSON.parse(JSON.stringify(persistedHoleFixture)));
  assert.equal(migrated.changed, false);
  const repersisted = toPersistedHole(migrated.hole, { updatedAt: migrated.hole.updated_at });
  assert.deepEqual(repersisted, persistedHoleFixture, "canonical persisted fixture is a schema fixed point");

  const legacy = migratePersistedHole(JSON.parse(JSON.stringify(nullSchemaLegacyFixture)));
  assert.deepEqual(
    toPersistedHole(legacy.hole, { updatedAt: legacy.hole.updated_at }),
    legacy.hole,
    "null-schema normalization is stable after migration",
  );

  const parsed = parseRabbitholeFile(JSON.stringify(portableArtifactFixture));
  const portableHole = migratePersistedHole(parsed.hole).hole;
  const normalizedPortable = {
    ...parsed,
    hole: toPersistedHole(portableHole, { updatedAt: portableHole.updated_at }),
  };
  assert.deepEqual(normalizedPortable, portableArtifactFixture, "portable fixture survives parse/migrate/re-persist");
}
console.log("ok stage13: typed persisted, legacy, and portable artifacts round-trip with defined normalization");

assert.throws(
  () => parseRabbitholeFile(JSON.stringify({ format: "rabbithole", format_version: 2, hole: {}, assets: {} })),
  /unsupported Rabbithole file format/i,
);
console.log("ok stage13: future format_version is clearly refused");

await assert.rejects(
  () => importRabbitholeFile(new FsStore(), portable(validHole({ schema_version: 2 }))),
  /Unsupported Rabbithole schema_version 2/,
);
console.log("ok stage13: future schema_version is legibly refused");

{
  const store = await newStore();
  const legacyText = await fs.readFile(new URL("./fixtures/corpus/10-schema-null-legacy.rabbithole", import.meta.url), "utf8");
  const result = await importRabbitholeFile(store, legacyText);
  const loaded = await store.loadHole(result.hole_id);
  assert.equal(loaded.schema_version, 1);
  assert.equal(loaded.nodes[0].title, "");
  assert.equal(loaded.nodes[0].status, "answered");
  assert.equal((await store.loadHole(result.hole_id)).schema_version, 1, "reload remains migrated");
}
console.log("ok stage13: schema_version null backfills, persists, and reloads");

assert.throws(() => parseRabbitholeFile("{ nope"), /valid JSON/);
await assert.rejects(async () => importRabbitholeFile(await newStore(), portable(validHole(), { "bad.png": "not+base64!" })), /not valid base64/);
for (const hole of [
  validHole({ title: 42 }),
  validHole({ nodes: "not-an-array" }),
  validHole({ nodes: [validNode({ markdown: { text: "wrong" } })] }),
  validHole({ nodes: [validNode({ parent_id: 7 })] }),
]) {
  await assert.rejects(async () => importRabbitholeFile(await newStore(), portable(hole)), /must be/);
}
console.log("ok stage13: malformed JSON, base64, and wrong-type fields reject without crashing");

{
  const title = "Café 漢字 🐇🕳️ — مرحبا — שלום";
  const nodeTitle = "naïve 🚀 العربية עברית";
  const persisted = toPersistedHole(validHole({ title, nodes: [validNode({ title: nodeTitle })] }), { updatedAt: stamp });
  const migrated = migratePersistedHole(JSON.parse(JSON.stringify(persisted))).hole;
  const store = await newStore();
  await store.saveHole(migrated);
  const loaded = await store.loadHole(migrated.hole_id);
  assert.equal(loaded.title, title);
  assert.equal(loaded.nodes[0].title, nodeTitle);
}
console.log("ok stage13: unicode, emoji, and RTL titles survive validate-persist-reload");

// KNOWN DEFECT / Phase 7 gate: snapshots currently embed ad-hoc hydration in an
// executable script and there is no snapshot import/extraction boundary to call.
// Consequently tampered types and oversized payloads cannot yet be runtime-
// rejected. Keep this explicit skip until snapshot import flows through
// parseRabbitholeFile -> migratePersistedHole with strict caps (THESEUS Phase 7).
console.log("skip stage13: hand-edited snapshot payload validation (known defect: no snapshot import validator or size cap)");

{
  const exact = Buffer.alloc(MAX_ASSET_BYTES, 0xa5).toString("base64");
  const over = Buffer.alloc(MAX_ASSET_BYTES + 1, 0xa5).toString("base64");
  const exactStore = await newStore();
  const accepted = await importRabbitholeFile(exactStore, portable(validHole({ hole_id: "asset-exact" }), { "limit.png": exact }));
  assert.equal((await exactStore.getAsset(accepted.hole_id, "limit.png")).byteLength, MAX_ASSET_BYTES);
  await assert.rejects(
    async () => importRabbitholeFile(await newStore(), portable(validHole({ hole_id: "asset-over" }), { "limit.png": over })),
    /exceeds 20 MB/,
  );
}
console.log("ok stage13: exact 20 MB asset is accepted and one byte over is rejected");

console.log("stage13 data-edge verification passed");
