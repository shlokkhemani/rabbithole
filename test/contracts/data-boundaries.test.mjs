import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_ASSET_BYTES } from "../../src/core/assets.js";
import { NEWER_SCHEMA_MESSAGE } from "../../src/core/schema.js";
import {
  extractSnapshotPayload,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_PAYLOAD_BYTES,
  SNAPSHOT_PAYLOAD_CLOSE,
  SNAPSHOT_PAYLOAD_OPEN,
  validatePortableImportCaps,
} from "../../src/core/portable-import.js";
import {
  base64ToBytes,
  binaryToBase64,
  createPortableProjection,
  validatePortableProjection,
} from "../../src/core/portable-projection.js";
import { migratePersistedHole, toPersistedHole, validatePersistedHole } from "../../src/core/schema.js";
import { assertRabbitholeStore, RABBITHOLE_STORE_METHODS } from "../../src/core/store.js";
import { FsStore } from "../../src/node/fs-store.js";
import { importRabbitholeFile, importSnapshotFile, parseRabbitholeFile } from "../../src/web/portable.js";
import {
  nullSchemaLegacyFixture,
  persistedHoleFixture,
  portableArtifactFixture,
} from "../fixtures/contracts/artifact-fixture.js";
import { storeFixture } from "../fixtures/contracts/store-fixture.js";
import { brainFixture, generationEventFixtures } from "../fixtures/contracts/generation-fixture.js";
import {
  hydratableBlockFixture,
  markdownExtensionFixture,
  primitiveFixture,
} from "../fixtures/contracts/content-fixture.js";

const stamp = "2026-01-01T00:00:00.000Z";
const validNode = (overrides = {}) => ({
  id: "root", parent_id: null, title: "Root", markdown: "Body",
  base_url: null, base_url_source: null, origin: null,
  position: { x: 0, y: 0 }, size: null, font_scale: 1, collapsed: false,
  status: "answered", read: true, created_at: stamp, extensions: {}, ...overrides,
});
const validHole = (overrides = {}) => ({
  schema_version: 2, hole_id: "edge-hole", title: "Edge Hole", root_id: "root",
  created_at: stamp, updated_at: stamp, view_state: null, nodes: [validNode()], ...overrides,
});
const portable = (hole = validHole(), assets = {}) => JSON.stringify({
  format: "rabbithole", format_version: 1, hole, assets,
});
async function newStore() {
  process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-data-boundaries-"));
  return new FsStore();
}

assert.equal(assertRabbitholeStore(storeFixture), storeFixture);
for (const missing of RABBITHOLE_STORE_METHODS) {
  const invalidStore = { ...storeFixture };
  delete invalidStore[missing];
  assert.throws(() => assertRabbitholeStore(invalidStore), new RegExp(`missing ${missing}\\(\\)`));
}
console.log("ok data boundaries: typed store fixture satisfies the port and missing capabilities are rejected");

assert.equal(validatePersistedHole(persistedHoleFixture), true);
assert.throws(
  () => validatePersistedHole({ ...persistedHoleFixture, nodes: [{ ...persistedHoleFixture.nodes[0], status: "lost" }] }),
  /status is invalid/,
);
assert.throws(
  () => parseRabbitholeFile(JSON.stringify({ ...portableArtifactFixture, assets: [] })),
  /assets must be an object/,
);
const projected = createPortableProjection(persistedHoleFixture, portableArtifactFixture.assets);
assert.deepEqual(projected, portableArtifactFixture);
assert.equal(validatePortableProjection(projected), projected);
const binaryFixture = Uint8Array.of(0, 1, 127, 128, 254, 255);
const encodedFixture = "AAF/gP7/";
assert.equal(await binaryToBase64(binaryFixture), encodedFixture);
assert.equal(await binaryToBase64(new Blob([binaryFixture])), encodedFixture);
assert.deepEqual(base64ToBytes(encodedFixture), binaryFixture);
console.log("ok data boundaries: typed artifact fixtures validate and invalid persisted/portable shapes are rejected");

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
console.log("ok data boundaries: typed generation fixture distinguishes the two-event vocabulary from malformed events");

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
console.log("ok data boundaries: typed content fixtures distinguish extension, hydratable-block, and primitive shapes from malformed values");

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
console.log("ok data boundaries: typed persisted, legacy, and portable artifacts round-trip with defined normalization");

assert.throws(
  () => validatePersistedHole(validHole({ nodes: [validNode({ extensions: [] })] })),
  /extensions must be a JSON object/,
);
console.log("ok data boundaries: non-object node extensions are legibly rejected");

{
  const bag = { future_primitive: { attempts: [0, null, "雪", { correct: false }] } };
  const v1 = validHole({ schema_version: 1, nodes: [{ ...validNode(), extensions: undefined }] });
  delete v1.nodes[0].extensions;
  const migrated = migratePersistedHole(v1).hole;
  assert.equal(migrated.schema_version, 2);
  assert.deepEqual(migrated.nodes[0].extensions, {});
  migrated.nodes[0].extensions = bag;
  migrated.nodes[0].read = false;
  const store = await newStore();
  await store.saveHole(migrated, { updatedAt: migrated.updated_at });
  const reopened = await store.loadHole(migrated.hole_id);
  assert.equal(reopened.schema_version, 2);
  assert.deepEqual(reopened.nodes[0].extensions, bag);
}
console.log("ok data boundaries: v1 open-modify-save-reopen preserves the schema-v2 extension bag");

assert.throws(
  () => parseRabbitholeFile(JSON.stringify({ format: "rabbithole", format_version: 2, hole: {}, assets: {} })),
  /unsupported Rabbithole file format/i,
);
console.log("ok data boundaries: future format_version is clearly refused");

await assert.rejects(
  () => importRabbitholeFile(new FsStore(), portable(validHole({ schema_version: 3 }))),
  (error) => error?.message === NEWER_SCHEMA_MESSAGE,
);
console.log("ok data boundaries: future schema_version is legibly refused");

{
  const store = await newStore();
  const legacyText = await fs.readFile(new URL("../fixtures/corpus/10-schema-null-legacy.rabbithole", import.meta.url), "utf8");
  const result = await importRabbitholeFile(store, legacyText);
  const loaded = await store.loadHole(result.hole_id);
  assert.equal(loaded.schema_version, 2);
  assert.equal(loaded.nodes[0].title, "");
  assert.equal(loaded.nodes[0].status, "answered");
  assert.equal((await store.loadHole(result.hole_id)).schema_version, 2, "reload remains migrated");
}
console.log("ok data boundaries: schema_version null backfills, persists, and reloads");

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
console.log("ok data boundaries: malformed JSON, base64, and wrong-type fields reject without crashing");

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
console.log("ok data boundaries: unicode, emoji, and RTL titles survive validate-persist-reload");

const snapshot = (payload, before = "", after = "") =>
  `<!doctype html><html><body>${before}${SNAPSHOT_PAYLOAD_OPEN}${payload}${SNAPSHOT_PAYLOAD_CLOSE}${after}</body></html>`;

{
  let read = false;
  await assert.rejects(
    async () => importRabbitholeFile(await newStore(), { size: MAX_IMPORT_FILE_BYTES + 1, text: async () => { read = true; return ""; } }),
    /file exceeds 64 MB/,
  );
  assert.equal(read, false, "oversized files reject before File.text()");

  assert.throws(() => parseRabbitholeFile(" ".repeat(MAX_IMPORT_PAYLOAD_BYTES + 1)), /payload exceeds 32 MB/);
  const tooManyNodes = validHole({ nodes: Array.from({ length: 5001 }, (_, index) => validNode({ id: `n${index}` })) });
  assert.throws(() => parseRabbitholeFile(portable(tooManyNodes)), /exceeds 5,000 nodes/);
  const tooManyAssets = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`a${index}.png`, ""]));
  assert.throws(() => parseRabbitholeFile(portable(validHole(), tooManyAssets)), /exceeds 200 assets/);

  const aggregateChunk = Buffer.alloc(18 * 1024 * 1024).toString("base64");
  assert.throws(
    () => validatePortableImportCaps({
      format: "rabbithole",
      format_version: 1,
      hole: validHole(),
      assets: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`aggregate${index}.png`, aggregateChunk])),
    }),
    /exceed 100 MB aggregate/,
  );

  const payload = portable(validHole({ hole_id: "snapshot-valid" }));
  assert.equal(extractSnapshotPayload(snapshot(payload)), payload);
  await assert.rejects(async () => importSnapshotFile(await newStore(), "<!doctype html><script>legacyHydrate()</script>"), /older snapshot that cannot be imported/);
  await assert.rejects(async () => importSnapshotFile(await newStore(), snapshot(payload) + snapshot(payload)), /duplicate portable payload/);
  await assert.rejects(async () => importSnapshotFile(await newStore(), `${SNAPSHOT_PAYLOAD_OPEN}{ nope${SNAPSHOT_PAYLOAD_CLOSE}`), /snapshot payload must be valid JSON/);
  await assert.rejects(async () => importSnapshotFile(await newStore(), '<script id="rabbithole-portable" type="application/vnd.rabbithole+json">{}</script>'), /payload element is malformed/);

  const idlessMarkdown = "```show\n<div>durable</div>\n```";
  const identityStore = await newStore();
  const firstImport = await importRabbitholeFile(identityStore, portable(validHole({
    hole_id: "block-identity-portable",
    nodes: [validNode({ markdown: idlessMarkdown })],
  })));
  const firstSaved = await identityStore.loadHole(firstImport.hole_id);
  assert.match(firstSaved.nodes[0].markdown, /^```show id=[a-z0-9]{4,8}\n/);
  const firstId = /id=([a-z0-9]{4,8})/.exec(firstSaved.nodes[0].markdown)[1];
  const reimport = await importRabbitholeFile(identityStore, portable(firstSaved));
  const reimported = await identityStore.loadHole(reimport.hole_id);
  assert.equal(/id=([a-z0-9]{4,8})/.exec(reimported.nodes[0].markdown)[1], firstId);

  const snapshotImport = await importSnapshotFile(identityStore, snapshot(portable(validHole({
    hole_id: "block-identity-snapshot",
    nodes: [validNode({ markdown: idlessMarkdown })],
  }))));
  assert.match((await identityStore.loadHole(snapshotImport.hole_id)).nodes[0].markdown, /^```show id=[a-z0-9]{4,8}\n/);
  console.log("ok data boundaries: portable and snapshot imports mint durable block ids and canonical re-import preserves them");

  const storage = new Map();
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  try {
    const hostileHole = validHole({
      hole_id: "hostile-snapshot",
      title: "safe </script> text",
      "rh-web-api-key": "top-secret",
      nodes: [validNode({ origin: { nested: { "rh-web-api-keys": { openai: "nested-secret" } } } })],
    });
    const escapedPayload = portable(hostileHole).replace(/</g, "\\u003c");
    const hostile = snapshot(
      escapedPayload,
      '<script>window.__snapshot_executed__ = true; localStorage.setItem("snapshot-executed", "yes")</script><img src=x onerror="localStorage.setItem(\'event-executed\',\'yes\')">',
      '<script>localStorage.setItem("after-executed", "yes")</script>',
    );
    const store = await newStore();
    const imported = await importSnapshotFile(store, hostile);
    const saved = await store.loadHole(imported.hole_id);
    assert.equal(globalThis.window.__snapshot_executed__, undefined);
    assert.equal(storage.size, 0, "HTML scripts and event handlers never execute during text-only import");
    assert.equal(JSON.stringify(saved).includes("rh-web-api-key"), false);
    assert.equal(JSON.stringify(saved).includes("secret"), false);
    assert.equal(saved.title, "safe </script> text", "escaped breakout text does not corrupt extraction");
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousLocalStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousLocalStorage;
  }

  const cleanupStore = await newStore();
  const originalPutAsset = cleanupStore.putAsset.bind(cleanupStore);
  let puts = 0;
  cleanupStore.putAsset = async (...args) => {
    puts += 1;
    if (puts === 2) throw new Error("synthetic asset failure");
    return originalPutAsset(...args);
  };
  await assert.rejects(
    () => importRabbitholeFile(cleanupStore, portable(validHole({ hole_id: "cleanup-failure" }), { "one.png": "AA==", "two.png": "AA==" })),
    /synthetic asset failure/,
  );
  assert.equal(await cleanupStore.loadHole("cleanup-failure"), null, "failed asset persistence removes the partial hole");
}
console.log("ok data boundaries: snapshot and portable imports enforce inert extraction, uniform caps, secret isolation, and cleanup-on-failure");

{
  const exact = Buffer.alloc(MAX_ASSET_BYTES, 0xa5).toString("base64");
  const over = Buffer.alloc(MAX_ASSET_BYTES + 1, 0xa5).toString("base64");
  const exactStore = await newStore();
  const accepted = await importRabbitholeFile(exactStore, portable(validHole({ hole_id: "asset-exact" }), { "limit.png": exact }));
  assert.equal((await exactStore.getAsset(accepted.hole_id, "limit.png")).byteLength, MAX_ASSET_BYTES);
  const originalAtob = globalThis.atob;
  let atobCalled = false;
  globalThis.atob = (...args) => { atobCalled = true; return originalAtob(...args); };
  await assert.rejects(
    async () => importRabbitholeFile(await newStore(), portable(validHole({ hole_id: "asset-over" }), { "limit.png": over })),
    /exceeds 20 MB/,
  );
  globalThis.atob = originalAtob;
  assert.equal(atobCalled, false, "encoded-length preflight rejects oversized base64 before atob");
}
console.log("ok data boundaries: exact 20 MB asset is accepted and one byte over is rejected");

console.log("data-boundary verification passed");
