import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import {
  MAX_PDF_BYTES,
  MAX_PDF_PAGE_ASSET_BYTES,
  PDF_PAGE_IMAGE_MIME,
  PDF_PAGE_IMAGE_QUALITY,
  PDF_RENDER_SCALE,
  buildPdfDocument,
  describePdfOpenError,
  extractPdfPageLines,
  hasPdfMagic,
  normalizePdfTitle,
  pdfPageAssetName,
  resolvePagesToProcess,
} from "../core/pdf-shared.js";

const require = createRequire(import.meta.url);

async function loadDependencies() {
  try {
    const [pdfjs, canvas] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("@napi-rs/canvas"),
    ]);
    return {
      pdfjs,
      canvas,
      standardFontDataUrl: path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep,
    };
  } catch (error) {
    throw new Error(`Native PDF support needs optional dependencies; reinstall with npm install --include=optional. ${error.message}`);
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
  const data = new Uint8Array(await fs.readFile(absolute));
  if (!hasPdfMagic(data)) throw new Error(`file_path is not a PDF: ${absolute}`);
  const { pdfjs, canvas, standardFontDataUrl } = await loadDependencies();
  for (const name of ["DOMMatrix", "DOMPoint", "DOMRect", "Path2D"]) if (!globalThis[name] && canvas[name]) globalThis[name] = canvas[name];
  const loadingTask = pdfjs.getDocument({ data, standardFontDataUrl, disableFontFace: true, isEvalSupported: false, useWorkerFetch: false });
  const staging = await store.createStaging();
  let doc;
  try {
    try { doc = await loadingTask.promise; }
    catch (error) {
      throw new Error(describePdfOpenError(error, { label: absolute, encryptedHint: "Provide a decrypted copy.", engine: "pdf.js" }));
    }
    const notes = [];
    const metadata = await doc.getMetadata().catch(() => null);
    const processedPages = resolvePagesToProcess(doc.numPages, pages, notes);
    const pageAssets = [];
    const pageLines = [];
    let assetBytes = 0;
    for (let index = 0; index < processedPages.length; index += 1) {
      const pageNumber = processedPages[index];
      const page = await doc.getPage(pageNumber);
      try {
        pageLines.push({ page: pageNumber, lines: await extractPdfPageLines(page) });
        // Same aggregate budget discipline as the web host: dense pages
        // re-render at reduced scale so the document stays exportable.
        const remaining = processedPages.length - index;
        const targetBytes = Math.max(0, MAX_PDF_PAGE_ASSET_BYTES - assetBytes) / Math.max(remaining, 1);
        let scale = PDF_RENDER_SCALE;
        let bytes, width, height;
        do {
          const viewport = page.getViewport({ scale });
          width = Math.ceil(viewport.width);
          height = Math.ceil(viewport.height);
          const surface = canvas.createCanvas(width, height);
          const context = surface.getContext("2d");
          context.fillStyle = "white";
          context.fillRect(0, 0, width, height);
          await page.render({ canvasContext: context, viewport }).promise;
          bytes = surface.toBuffer(PDF_PAGE_IMAGE_MIME, PDF_PAGE_IMAGE_QUALITY * 100);
          surface.width = 0; surface.height = 0;
          if (bytes.length <= Math.min(20 * 1024 * 1024, Math.max(targetBytes, 256 * 1024)) || scale <= 0.5) break;
          scale *= 0.75;
        } while (true);
        assetBytes += bytes.length;
        const name = pdfPageAssetName(pageNumber);
        await store.putStagedAsset(staging.ingest_id, name, bytes);
        pageAssets.push({ page: pageNumber, name, width, height });
      } finally { page.cleanup?.(); }
    }
    const resolvedTitle = title || normalizePdfTitle(metadata) || path.basename(absolute, path.extname(absolute));
    const built = buildPdfDocument({ title: resolvedTitle, pageCount: doc.numPages, processedPages, pageAssets, pageLines, notes });
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
