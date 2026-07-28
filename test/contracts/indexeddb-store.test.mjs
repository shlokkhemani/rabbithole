import assert from "node:assert/strict";
import { CURRENT_SCHEMA_VERSION, NEWER_SCHEMA_MESSAGE } from "../../src/core/schema.js";
import { assertRabbitholeStore } from "../../src/core/store.js";
import { IdbStore } from "../../src/web/store/idb-store.js";
import { createPendingHoleFromQuestion, DirectRabbitholeHost } from "../../src/web/transport/direct-host.js";

import "fake-indexeddb/auto";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const PNG_BYTES_2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 8, 8, 8, 8]);

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
  storage: {
    persist: async () => true,
  },
  },
});

await verifyFreshDatabaseInitialization();
await verifyPersistencePermissionDoesNotBlockWrites();

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    storage: {
      persist: async () => true,
    },
  },
});

const store = assertRabbitholeStore(new IdbStore({ dbName: `rabbithole-indexeddb-store-${Date.now()}` }));

await runStoreContract(store, {
  readRawHole: (holeId) => rawHole("readonly", holeId),
  writeRawHole: (_holeId, fixture) => rawHole("readwrite", fixture),
  makeDeleteHost: async ({ root, childA, childB }) => {
    const host = new DirectRabbitholeHost({
      store,
      hole: {
        hole_id: "gc-hole",
        title: "GC Hole",
        root_id: "root",
        created_at: "2026-01-01T00:00:00.000Z",
        view_state: null,
        nodes: [root, childA, childB],
      },
    });
    return {
      deleteNode: (nodeId) => host.handleDeleteNode({ node_id: nodeId }),
      close: () => host.flushSave(),
    };
  },
});

async function verifyFreshDatabaseInitialization() {
  const store = new IdbStore({ dbName: `rabbithole-indexeddb-initialization-${Date.now()}` });
  assert.deepEqual(await store.listHoles(), [], "a fresh browser database should start empty");
  const db = await store.open();
  const tx = db.transaction(["holes", "hole-summaries", "assets", "staging", "meta"], "readonly");
  const counts = await Promise.all(["holes", "hole-summaries", "assets", "staging", "meta"].map((name) => requestResult(tx.objectStore(name).count())));
  assert.deepEqual(counts, [0, 0, 0, 0, 0], "all current browser stores should be initialized empty");
  store.close();
  console.log("ok IndexedDB initializes the complete current browser store");
}

async function verifyPersistencePermissionDoesNotBlockWrites() {
  let persistCalls = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      storage: {
        persist: () => {
          persistCalls += 1;
          return new Promise(() => {});
        },
      },
    },
  });

  const dbName = `rabbithole-indexeddb-persist-${Date.now()}`;
  const persistenceStore = new IdbStore({ dbName });
  const hole = createPendingHoleFromQuestion("Why must optional persistence never block a write?");
  await Promise.race([
    persistenceStore.saveHole(hole),
    new Promise((_, reject) => setTimeout(() => reject(new Error("saveHole waited for persistent-storage permission")), 1_000)),
  ]);
  assert.equal(persistCalls, 1, "persistent-storage permission should be requested once");
  assert.equal((await persistenceStore.loadHole(hole.hole_id))?.hole_id, hole.hole_id, "the document should be saved while permission remains pending");
  persistenceStore.close();
  assert.equal((await persistenceStore.loadHole(hole.hole_id))?.hole_id, hole.hole_id, "the store should reopen after releasing its connection");
  persistenceStore.close();
  console.log("ok pending persistent-storage permission does not block IndexedDB writes");
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rawHole(mode, value) {
  const db = await store.open();
  const tx = db.transaction("holes", mode);
  const request = mode === "readonly" ? tx.objectStore("holes").get(value) : tx.objectStore("holes").put(structuredClone(value));
  const result = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
  return mode === "readonly" && result ? structuredClone(result) : result;
}

console.log("IndexedDB store contract verification passed");

function node(overrides = {}) {
  return {
    id: "root",
    parent_id: null,
    title: "Root",
    markdown: "Root",
    base_url: null,
    base_url_source: null,
    origin: null,
    position: { x: 0, y: 0 },
    size: null,
    font_scale: 1,
    collapsed: false,
    status: "answered",
    read: true,
    created_at: "2026-01-01T00:00:00.000Z",
    extensions: { future_primitive: { attempts: [0, null, "雪", { correct: false }] } },
    ...overrides,
  };
}

function hole(overrides = {}) {
  return {
    hole_id: "contract-hole",
    title: "Contract Hole",
    root_id: "root",
    created_at: "2026-01-01T00:00:00.000Z",
    view_state: null,
    nodes: [node()],
    ...overrides,
  };
}

async function assertBytes(actual, expected, message) {
  assert(actual, message || "expected bytes");
  let bytes = actual;
  if (typeof Blob !== "undefined" && actual instanceof Blob) {
    bytes = new Uint8Array(await actual.arrayBuffer());
  }
  assert.deepEqual(Buffer.from(bytes), Buffer.from(expected));
}

async function runStoreContract(store, hooks) {
  await store.saveHole(hole());
  const loaded = await store.loadHole("contract-hole");
  assert.equal(loaded.schema_version, CURRENT_SCHEMA_VERSION);
  assert.equal(loaded.hole_id, "contract-hole");
  assert.equal(loaded.nodes.length, 1);
  assert.deepEqual(loaded.nodes[0].extensions, node().extensions, "extension bag should survive save/load structurally");

  const raw = await hooks.readRawHole("contract-hole");
  assert.equal(raw.schema_version, CURRENT_SCHEMA_VERSION, "saveHole should stamp schema_version");
  assert.deepEqual(raw.nodes[0].extensions, node().extensions, "raw persisted record should carry the extension bag");

  const listed = await store.listHoles();
  assert(listed.some((entry) => entry.hole_id === "contract-hole" && entry.node_count === 1));

  await store.deleteHole("contract-hole");
  assert.equal(await store.loadHole("contract-hole"), null);
  console.log("ok IndexedDB store: hole save/load/list/delete and schema stamping");

  const future = { ...hole({ hole_id: "future-hole" }), schema_version: 3, updated_at: "2026-01-01T00:00:00.000Z" };
  await hooks.writeRawHole("future-hole", future);
  await assert.rejects(() => store.loadHole("future-hole"), (error) => error?.message === NEWER_SCHEMA_MESSAGE);
  console.log("ok IndexedDB store: newer schema is refused with the update-to-open message");

  await store.putAsset("asset-hole", "diagram-1.png", PNG_BYTES);
  assert.deepEqual(await store.listAssets("asset-hole"), ["diagram-1.png"]);
  await assertBytes(await store.getAsset("asset-hole", "diagram-1.png"), PNG_BYTES);
  await store.putAsset("asset-hole", "diagram-2.png", new Uint8Array(PNG_BYTES_2));
  assert.deepEqual(await store.listAssets("asset-hole"), ["diagram-1.png", "diagram-2.png"]);
  await store.deleteAsset("asset-hole", "diagram-1.png");
  assert.equal(await store.getAsset("asset-hole", "diagram-1.png"), null);
  assert.deepEqual(await store.listAssets("asset-hole"), ["diagram-2.png"]);
  console.log("ok IndexedDB store: asset put/get/list/delete");

  const staged = await store.createStaging();
  assert.match(staged.ingest_id, /^ingest-/);
  await store.putStagedAsset(staged.ingest_id, "page-001.png", PNG_BYTES);
  const adopted = await store.adoptStagedAssets("staged-hole", staged.ingest_id);
  assert.deepEqual(adopted, ["page-001.png"]);
  await assertBytes(await store.getAsset("staged-hole", "page-001.png"), PNG_BYTES);
  await assert.rejects(() => store.adoptStagedAssets("staged-hole", staged.ingest_id), /Unknown ingest_id/);
  console.log("ok IndexedDB store: staging create/put/adopt");

  for (const bad of ["../bad", ".staging", "/tmp/bad", "bad/slash", "bad%2fslash"]) {
    await assert.rejects(() => store.saveHole(hole({ hole_id: bad })), /Invalid hole id/);
    await assert.rejects(() => store.putAsset(bad, "safe.png", PNG_BYTES), /Invalid hole id/);
  }
  for (const bad of ["Bad.png", "../bad.png", "nested/bad.png", "bad.bmp", "bad%2e.png"]) {
    await assert.rejects(() => store.putAsset("safe-hole", bad, PNG_BYTES), /asset name|Filename|extension/);
    await assert.rejects(() => store.putStagedAsset("ingest-safe", bad, PNG_BYTES), /asset name|Filename|extension/);
  }
  await assert.rejects(() => store.putStagedAsset("../bad", "safe.png", PNG_BYTES), /Invalid ingest id/);
  await assert.rejects(() => store.adoptStagedAssets("safe-hole", "../bad"), /Invalid ingest id/);
  console.log("ok IndexedDB store: safety validation rejects bad ids, names, and traversal");

  await store.putAsset("gc-hole", "shared.png", PNG_BYTES);
  const root = node({ id: "root", title: "Root", markdown: "Root" });
  const childA = node({
    id: "child-a",
    parent_id: "root",
    title: "A",
    markdown: "A ![shared](asset:shared.png)",
    read: false,
  });
  const childB = node({
    id: "child-b",
    parent_id: "root",
    title: "B",
    markdown: "B ![shared](asset:shared.png)",
    read: false,
  });
  const host = await hooks.makeDeleteHost({ root, childA, childB });
  await host.deleteNode("child-a");
  await assertBytes(await store.getAsset("gc-hole", "shared.png"), PNG_BYTES, "asset referenced by remaining node should survive");
  await host.deleteNode("child-b");
  assert.equal(await store.getAsset("gc-hole", "shared.png"), null, "asset should be removed after final reference is deleted");
  await host.close?.();
  console.log("ok IndexedDB store: asset GC keeps shared references and deletes the final unreferenced asset");
}
