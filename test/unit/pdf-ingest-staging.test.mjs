import assert from "node:assert/strict";
import { ingestPdfToStoredHole } from "../../src/web/ingest/pdf.js";

const sha256 = "ef".repeat(32);
const sourceInfo = { asset: `pdf-${sha256}.pdf`, sha256, byte_length: 8 };
const okResult = {
  title: "Staged", page_count: 1, processed_pages: [1], source: sourceInfo,
  page_metadata: [{ n: 1, view: [12, 20, 252, 220], rotate: 90, user_unit: 1 }],
  page_lines: [{ page: 1, lines: [{ text: "hello" }] }], notes: [],
};
const okIngest = async (_source, { onSource }) => {
  await onSource(sourceInfo, new Blob(["%PDF-v2"], { type: "application/pdf" }));
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

{
  const calls = [];
  const { hole } = await ingestPdfToStoredHole({ source: null, store: makeStore(calls), ingest: okIngest });
  assert.deepEqual(calls, ["createStaging", `staged:${sourceInfo.asset}`, "saveHole", "adopt"]);
  assert.equal(hole.nodes[0].extensions.pdf.version, 2);
  assert.deepEqual(hole.nodes[0].extensions.pdf.source, sourceInfo);
  assert.match(hole.nodes[0].markdown, /hello/);
}

{
  const calls = [];
  const store = makeStore(calls, { putStagedAsset: async () => { throw new Error("QuotaExceededError: storage full"); } });
  await assert.rejects(() => ingestPdfToStoredHole({ source: null, store, ingest: okIngest }), /QuotaExceededError/);
  assert.deepEqual(calls, ["createStaging", "discard"]);
}

{
  const calls = [];
  const failingIngest = async (_source, { onSource }) => { await onSource(sourceInfo, new Blob(["%PDF"])); throw new Error("PDF could not be opened"); };
  await assert.rejects(() => ingestPdfToStoredHole({ source: null, store: makeStore(calls), ingest: failingIngest }), /could not be opened/);
  assert.deepEqual(calls, ["createStaging", `staged:${sourceInfo.asset}`, "discard"]);
}

{
  const calls = [];
  const store = makeStore(calls, { adoptStagedAssets: async () => { throw new Error("adopt failed"); } });
  await assert.rejects(() => ingestPdfToStoredHole({ source: null, store, ingest: okIngest }), /adopt failed/);
  assert.deepEqual(calls, ["createStaging", `staged:${sourceInfo.asset}`, "saveHole", "discard", "deleteHole"]);
}

console.log("ok PDF v2 ingest staging: one original source is adopted and all failures clean up");
