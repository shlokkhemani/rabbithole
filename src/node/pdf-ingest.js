import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  MAX_PDF_BYTES,
  buildPdfDocument,
  describePdfOpenError,
  extractPdfPageLines,
  hasPdfMagic,
  normalizePdfTitle,
  pdfPageMetadata,
  pdfSourceAssetName,
  resolvePagesToProcess,
} from "../core/pdf-shared.js";

const require = createRequire(import.meta.url);

async function loadDependencies() {
  try {
    const canvas = await import("@napi-rs/canvas").catch(() => null);
    if (canvas) for (const name of ["DOMMatrix", "DOMPoint", "DOMRect", "Path2D", "ImageData"]) if (!globalThis[name] && canvas[name]) globalThis[name] = canvas[name];
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    return {
      pdfjs,
      standardFontDataUrl: path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep,
    };
  } catch (error) {
    throw new Error(`Native PDF support could not initialize pdf.js. ${error.message}`);
  }
}

export async function isPdfFile(filePath) {
  if (/\.pdf$/i.test(String(filePath || ""))) return true;
  try {
    const handle = await fs.open(path.resolve(String(filePath || "")), "r");
    try {
      const magic = Buffer.alloc(4);
      await handle.read(magic, 0, 4, 0);
      return hasPdfMagic(magic);
    } finally { await handle.close(); }
  } catch { return false; }
}

export async function ingestPdfDocument({ filePath, store, title = "", pages } = {}) {
  const absolute = path.resolve(String(filePath || ""));
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat?.isFile()) throw new Error(`PDF file does not exist: ${absolute}`);
  if (stat.size > MAX_PDF_BYTES) throw new Error(`PDF file exceeds the 100 MB limit: ${absolute}`);
  const sourceBytes = await fs.readFile(absolute);
  const data = new Uint8Array(sourceBytes);
  if (!hasPdfMagic(data)) throw new Error(`file_path is not a PDF: ${absolute}`);
  const sha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const sourceAsset = pdfSourceAssetName(sha256);
  const { pdfjs, standardFontDataUrl } = await loadDependencies();
  const loadingTask = pdfjs.getDocument({ data, standardFontDataUrl, disableFontFace: true, isEvalSupported: false, useWorkerFetch: false });
  const staging = await store.createStaging();
  let doc;
  try {
    await store.putStagedAsset(staging.ingest_id, sourceAsset, sourceBytes);
    try { doc = await loadingTask.promise; }
    catch (error) {
      throw new Error(describePdfOpenError(error, { label: absolute, encryptedHint: "Provide a decrypted copy.", engine: "pdf.js" }));
    }
    const notes = [];
    const metadata = await doc.getMetadata().catch(() => null);
    const processedPages = resolvePagesToProcess(doc.numPages, pages, notes);
    const pageMetadata = [];
    const pageLines = [];
    for (const pageNumber of processedPages) {
      const page = await doc.getPage(pageNumber);
      try {
        pageMetadata.push(pdfPageMetadata(page, pageNumber));
        pageLines.push({ page: pageNumber, lines: await extractPdfPageLines(page) });
      } finally { page.cleanup?.(); }
    }
    const resolvedTitle = title || normalizePdfTitle(metadata) || path.basename(absolute, path.extname(absolute));
    const source = { asset: sourceAsset, sha256, byte_length: sourceBytes.byteLength };
    const built = buildPdfDocument({ title: resolvedTitle, pageCount: doc.numPages, processedPages, pageMetadata, pageLines, notes, source });
    return {
      title: resolvedTitle,
      ...built,
      stagingId: staging.ingest_id,
      adopt: (holeId) => store.adoptStagedAssets(holeId, staging.ingest_id),
      discard: () => store.discardStaging(staging.ingest_id),
    };
  } catch (error) {
    await store.discardStaging(staging.ingest_id).catch(() => {});
    throw error;
  } finally {
    doc?.cleanup?.();
    await loadingTask.destroy().catch(() => {});
  }
}
