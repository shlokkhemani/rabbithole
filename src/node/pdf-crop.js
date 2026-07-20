import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { PDF_AGENT_CROP_MAX_LONG_EDGE, expandPdfBounds, pdfAnchorBounds } from "../core/pdf-shared.js";
import { ensureAssetDir, resolveAsset } from "./fs-store.js";

const require = createRequire(import.meta.url);
const documentCache = new Map();

async function ensureRegionDir(holeId) {
  const key = createHash("sha256").update(String(holeId)).digest("hex").slice(0, 24);
  const dir = path.join(os.tmpdir(), "rabbithole-pdf-regions", key);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function loadDependencies() {
  const canvas = await import("@napi-rs/canvas");
  for (const name of ["DOMMatrix", "DOMPoint", "DOMRect", "Path2D", "ImageData"]) if (!globalThis[name] && canvas[name]) globalThis[name] = canvas[name];
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return { pdfjs, canvas, standardFontDataUrl: path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep };
}

async function acquireDocument(sourcePath) {
  let entry = documentCache.get(sourcePath);
  if (!entry) {
    const { pdfjs, canvas, standardFontDataUrl } = await loadDependencies();
    const data = new Uint8Array(await fs.readFile(sourcePath));
    const loadingTask = pdfjs.getDocument({ data, standardFontDataUrl, disableFontFace: true, isEvalSupported: false, useWorkerFetch: false, canvasFactory: napiCanvasFactory(canvas) });
    entry = { canvas, loadingTask, promise: loadingTask.promise, refs: 0, timer: null };
    documentCache.set(sourcePath, entry);
    entry.promise.catch(() => { if (documentCache.get(sourcePath) === entry) documentCache.delete(sourcePath); });
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
        documentCache.delete(sourcePath); entry.loadingTask.destroy().catch(() => {});
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
    reset(target, width, height) {
      if (!target?.canvas) throw new Error("Canvas target is missing.");
      target.canvas.width = width; target.canvas.height = height;
    },
    destroy(target) {
      if (!target?.canvas) return;
      target.canvas.width = 0; target.canvas.height = 0; target.canvas = null; target.context = null;
    },
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

async function renderPdfRegion({ source, pageNumber, bounds = null, normalizedRect = null, padding = 0, maxLongEdge = PDF_AGENT_CROP_MAX_LONG_EDGE }) {
  const lease = await acquireDocument(source);
  let page = null;
  try {
    page = await lease.document.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1, rotation: page.rotate });
    let pdfBounds = bounds;
    if (!pdfBounds && normalizedRect) pdfBounds = normalizedRectToPdfBounds(baseViewport, normalizedRect);
    pdfBounds = expandPdfBounds(pdfBounds, page.view, padding);
    if (!pdfBounds) throw new Error("PDF crop is outside the visible page box.");
    const baseRect = viewportBounds(baseViewport, pdfBounds);
    const longEdge = Math.max(baseRect[2] - baseRect[0], baseRect[3] - baseRect[1]);
    const scale = Math.max(1, Math.min((300 / 72) * (Number(page.userUnit) || 1), maxLongEdge / Math.max(1, longEdge)));
    const viewport = page.getViewport({ scale, rotation: page.rotate });
    const crop = viewportBounds(viewport, pdfBounds);
    const width = Math.max(1, Math.ceil(crop[2] - crop[0]));
    const height = Math.max(1, Math.ceil(crop[3] - crop[1]));
    const surface = lease.canvas.createCanvas(width, height);
    const context = surface.getContext("2d");
    context.fillStyle = "white"; context.fillRect(0, 0, width, height);
    await page.render({ canvasContext: context, viewport, transform: [1, 0, 0, 1, -crop[0], -crop[1]] }).promise;
    const buffer = surface.toBuffer("image/png");
    surface.width = 0; surface.height = 0;
    return { buffer, width, height, pdfBounds };
  } finally {
    page?.cleanup?.(); lease.release();
  }
}

function normalizedRectToPdfBounds(viewport, rect) {
  const clamp = (value) => Math.max(0, Math.min(1, Number(value) || 0));
  const x0 = clamp(rect?.x) * viewport.width, y0 = clamp(rect?.y) * viewport.height;
  const x1 = Math.min(1, clamp(rect?.x) + clamp(rect?.w)) * viewport.width;
  const y1 = Math.min(1, clamp(rect?.y) + clamp(rect?.h)) * viewport.height;
  const points = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => viewport.convertToPdfPoint(x, y));
  const xs = points.map((point) => point[0]), ys = points.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function viewportBounds(viewport, bounds) {
  const points = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]]].map(([x, y]) => viewport.convertToViewportPoint(x, y));
  const xs = points.map((point) => point[0]), ys = points.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
