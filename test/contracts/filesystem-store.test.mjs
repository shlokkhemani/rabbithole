import fs from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { assertRabbitholeStore } from "../../src/core/store.js";
import { FsStore } from "../../src/node/fs-store.js";
import { RabbitHoleSession } from "../../src/node/transport/session.js";
import { runStoreContract } from "../support/store-contract.mjs";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-filesystem-store-"));

const store = assertRabbitholeStore(new FsStore());

await runStoreContract(store, {
  readRawHole: async (holeId) => JSON.parse(await fs.readFile(path.join(process.env.RABBITHOLE_DIR, `${holeId}.json`), "utf8")),
  writeRawHole: async (holeId, fixture) => fs.writeFile(path.join(process.env.RABBITHOLE_DIR, `${holeId}.json`), JSON.stringify(fixture, null, 2), "utf8"),
  makeDeleteHost: async ({ root, childA, childB }) => {
    const session = new RabbitHoleSession({
      holeId: "gc-hole",
      title: "GC Hole",
      rootId: "root",
      nodes: [root, childA, childB],
      assetNames: new Set(["shared.png"]),
      isResume: false,
      renderPage: () => "",
    });
    return {
      deleteNode: (nodeId) => session.handleDeleteNode({ node_id: nodeId }),
      close: async () => {
        session.close("filesystem_store_test_complete");
        await session.savingChain;
      },
    };
  },
});

const concurrentBase = { hole_id: "concurrent-hole", root_id: "root", nodes: [{ id: "root", markdown: "body" }] };
await Promise.all([
  store.saveHole({ ...concurrentBase, title: "First" }),
  store.saveHole({ ...concurrentBase, title: "Second" }),
]);
const concurrentHole = await store.loadHole("concurrent-hole");
const concurrentSummary = JSON.parse(await fs.readFile(path.join(process.env.RABBITHOLE_DIR, "concurrent-hole.summary.json"), "utf8"));
assert.equal(concurrentHole.title, "Second");
assert.equal(concurrentSummary.title, concurrentHole.title, "serialized save queue keeps the sidecar atomic with its hole");

console.log("filesystem store contract verification passed");
