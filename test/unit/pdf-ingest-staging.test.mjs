import assert from "node:assert/strict";
import { ingestPdfToStoredHole } from "../../src/web/ingest/pdf.js";

// Every failure path of the staging flow must clean up after itself: no
// stranded staged assets, no half-saved holes. Ingest is injected so this
// exercises orchestration only — pdf.js never loads.

const pageAsset = { page: 1, name: "page-001.jpg", width: 10, height: 12 };
const okResult = {
  title: "Staged",
  page_count: 1,
  processed_pages: [1],
  assets: { pages: [pageAsset], embedded_images: [] },
  page_lines: [{ page: 1, lines: [{ text: "hello", x: 0.1, y: 0.1, w: 0.5, h: 0.05 }] }],
  notes: [],
};
const okIngest = async (_source, { onAsset }) => {
  await onAsset(pageAsset, new Blob(["jpeg"], { type: "image/jpeg" }));
  return okResult;
};

function makeStore(calls, overrides = {}) {
  return {
    createStaging: async () => { calls.push("createStaging"); return { ingest_id: "ingest-test" }; },
    putStagedAsset: async (_id, name) => { calls.push(`staged:${name}`); },
    saveHole: async () => { calls.push("saveHole"); },
    adoptStagedAssets: async () => { calls.push("adopt"); },
    discardStaging: async () => { calls.push("discard"); },
    deleteHole: async () => { calls.push("deleteHole"); },
    ...overrides,
  };
}

// Success: staged -> saved -> adopted; nothing discarded or deleted.
{
  const calls = [];
  const { hole } = await ingestPdfToStoredHole({ source: null, store: makeStore(calls), ingest: okIngest });
  assert.deepEqual(calls, ["createStaging", "staged:page-001.jpg", "saveHole", "adopt"]);
  assert.equal(hole.nodes[0].extensions.pdf.pages.length, 1);
  assert.match(hole.nodes[0].markdown, /hello/);
}

// Quota blows up while staging a page: discard, never save, surface the error.
{
  const calls = [];
  const store = makeStore(calls, { putStagedAsset: async () => { throw new Error("QuotaExceededError: storage full"); } });
  await assert.rejects(() => ingestPdfToStoredHole({ source: null, store, ingest: okIngest }), /QuotaExceededError/);
  assert.deepEqual(calls, ["createStaging", "discard"]);
}

// Extraction fails mid-document: discard, never save.
{
  const calls = [];
  const failingIngest = async (_source, { onAsset }) => {
    await onAsset(pageAsset, new Blob(["jpeg"], { type: "image/jpeg" }));
    throw new Error("PDF could not be opened by pdf.js: broken.pdf");
  };
  await assert.rejects(() => ingestPdfToStoredHole({ source: null, store: makeStore(calls), ingest: failingIngest }), /could not be opened/);
  assert.deepEqual(calls, ["createStaging", "staged:page-001.jpg", "discard"]);
}

// Saving the hole fails: discard staging; there is no saved hole to delete.
{
  const calls = [];
  const store = makeStore(calls, { saveHole: async () => { throw new Error("save failed"); } });
  await assert.rejects(() => ingestPdfToStoredHole({ source: null, store, ingest: okIngest }), /save failed/);
  assert.deepEqual(calls, ["createStaging", "staged:page-001.jpg", "discard"]);
}

// Adoption fails after the hole saved: discard staging AND delete the hole.
{
  const calls = [];
  const store = makeStore(calls, { adoptStagedAssets: async () => { throw new Error("adopt failed"); } });
  await assert.rejects(() => ingestPdfToStoredHole({ source: null, store, ingest: okIngest }), /adopt failed/);
  assert.deepEqual(calls, ["createStaging", "staged:page-001.jpg", "saveHole", "discard", "deleteHole"]);
}

console.log("ok PDF ingest staging: success adopts; extraction, quota, save, and adopt failures all clean up");
