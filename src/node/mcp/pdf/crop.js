import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { destroyPdfCanvasTarget, pdfAnchorBounds, resetPdfCanvasTarget } from "../../../core/pdf-shared.js";
import { renderPdfRegion as renderSharedPdfRegion } from "../../../core/pdf/crop.js";
import { ensureAssetDir, resolveAsset } from "../store/fs-store.js";

const require = createRequire(import.meta.url);
const documentCache = new Map();
let dependenciesPromise = null;

async function ensureRegionDir(holeId) {
  const key = createHash("sha256").update(String(holeId)).digest("hex").slice(0, 24);
  const dir = path.join(os.tmpdir(), "rabbithole-pdf-regions", key);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function loadDependencies() {
  if (!dependenciesPromise) dependenciesPromise = (async () => {
    const canvas = await import("@napi-rs/canvas");
    for (const name of ["DOMMatrix", "DOMPoint", "DOMRect", "Path2D", "ImageData"]) if (!globalThis[name] && canvas[name]) globalThis[name] = canvas[name];
    // pdfjs-dist names its Node-compatible build "legacy"; it is the current build for Node.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    return { pdfjs, canvas, standardFontDataUrl: path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep };
  })().catch((error) => {
    dependenciesPromise = null;
    throw error;
  });
  return dependenciesPromise;
}

async function acquireDocument(sourcePath) {
  let entry = documentCache.get(sourcePath);
  if (!entry) {
    entry = { canvas: null, loadingTask: null, promise: null, refs: 0, timer: null };
    documentCache.set(sourcePath, entry);
    entry.promise = (async () => {
      const { pdfjs, canvas, standardFontDataUrl } = await loadDependencies();
      const data = new Uint8Array(await fs.readFile(sourcePath));
      entry.canvas = canvas;
      entry.loadingTask = pdfjs.getDocument({ data, standardFontDataUrl, disableFontFace: true, isEvalSupported: false, useWorkerFetch: false, canvasFactory: napiCanvasFactory(canvas) });
      return entry.loadingTask.promise;
    })().catch((error) => {
      if (documentCache.get(sourcePath) === entry) documentCache.delete(sourcePath);
      throw error;
    });
  }
  clearTimeout(entry.timer); entry.refs++;
  const document = await entry.promise;
  return {
    document,
    canvas: entry.canvas,
    release() {
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs) return;
      entry.timer = setTimeout(() => {
        if (entry.refs || documentCache.get(sourcePath) !== entry) return;
        documentCache.delete(sourcePath); entry.loadingTask?.destroy().catch(() => {});
      }, 30000);
      entry.timer.unref?.();
    },
  };
}

function napiCanvasFactory(canvas) {
  return {
    create(width, height) {
      const surface = canvas.createCanvas(width, height);
      return { canvas: surface, context: surface.getContext("2d") };
    },
    reset: resetPdfCanvasTarget,
    destroy: destroyPdfCanvasTarget,
  };
}

export async function cropPdfRegionToFile({ holeId, asset, anchor, pageNumber, requestId }) {
  const source = await resolveAsset(holeId, asset);
  if (!source) throw new Error("PDF source is missing.");
  const bounds = pdfAnchorBounds(anchor, pageNumber);
  if (!bounds) throw new Error("PDF selection region is empty.");
  const { buffer } = await renderPdfRegion({ source, pageNumber, bounds, padding: 12 });
  const safeRequest = String(requestId || "selection").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "selection";
  const filePath = path.join(await ensureRegionDir(holeId), `region-${safeRequest}.png`);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

export async function renderPdfPageToFile({ holeId, asset, pageNumber, requestId }) {
  const source = await resolveAsset(holeId, asset);
  if (!source) throw new Error("PDF source is missing.");
  const { buffer } = await renderPdfRegion({ source, pageNumber, normalizedRect: { x: 0, y: 0, w: 1, h: 1 }, padding: 0, maxLongEdge: 2400 });
  const safeRequest = String(requestId || `page-${pageNumber}`).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  const filePath = path.join(await ensureRegionDir(holeId), `region-${safeRequest}.png`);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

export async function sweepPdfRegionFiles(holeId) {
  const dir = await ensureRegionDir(holeId);
  const entries = await fs.readdir(dir).catch(() => []);
  await Promise.all(entries.filter((name) => /^region-[A-Za-z0-9_-]+\.png$/.test(name)).map((name) => fs.unlink(path.join(dir, name)).catch(() => {})));
}

export async function cropPdfFigureToAsset({ holeId, asset, pageNumber, rect, name }) {
  const source = await resolveAsset(holeId, asset);
  if (!source) throw new Error("PDF source is missing.");
  const { buffer } = await renderPdfRegion({ source, pageNumber, normalizedRect: rect, padding: 0, maxLongEdge: 2048 });
  const filePath = path.join(await ensureAssetDir(holeId), name);
  await fs.writeFile(filePath, buffer);
  return { filePath, bytes: buffer.length };
}

async function renderPdfRegion({ source, pageNumber, bounds = null, normalizedRect = null, padding = 0, maxLongEdge = undefined }) {
  const lease = await acquireDocument(source);
  try {
    const result = await renderSharedPdfRegion({ document: lease.document, pageNumber, bounds, normalizedRect, padding,
      ...(maxLongEdge === undefined ? {} : { maxLongEdge }),
      createSurface: (width, height) => {
        const surface = lease.canvas.createCanvas(width, height);
        return { surface, context: surface.getContext("2d") };
      },
      encode: (surface) => surface.toBuffer("image/png"),
    });
    return { buffer: result.encoded, width: result.width, height: result.height, pdfBounds: result.pdfBounds };
  } finally {
    lease.release();
  }
}
