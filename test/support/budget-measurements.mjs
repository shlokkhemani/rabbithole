import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { ensureWebDist } from "./build.mjs";
import { routeProvider, seedConfiguredOpenRouter } from "./provider-mock.mjs";
import { serveStatic } from "./static-server.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const WEB_DIST = path.join(ROOT, "web/dist");
const FIXTURES = ["02-math-heavy.rabbithole", "04-assets-png-svg.rabbithole"];
const STREAM_CHUNKS = Array.from({ length: 40 }, (_, i) => `${i ? " " : "# Budget stream\n\n"}token-${i}`);

export const budgetDefinitions = [
  ["bundle_client_bytes", "Built live client bundle size", "bytes", 0.05, "Exact file size after a deterministic build."],
  ["bundle_frozen_client_bytes", "Built frozen client bundle size", "bytes", 0.05, "Exact file size after a deterministic build."],
  ["snapshot_math_bytes", "Frozen HTML size for the math-heavy reference corpus", "bytes", 0.05, "Exact UTF-8 snapshot size."],
  ["snapshot_assets_bytes", "Frozen HTML size for the PNG/SVG reference corpus", "bytes", 0.05, "Exact UTF-8 snapshot size including assets."],
  ["snapshot_math_build_ms", "Mean frozen-HTML build time (20 warm builds) for the math-heavy reference corpus", "ms", 2, "Mean of a 20-build loop defeats timer coarsening; 3x ceiling plus a 25ms floor absorbs host noise.", 25],
  ["snapshot_assets_build_ms", "Mean frozen-HTML build time (20 warm builds) for the PNG/SVG reference corpus", "ms", 2, "Mean of a 20-build loop defeats timer coarsening; 3x ceiling plus a 25ms floor absorbs host noise.", 25],
  ["cold_open_ms", "Cold navigation to the visible interactive setup landing", "ms", 2, "Minimum of isolated browser-context samples; 3x ceiling absorbs startup noise."],
  ["stream_dom_batches", "DOM mutation batches for a fixed 40-update synthetic stream", "batches", 1, "Minimum observed batch count on an otherwise-quiescent page; 2x ceiling with a 6-batch floor catches loss of rAF coalescing (which produces dozens of batches) without flaking.", 6],
  ["stream_update_ms", "Total browser duration for a fixed 40-update synthetic stream", "ms", 2, "Minimum of repeated samples; 3x ceiling absorbs browser scheduling noise."],
  ["save_window_ms", "Elapsed time from final streamed DOM update until the final markdown is persisted", "ms", 1, "Minimum of repeated samples; 2x ceiling with a 100ms floor (poll quantization) still catches a lost flush-on-complete, which costs 400ms+.", 100],
  ["pdf_hole_serialized_bytes", "Serialized size of a representative 40-page native PDF hole", "bytes", 0.2, "Exact JSON byte size catches provenance growth."],
  ["pdf_save_latency_ms", "JSON clone/serialize latency for a representative native PDF save", "ms", 4, "Minimum of repeated 20-save loops with a 20ms floor absorbs timer noise.", 20],
].map(([id, description, unit, tolerance, rationale, floor]) => ({ id, description, unit, tolerance, rationale, ...(floor ? { floor } : {}) }));

export async function measureBudgets({ samples = 3, onSample = () => {} } = {}) {
  assert(samples >= 3, "budget measurements require at least three samples");
  ensureWebDist();
  const exact = {
    bundle_client_bytes: (await fs.stat(path.join(ROOT, "dist/client.js"))).size,
    bundle_frozen_client_bytes: (await fs.stat(path.join(ROOT, "dist/frozen-client.js"))).size,
  };
  const pdfHole = representativePdfHole();
  exact.pdf_hole_serialized_bytes = Buffer.byteLength(JSON.stringify(pdfHole));
  const server = await serveStatic(WEB_DIST);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const values = Object.fromEntries(budgetDefinitions.map(({ id }) => [id, []]));
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let run = 0; run < 20; run++) JSON.parse(JSON.stringify(pdfHole));
    values.pdf_save_latency_ms.push((performance.now() - start) / 20);
  }
  try {
    const fixtureResults = await measureSnapshots(browser, baseUrl, samples, onSample);
    Object.assign(exact, fixtureResults.exact);
    for (const [id, list] of Object.entries(fixtureResults.timings)) values[id].push(...list);
    for (let i = 0; i < samples; i++) {
      const cold = await measureColdOpen(browser, baseUrl);
      values.cold_open_ms.push(cold);
      onSample("cold_open_ms", cold, i + 1, samples);
      const stream = await measureStreamAndSave(browser, baseUrl);
      for (const id of ["stream_dom_batches", "stream_update_ms", "save_window_ms"]) {
        values[id].push(stream[id]);
        onSample(id, stream[id], i + 1, samples);
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
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
    const line = { p: Math.floor(i / 50) + 1, x: .1, y: .1, w: .8, h: .02, s: offset, e: offset + length };
    offset += length + 1;
    return line;
  });
  return { hole_id: "pdf-budget", title: "PDF budget", root_id: "root", nodes: [{ id: "root", markdown, extensions: { pdf: { version: 1, scale: 2, page_count: 40, pages: Array.from({ length: 40 }, (_, i) => ({ n: i + 1, asset: `page-${String(i + 1).padStart(3, "0")}.jpg`, w: 1224, h: 1584 })), lines } } }] };
}

async function measureSnapshots(browser, baseUrl, samples, onSample) {
  const exact = {};
  const timings = { snapshot_math_build_ms: [], snapshot_assets_build_ms: [] };
  for (const fixtureName of FIXTURES) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      await page.setInputFiles("#file-md", path.join(ROOT, "test/fixtures/corpus", fixtureName));
      await page.waitForFunction(() => window.__rabbitholeTest?.currentHoleId?.() && document.querySelector(".doc-content"));
      const stem = fixtureName.startsWith("02-") ? "math" : "assets";
      let html = "";
      for (let i = 0; i < samples; i++) {
        // Single builds finish under Chromium's coarsened timer resolution;
        // a 20-build loop per sample yields a measurable mean.
        const result = await page.evaluate(async () => {
          const runs = 20;
          const start = performance.now();
          let snapshot = "";
          for (let run = 0; run < runs; run++) snapshot = await window.__rabbitholeTest.exportSnapshot();
          return { elapsed: (performance.now() - start) / runs, snapshot };
        });
        html = result.snapshot;
        timings[`snapshot_${stem}_build_ms`].push(result.elapsed);
        onSample(`snapshot_${stem}_build_ms`, result.elapsed, i + 1, samples);
      }
      exact[`snapshot_${stem}_bytes`] = Buffer.byteLength(html);
    } finally {
      await context.close();
    }
  }
  return { exact, timings };
}

async function measureColdOpen(browser, baseUrl) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/?budget=${Date.now()}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const landing = document.getElementById("blank-start");
      const setup = document.getElementById("blank-start-setup");
      return window.__rabbitholeTest && landing && !landing.hidden && setup && setup.offsetParent !== null;
    });
    return await page.evaluate(() => performance.now());
  } finally {
    await context.close();
  }
}

async function measureStreamAndSave(browser, baseUrl) {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  await routeProvider(page, { streams: [STREAM_CHUNKS], keyLabel: "budget" });
  try {
    await page.goto(`${baseUrl}/?stream-budget=${Date.now()}`, { waitUntil: "networkidle" });
    await page.click("#blank-start-new");
    await page.evaluate(() => {
      // Streaming repaints swap innerHTML on the card body (the parent of
      // .doc-content), so no ancestor filter can see them; the page is
      // otherwise quiescent during the measured window, so every callback
      // flush is streaming cost. Count flushes, not records.
      window.__budget = { batches: 0, first: 0, final: 0 };
      const observer = new MutationObserver(() => {
        window.__budget.batches += 1;
        if (!window.__budget.first) window.__budget.first = performance.now();
        window.__budget.final = performance.now();
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await page.click("#composer-path-ask");
    await page.fill("#composer-input", "Measure the fixed synthetic stream");
    const started = await page.evaluate(() => performance.now());
    await page.click("#composer-primary");
    const finalText = `token-${STREAM_CHUNKS.length - 1}`;
    await page.locator(".doc-content", { hasText: finalText }).first().waitFor();
    const observed = await page.evaluate(() => ({ ...window.__budget, now: performance.now() }));
    const holeId = await page.evaluate(() => window.__rabbitholeTest.currentHoleId());
    const saveStart = observed.final || observed.now;
    await page.waitForFunction(async ({ id, text }) => {
      const hole = await window.__rabbitholeTest.readStoredHole(id);
      return hole?.nodes?.some((node) => String(node.markdown || "").includes(text));
    }, { id: holeId, text: finalText }, { polling: 20, timeout: 5000 });
    const savedAt = await page.evaluate(() => performance.now());
    return {
      stream_dom_batches: observed.batches,
      stream_update_ms: observed.now - started,
      save_window_ms: savedAt - saveStart,
    };
  } finally {
    await context.close();
  }
}
