import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertRabbitholeStore } from "../src/core/store.js";
import { FsStore } from "../src/node/fs-store.js";
import { RabbitHoleSession } from "../src/node/transport/session.js";
import { runStoreContract } from "./support/store-contract.mjs";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-stage9-"));

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
        session.close("stage9_complete");
        await session.savingChain;
      },
    };
  },
});

console.log("stage9 store contract verification passed");
