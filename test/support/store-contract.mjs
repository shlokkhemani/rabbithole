import assert from "node:assert/strict";
import { CURRENT_SCHEMA_VERSION } from "../../src/core/schema.js";

export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
export const PNG_BYTES_2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 8, 8, 8, 8]);

export function node(overrides = {}) {
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
    ...overrides,
  };
}

export function hole(overrides = {}) {
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

export async function assertBytes(actual, expected, message) {
  assert(actual, message || "expected bytes");
  let bytes = actual;
  if (typeof Blob !== "undefined" && actual instanceof Blob) {
    bytes = new Uint8Array(await actual.arrayBuffer());
  }
  assert.deepEqual(Buffer.from(bytes), Buffer.from(expected));
}

export async function runHoleContract(store, hooks) {
  await store.saveHole(hole());
  const loaded = await store.loadHole("contract-hole");
  assert.equal(loaded.schema_version, CURRENT_SCHEMA_VERSION);
  assert.equal(loaded.hole_id, "contract-hole");
  assert.equal(loaded.nodes.length, 1);

  const raw = await hooks.readRawHole("contract-hole");
  assert.equal(raw.schema_version, CURRENT_SCHEMA_VERSION, "saveHole should stamp schema_version");

  const listed = await store.listHoles();
  assert(listed.some((entry) => entry.hole_id === "contract-hole" && entry.node_count === 1));

  await store.deleteHole("contract-hole");
  assert.equal(await store.loadHole("contract-hole"), null);
  console.log("ok stage9: hole save/load/list/delete and schema stamping");
}

export async function runMigrationContract(store, hooks) {
  const fixture = {
    hole_id: "legacy-hole",
    title: "Legacy Hole",
    root_id: "root",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    view_state: null,
    nodes: [
      node({
        markdown: ["---", "base_url: https://example.com/docs/root.md", "---", "Root"].join("\n"),
      }),
      node({
        id: "child",
        parent_id: "root",
        title: "Child",
        markdown: "Child",
        read: false,
      }),
    ].map((entry) => {
      const { base_url, base_url_source, ...withoutBase } = entry;
      return withoutBase;
    }),
  };
  await hooks.writeRawHole("legacy-hole", fixture);

  const migrated = await store.loadHole("legacy-hole");
  assert.equal(migrated.schema_version, CURRENT_SCHEMA_VERSION);
  assert.equal(migrated.nodes[0].base_url, "https://example.com/docs/root.md");
  assert.equal(migrated.nodes[0].base_url_source, "frontmatter");
  assert.equal(migrated.nodes[1].base_url, "https://example.com/docs/root.md");
  assert.equal(migrated.nodes[1].base_url_source, "inherited");

  const saved = await hooks.readRawHole("legacy-hole");
  assert.equal(saved.schema_version, CURRENT_SCHEMA_VERSION, "loadHole should save migrated v0 files");
  await store.saveHole(migrated);
  assert.equal((await store.loadHole("legacy-hole")).schema_version, CURRENT_SCHEMA_VERSION);
  console.log("ok stage9: v0.2 fixture migrates, saves, and reloads as schema v1");
}

export async function runAssetContract(store) {
  await store.putAsset("asset-hole", "diagram-1.png", PNG_BYTES);
  assert.deepEqual(await store.listAssets("asset-hole"), ["diagram-1.png"]);
  await assertBytes(await store.getAsset("asset-hole", "diagram-1.png"), PNG_BYTES);
  await store.putAsset("asset-hole", "diagram-2.png", new Uint8Array(PNG_BYTES_2));
  assert.deepEqual(await store.listAssets("asset-hole"), ["diagram-1.png", "diagram-2.png"]);
  await store.deleteAsset("asset-hole", "diagram-1.png");
  assert.equal(await store.getAsset("asset-hole", "diagram-1.png"), null);
  assert.deepEqual(await store.listAssets("asset-hole"), ["diagram-2.png"]);
  console.log("ok stage9: asset put/get/list/delete");
}

export async function runStagingContract(store) {
  const staged = await store.createStaging();
  assert.match(staged.ingest_id, /^ingest-/);
  await store.putStagedAsset(staged.ingest_id, "page-001.png", PNG_BYTES);
  const adopted = await store.adoptStagedAssets("staged-hole", staged.ingest_id);
  assert.deepEqual(adopted, ["page-001.png"]);
  await assertBytes(await store.getAsset("staged-hole", "page-001.png"), PNG_BYTES);
  await assert.rejects(() => store.adoptStagedAssets("staged-hole", staged.ingest_id), /Unknown ingest_id/);
  console.log("ok stage9: staging create/put/adopt");
}

export async function runSafetyContract(store) {
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
  console.log("ok stage9: safety validation rejects bad ids, names, and traversal");
}

export async function runAssetGcFixture(store, makeDeleteHost) {
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
  const host = await makeDeleteHost({ root, childA, childB });

  await host.deleteNode("child-a");
  await assertBytes(await store.getAsset("gc-hole", "shared.png"), PNG_BYTES, "asset referenced by remaining node should survive");
  await host.deleteNode("child-b");
  assert.equal(await store.getAsset("gc-hole", "shared.png"), null, "asset should be removed after final reference is deleted");
  await host.close?.();
  console.log("ok stage9: asset GC keeps shared references and deletes the final unreferenced asset");
}

export async function runStoreContract(store, hooks) {
  await runHoleContract(store, hooks);
  await runMigrationContract(store, hooks);
  await runAssetContract(store);
  await runStagingContract(store);
  await runSafetyContract(store);
  await runAssetGcFixture(store, hooks.makeDeleteHost);
}
