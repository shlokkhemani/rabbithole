import assert from "node:assert/strict";
import { assertRabbitholeStore } from "../../src/core/store.js";
import { IdbStore } from "../../src/web/store/idb-store.js";
import { createPendingHoleFromQuestion, DirectRabbitholeHost } from "../../src/web/transport/direct-host.js";
import { runStoreContract } from "../support/store-contract.mjs";

import "fake-indexeddb/auto";

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
