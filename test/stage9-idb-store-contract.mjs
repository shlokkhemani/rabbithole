import { assertRabbitholeStore } from "../src/core/store.js";
import { IdbStore } from "../src/web/store/idb-store.js";
import { DirectRabbitholeHost } from "../src/web/transport/direct-host.js";
import { runStoreContract } from "./support/store-contract.mjs";

import "fake-indexeddb/auto";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
  storage: {
    persist: async () => true,
  },
  },
});

const store = assertRabbitholeStore(new IdbStore({ dbName: `rabbithole-stage9-idb-${Date.now()}` }));

await runStoreContract(store, {
  readRawHole: (holeId) => store.readRawHoleForTest(holeId),
  writeRawHole: (_holeId, fixture) => store.writeRawHoleForTest(fixture),
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

console.log("stage9 idb store contract verification passed");
