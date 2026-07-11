import { assertRabbitholeStore } from "../../src/core/store.js";
import { IdbStore } from "../../src/web/store/idb-store.js";
import { DirectRabbitholeHost } from "../../src/web/transport/direct-host.js";
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
