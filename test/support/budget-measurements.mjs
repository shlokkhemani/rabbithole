import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { collectSubtreeIds } from "../../src/core/model.js";
import { buildSnapshotHtml } from "../../src/core/snapshot-html.js";
import { createNoraSnapshotProjection } from "../../src/core/snapshot-projection.js";
import { createDocumentState, reduceDocumentEvent } from "../../src/core/document-state.js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

export const budgetDefinitions = [
  ["bundle_client_bytes", "Built Nora webview bundle size", "bytes", 0.05, "Exact file size after a deterministic build."],
  ["bundle_frozen_client_bytes", "Built frozen snapshot client bundle size", "bytes", 0.05, "Exact file size after a deterministic build."],
  ["pdf_runtime_distribution_bytes", "Production PDF.js runtime plus worker", "bytes", 0.05, "Exact size of the lazily loaded production PDF.js module and worker."],
  ["snapshot_math_bytes", "Frozen HTML size for a math-heavy Nora document", "bytes", 0.05, "Exact UTF-8 snapshot size."],
  ["snapshot_assets_bytes", "Frozen HTML size for an asset-bearing Nora document", "bytes", 0.05, "Exact UTF-8 snapshot size including assets."],
  ["snapshot_math_build_ms", "Mean frozen-HTML build time (20 warm builds) for the math-heavy Nora document", "ms", 2, "Mean of a 20-build loop defeats timer coarsening; 3x ceiling plus a 25ms floor absorbs host noise.", 25],
  ["snapshot_assets_build_ms", "Mean frozen-HTML build time (20 warm builds) for the asset-bearing Nora document", "ms", 2, "Mean of a 20-build loop defeats timer coarsening; 3x ceiling plus a 25ms floor absorbs host noise.", 25],
  ["pdf_hole_serialized_bytes", "Serialized size of a representative 40-page PDF Nora document", "bytes", 0.2, "Exact JSON byte size catches provenance growth."],
  ["pdf_save_latency_ms", "JSON clone/serialize latency for a representative PDF Nora document save", "ms", 4, "Minimum of repeated 20-save loops with a 20ms floor absorbs timer noise.", 20],
  ["owned_stream_reducer_ms", "One hundred stream updates in a 2,000-node Nora document", "ms", 4, "Minimum of repeated runs; a 10ms floor catches accidental whole-document churn while absorbing host noise.", 10],
  ["subtree_collect_ms", "Collect all descendants in a 20,000-node ternary tree", "ms", 4, "Minimum of repeated runs; a 25ms floor catches repeated whole-graph scans while absorbing host noise.", 25],
].map(([id, description, unit, tolerance, rationale, floor]) => ({ id, description, unit, tolerance, rationale, ...(floor ? { floor } : {}) }));

export async function measureBudgets({ samples = 3, onSample = () => {} } = {}) {
  assert(samples >= 3, "budget measurements require at least three samples");
  ensureNoraBuild();
  const exact = {
    bundle_client_bytes: (await fs.stat(path.join(ROOT, "out/webview/nora-entry.js"))).size,
    bundle_frozen_client_bytes: (await fs.stat(path.join(ROOT, "out/webview/frozen-client.js"))).size,
    pdf_runtime_distribution_bytes: (await fs.stat(path.join(ROOT, "out/webview/pdf.mjs"))).size + (await fs.stat(path.join(ROOT, "out/webview/pdf.worker.mjs"))).size,
  };
  const pdfDocument = representativePdfDocument();
  const scaleNodes = Array.from({ length: 2000 }, (_, i) => ({ id: `scale-${i}`, parentId: i ? `scale-${Math.floor((i - 1) / 3)}` : null, markdown: "" }));
  const scaleMap = new Map(Array.from({ length: 20000 }, (_, i) => [`scale-${i}`, { id: `scale-${i}`, parentId: i ? `scale-${Math.floor((i - 1) / 3)}` : null }]));
  exact.pdf_hole_serialized_bytes = Buffer.byteLength(JSON.stringify(pdfDocument));
  const values = Object.fromEntries(budgetDefinitions.map(({ id }) => [id, []]));
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let run = 0; run < 20; run++) JSON.parse(JSON.stringify(pdfDocument));
    values.pdf_save_latency_ms.push((performance.now() - start) / 20);
    let state = createDocumentState({ documentId: "scale-doc", title: "Scale", rootNodeId: "scale-0", nodes: scaleNodes });
    const reducerStart = performance.now();
    for (let update = 0; update < 100; update++) {
      state = reduceDocumentEvent(state, { type: "node_progress", node_id: "scale-1999", markdown: `chunk ${update}` }).state;
    }
    values.owned_stream_reducer_ms.push(performance.now() - reducerStart);
    const subtreeStart = performance.now();
    collectSubtreeIds(scaleMap, "scale-0");
    values.subtree_collect_ms.push(performance.now() - subtreeStart);
  }
  const fixtureResults = await measureSnapshots(samples, onSample);
  Object.assign(exact, fixtureResults.exact);
  for (const [id, list] of Object.entries(fixtureResults.timings)) values[id].push(...list);
  for (const [id, value] of Object.entries(exact)) values[id] = [value];
  return Object.fromEntries(Object.entries(values).map(([id, list]) => [id, {
    value: Math.min(...list),
    samples: list,
  }]));
}

function ensureNoraBuild() {
  const result = spawnSync(process.execPath, ["scripts/build-nora.mjs", "--outdir", "out"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Nora build failed for performance budgets:\n${result.stderr || result.stdout}`);
  }
}

function representativePdfDocument() {
  const markdown = "# PDF budget\n" + Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n") + "\n";
  let offset = "# PDF budget\n".length;
  const lines = Array.from({ length: 2000 }, (_, i) => {
    const length = `line ${i}`.length;
    const line = { p: Math.floor(i / 50) + 1, s: offset, e: offset + length };
    offset += length + 1;
    return line;
  });
  const sha256 = "ab".repeat(32);
  return noraDocument("pdf-budget", "PDF budget", [{
    id: "root",
    markdown,
    extensions: { pdf: {
      version: 2,
      source: { asset: `pdf-${sha256}.pdf`, sha256, byte_length: 10 * 1024 * 1024 },
      page_count: 40,
      pages: Array.from({ length: 40 }, (_, i) => ({ n: i + 1, view: [0, 0, 612, 792], rotate: 0, user_unit: 1 })),
      lines,
    } },
  }]);
}

async function measureSnapshots(samples, onSample) {
  const exact = {};
  const timings = { snapshot_math_build_ms: [], snapshot_assets_build_ms: [] };
  const bundle = await loadSnapshotBundle();
  for (const testCase of snapshotCases()) {
    const projection = createNoraSnapshotProjection(testCase.document, testCase.document.viewState, testCase.assets);
    let html = "";
    for (let i = 0; i < samples; i++) {
      const runs = 20;
      const start = performance.now();
      for (let run = 0; run < runs; run++) {
        html = buildSnapshotHtml({
          title: testCase.document.title,
          snapshotProjection: projection,
          ...bundle,
        });
      }
      const elapsed = (performance.now() - start) / runs;
      timings[`snapshot_${testCase.stem}_build_ms`].push(elapsed);
      onSample(`snapshot_${testCase.stem}_build_ms`, elapsed, i + 1, samples);
    }
    exact[`snapshot_${testCase.stem}_bytes`] = Buffer.byteLength(html);
  }
  return { exact, timings };
}

function snapshotCases() {
  return [
    {
      stem: "math",
      document: noraDocument("snapshot-math", "Math Snapshot", [{
        id: "root",
        markdown: "# Math\n\n" + Array.from({ length: 80 }, (_, i) => `Formula ${i}: $x_${i}^2 + y_${i}^2 = z_${i}^2$ and $$\\sum_{n=0}^{${i}} n^2$$.`).join("\n\n"),
      }]),
      assets: {},
    },
    {
      stem: "assets",
      document: noraDocument("snapshot-assets", "Asset Snapshot", [{
        id: "root",
        markdown: "# Assets\n\n![Figure](asset:figure.png)\n\nAsset-heavy notes stay self-contained in frozen snapshots.\n",
        attachmentIds: ["figure"],
      }], [{ id: "figure", sha256: "cd".repeat(32), mediaType: "image/png", title: "Figure", filename: "figure.png", bytes: 5, extensions: { assetName: "figure.png" } }]),
      assets: { "figure.png": "aGVsbG8=" },
    },
  ];
}

function noraDocument(documentId, title, nodes, attachments = []) {
  return {
    schemaVersion: 1,
    documentId,
    title,
    rootNodeId: "root",
    createdAt: null,
    updatedAt: null,
    viewState: { mode: "reader", node_id: "root", scroll: 0 },
    selection: null,
    selectedProfileId: null,
    nodes: nodes.map((node) => ({
      id: node.id,
      parentId: node.parentId ?? null,
      title: node.title ?? "Root",
      markdown: node.markdown ?? "",
      baseUrl: null,
      baseUrlSource: null,
      origin: null,
      position: { x: 0, y: 0 },
      size: null,
      fontScale: 1,
      collapsed: false,
      state: "complete",
      read: false,
      createdAt: null,
      updatedAt: null,
      sourceIds: [],
      evidenceIds: [],
      attachmentIds: node.attachmentIds ?? [],
      runId: null,
      extensions: node.extensions ?? {},
    })),
    edges: [],
    sources: [],
    evidence: [],
    attachments: attachments.map((attachment) => ({
      sourceId: null,
      evidenceIds: [],
      createdAt: null,
      ...attachment,
    })),
    runs: [],
    checks: [],
    extensions: {},
  };
}

async function loadSnapshotBundle() {
  const read = (name) => fs.readFile(path.join(ROOT, "out/webview", name), "utf8");
  return {
    stylesheetText: `${await read("canvas.css")}\n${await read("katex.css")}`,
    dompurifySource: await read("dompurify.js"),
    mermaidSource: await read("mermaid.js"),
    frozenClientSource: await read("frozen-client.js"),
    pdfJsSource: await read("pdf.mjs"),
    pdfWorkerSource: await read("pdf.worker.mjs"),
  };
}
