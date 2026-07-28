import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureWebDist } from "./build.mjs";
import { collectSubtreeIds } from "../../src/core/model.js";
import { createHoleState, reduceHoleEvent } from "../../src/core/reducer.js";
import { buildSnapshotHtml } from "../../src/core/snapshot-html.js";
import { createSnapshotProjection } from "../../src/core/snapshot-projection.js";
import { CANVAS_STYLES } from "../../src/core/html/styles.js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const FIXTURES = ["02-math-heavy.rabbithole", "04-assets-png-svg.rabbithole"];

export const budgetDefinitions = [
  ["bundle_client_bytes", "Built live client bundle size", "bytes", 0.05, "Exact file size after a deterministic build."],
  ["bundle_frozen_client_bytes", "Built frozen client bundle size", "bytes", 0.05, "Exact file size after a deterministic build."],
  ["pdf_runtime_distribution_bytes", "Production PDF.js runtime plus worker", "bytes", 0.05, "Exact size of the lazily loaded production PDF.js module and worker."],
  ["snapshot_math_bytes", "Frozen HTML size for the math-heavy reference corpus", "bytes", 0.05, "Exact UTF-8 snapshot size."],
  ["snapshot_assets_bytes", "Frozen HTML size for the PNG/SVG reference corpus", "bytes", 0.05, "Exact UTF-8 snapshot size including assets."],
  ["snapshot_math_build_ms", "Mean frozen-HTML build time (20 warm builds) for the math-heavy reference corpus", "ms", 2, "Mean of a 20-build loop defeats timer coarsening; 3x ceiling plus a 25ms floor absorbs host noise.", 25],
  ["snapshot_assets_build_ms", "Mean frozen-HTML build time (20 warm builds) for the PNG/SVG reference corpus", "ms", 2, "Mean of a 20-build loop defeats timer coarsening; 3x ceiling plus a 25ms floor absorbs host noise.", 25],
  ["pdf_hole_serialized_bytes", "Serialized size of a representative 40-page native PDF hole", "bytes", 0.2, "Exact JSON byte size catches provenance growth."],
  ["pdf_save_latency_ms", "JSON clone/serialize latency for a representative native PDF save", "ms", 4, "Minimum of repeated 20-save loops with a 20ms floor absorbs timer noise.", 20],
  ["owned_stream_reducer_ms", "One hundred owned-state stream updates in a 20,000-node hole", "ms", 4, "Minimum of repeated runs; a 10ms floor catches accidental whole-Map cloning while absorbing timer noise.", 10],
  ["subtree_collect_ms", "Collect all descendants in a 20,000-node ternary tree", "ms", 4, "Minimum of repeated runs; a 25ms floor catches repeated whole-graph scans while absorbing timer noise.", 25],
].map(([id, description, unit, tolerance, rationale, floor]) => ({ id, description, unit, tolerance, rationale, ...(floor ? { floor } : {}) }));

export async function measureBudgets({ samples = 3, onSample = () => {} } = {}) {
  assert(samples >= 3, "budget measurements require at least three samples");
  ensureWebDist();
  const exact = {
    bundle_client_bytes: (await fs.stat(path.join(ROOT, "dist/client.js"))).size,
    bundle_frozen_client_bytes: (await fs.stat(path.join(ROOT, "dist/frozen-client.js"))).size,
    pdf_runtime_distribution_bytes: (await fs.stat(path.join(ROOT, "dist/pdf.mjs"))).size + (await fs.stat(path.join(ROOT, "dist/pdf.worker.mjs"))).size,
  };
  const pdfHole = representativePdfHole();
  const scaleNodes = Array.from({ length: 20000 }, (_, i) => ({ id: `scale-${i}`, parent_id: i ? `scale-${Math.floor((i - 1) / 3)}` : null, markdown: "" }));
  const scaleMap = new Map(scaleNodes.map((node) => [node.id, node]));
  exact.pdf_hole_serialized_bytes = Buffer.byteLength(JSON.stringify(pdfHole));
  const values = Object.fromEntries(budgetDefinitions.map(({ id }) => [id, []]));
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let run = 0; run < 20; run++) JSON.parse(JSON.stringify(pdfHole));
    values.pdf_save_latency_ms.push((performance.now() - start) / 20);
    let state = createHoleState({ root_id: "scale-0", nodes: scaleNodes });
    const reducerStart = performance.now();
    for (let update = 0; update < 100; update++) {
      state = reduceHoleEvent(state, { type: "node_progress", node_id: "scale-19999", markdown: `chunk ${update}` }, { mutate: true }).state;
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

function representativePdfHole() {
  const markdown = "# PDF budget\n" + Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n") + "\n";
  let offset = "# PDF budget\n".length;
  const lines = Array.from({ length: 2000 }, (_, i) => {
    const length = `line ${i}`.length;
    const line = { p: Math.floor(i / 50) + 1, s: offset, e: offset + length };
    offset += length + 1;
    return line;
  });
  const sha256 = "ab".repeat(32);
  return { hole_id: "pdf-budget", title: "PDF budget", root_id: "root", nodes: [{ id: "root", markdown, extensions: { pdf: {
    version: 2,
    source: { asset: `pdf-${sha256}.pdf`, sha256, byte_length: 10 * 1024 * 1024 },
    page_count: 40,
    pages: Array.from({ length: 40 }, (_, i) => ({ n: i + 1, view: [0, 0, 612, 792], rotate: 0, user_unit: 1 })),
    lines,
  } } }] };
}

async function measureSnapshots(samples, onSample) {
  const exact = {};
  const timings = { snapshot_math_build_ms: [], snapshot_assets_build_ms: [] };
  const bundle = await loadSnapshotBundle();
  for (const fixtureName of FIXTURES) {
    const fixture = JSON.parse(await fs.readFile(path.join(ROOT, "test/fixtures/corpus", fixtureName), "utf8"));
    const projection = createSnapshotProjection(fixture.hole, fixture.hole.view_state, fixture.assets ?? {});
    const stem = fixtureName.startsWith("02-") ? "math" : "assets";
    let html = "";
    for (let i = 0; i < samples; i++) {
      const runs = 20;
      const start = performance.now();
      for (let run = 0; run < runs; run++) {
        html = buildSnapshotHtml({
          title: fixture.hole.title,
          snapshotProjection: projection,
          ...bundle,
        });
      }
      const elapsed = (performance.now() - start) / runs;
      timings[`snapshot_${stem}_build_ms`].push(elapsed);
      onSample(`snapshot_${stem}_build_ms`, elapsed, i + 1, samples);
    }
    exact[`snapshot_${stem}_bytes`] = Buffer.byteLength(html);
  }
  return { exact, timings };
}

async function loadSnapshotBundle() {
  const read = (name) => fs.readFile(path.join(ROOT, "dist", name), "utf8");
  return {
    stylesheetText: `${CANVAS_STYLES}\n${await read("katex.css")}`,
    dompurifySource: await read("dompurify.js"),
    mermaidSource: await read("mermaid.js"),
    frozenClientSource: await read("frozen-client.js"),
    pdfJsSource: await read("pdf.mjs"),
    pdfWorkerSource: await read("pdf.worker.mjs"),
  };
}
