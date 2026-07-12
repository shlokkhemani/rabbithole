import {
  MAX_PDF_BYTES,
  MAX_PDF_PAGE_ASSET_BYTES,
  PDF_RENDER_SCALE,
  describePdfOpenError,
  buildPdfDocument,
  extractPdfPageLines,
  normalizePdfTitle,
  pdfPageAssetName,
  resolvePagesToProcess,
  hasPdfMagic,
} from "../../core/pdf-shared.js";
import { createHoleFromMarkdown } from "../transport/direct-host.js";

async function ingestPdf(source, {
  pages,
  includeText = true,
  onProgress = null,
  onAsset = null,
} = {}) {
  const { data, name } = await readPdfSource(source);
  validatePdfBytes(data, name);
  const pdfjs = await loadPdfjs();

  const loadingTask = pdfjs.getDocument({
    data,
    standardFontDataUrl: webAssetUrl("standard_fonts/"),
    cMapUrl: webAssetUrl("cmaps/"),
    cMapPacked: true,
    isEvalSupported: false,
    useWorkerFetch: true,
  });

  let doc;
  try {
    try {
      doc = await loadingTask.promise;
    } catch (err) {
      throw new Error(describePdfOpenError(err, {
        label: name || "selected file",
        encryptedHint: "Provide a decrypted copy, or paste the text instead.",
        engine: "pdf.js",
      }));
    }

    const notes = [];
    const metadata = await doc.getMetadata().catch((err) => {
      notes.push(`PDF metadata could not be read: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    const processedPages = resolvePagesToProcess(doc.numPages, pages, notes);
    const result = {
      title: normalizePdfTitle(metadata),
      page_count: doc.numPages,
      processed_pages: processedPages,
      assets: {
        pages: [],
        embedded_images: [],
      },
      notes,
      blobs: [],
    };
    if (includeText !== false) result.page_lines = [];
    let assetBytes = 0;

    for (let index = 0; index < processedPages.length; index += 1) {
      const pageNumber = processedPages[index];
      onProgress?.({ phase: "page", message: `Preparing page ${index + 1} of ${processedPages.length}`, page: pageNumber, index: index + 1, total: processedPages.length, pageCount: doc.numPages });
      let page = null;
      try {
        page = await doc.getPage(pageNumber);
        if (includeText !== false) {
          result.page_lines.push({ page: pageNumber, lines: await extractPdfPageLines(page) });
        }
        const remaining = processedPages.length - index;
        const remainingBudget = Math.max(0, MAX_PDF_PAGE_ASSET_BYTES - assetBytes);
        const targetBytes = remainingBudget / Math.max(remaining, 1);
        const rendered = await renderPageToJpegBlob(page, pageNumber, targetBytes);
        assetBytes += rendered.blob.size;
        result.assets.pages.push(rendered.asset);
        if (onAsset) await onAsset(rendered.asset, rendered.blob);
        else result.blobs.push({ name: rendered.asset.name, blob: rendered.blob });
      } catch (err) {
        notes.push(`Page ${pageNumber} could not be fully processed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        page?.cleanup?.();
      }
    }

    return result;
  } finally {
    doc?.cleanup?.();
    await loadingTask.destroy().catch(() => {});
  }
}

export async function ingestPdfToStoredHole({
  source,
  store,
  title = "",
  pages,
  onProgress = null,
  includeText = true,
  baseUrl = null,
  ingest = ingestPdf, // injectable so failure-path cleanup is testable without pdf.js
} = {}) {
  if (!store) throw new Error("PDF import needs a store.");
  const staging = await store.createStaging();
  let adopted = false;
  let savedHole = null;
  try {
    const result = await ingest(source, {
      pages, includeText, onProgress,
      onAsset: (_asset, blob) => store.putStagedAsset(staging.ingest_id, _asset.name, blob),
    });
    const sourceName = typeof File !== "undefined" && source instanceof File ? source.name : "";
    const holeTitle = title || result.title || titleFromFileName(sourceName) || "PDF Document";
    const built = buildPdfDocument({
      title: holeTitle,
      pageCount: result.page_count,
      processedPages: result.processed_pages,
      pageAssets: result.assets.pages,
      pageLines: result.page_lines || [],
      notes: result.notes,
    });
    const hole = createHoleFromMarkdown({ title: holeTitle, markdown: built.markdown, baseUrl });
    hole.nodes[0].extensions = { pdf: built.pdfExtension };
    await store.saveHole(hole);
    savedHole = hole;
    await store.adoptStagedAssets(hole.hole_id, staging.ingest_id);
    adopted = true;
    return { hole, result };
  } finally {
    if (!adopted) {
      await store.discardStaging?.(staging.ingest_id).catch(() => {});
      if (savedHole) await store.deleteHole?.(savedHole.hole_id).catch(() => {});
    }
  }
}

async function readPdfSource(source) {
  const hasFile = typeof File !== "undefined";
  const hasBlob = typeof Blob !== "undefined";
  if ((hasFile && source instanceof File) || (hasBlob && source instanceof Blob)) {
    if (source.size > MAX_PDF_BYTES) {
      throw new Error(`PDF file exceeds the 100 MB limit: ${hasFile && source instanceof File ? source.name : "selected file"}`);
    }
    return {
      data: new Uint8Array(await source.arrayBuffer()),
      name: hasFile && source instanceof File ? source.name : "selected PDF",
    };
  }
  if (source instanceof ArrayBuffer) {
    if (source.byteLength > MAX_PDF_BYTES) throw new Error("PDF file exceeds the 100 MB limit.");
    return { data: new Uint8Array(source), name: "downloaded PDF" };
  }
  if (source instanceof Uint8Array) {
    if (source.byteLength > MAX_PDF_BYTES) throw new Error("PDF file exceeds the 100 MB limit.");
    return { data: source, name: "downloaded PDF" };
  }
  throw new Error("PDF import needs a File, Blob, ArrayBuffer, or Uint8Array.");
}

function validatePdfBytes(data, name) {
  if (!(data instanceof Uint8Array) || data.byteLength < 4) {
    throw new Error(`${name || "PDF"} is not a PDF: expected a %PDF header.`);
  }
  if (!hasPdfMagic(data)) {
    throw new Error(`${name || "PDF"} is not a PDF: expected a %PDF header.`);
  }
}

// Lazy so this module stays importable where pdf.js can't run (the staging
// orchestration is host-neutral and unit-tested in Node).
let pdfjsModule = null;
async function loadPdfjs() {
  pdfjsModule ||= import("pdfjs-dist/build/pdf.mjs").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = webAssetUrl("pdf.worker.mjs");
    return pdfjs;
  });
  return pdfjsModule;
}

async function renderPageToJpegBlob(page, pageNumber, targetBytes) {
  let scale = PDF_RENDER_SCALE;
  let blob;
  let viewport;
  let canvas;
  let width = 0;
  let height = 0;
  do {
    viewport = page.getViewport({ scale });
    width = Math.ceil(viewport.width);
    height = Math.ceil(viewport.height);
    canvas = createRenderCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);
    const renderTask = page.render({ canvasContext: context, viewport });
    await renderTask.promise;
    blob = await canvasToJpegBlob(canvas);
    if (blob.size <= Math.min(20 * 1024 * 1024, Math.max(targetBytes, 256 * 1024)) || scale <= 0.5) break;
    releaseCanvas(canvas);
    scale *= 0.75;
  } while (true);
  const name = pdfPageAssetName(pageNumber);
  releaseCanvas(canvas);
  return {
    asset: { page: pageNumber, name, width, height },
    blob,
  };
}

function createRenderCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToJpegBlob(canvas) {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas could not be encoded as JPEG."));
    }, "image/jpeg", 0.85);
  });
}

function releaseCanvas(canvas) {
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {}
}

function webAssetUrl(relativePath) {
  const base = globalThis.__RABBITHOLE_WEB_ASSET_BASE__ || document.baseURI || location.href;
  return new URL(relativePath, base).href;
}

function titleFromFileName(name) {
  return String(name || "").replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}
