import * as pdfjs from "pdfjs-dist/build/pdf.mjs";
import {
  MAX_PDF_BYTES,
  PDF_RENDER_SCALE,
  buildPdfMarkdown,
  extractPdfPageText,
  normalizePdfTitle,
  pdfPageAssetName,
  resolvePagesToProcess,
} from "../../core/pdf-shared.js";
import { createHoleFromMarkdown } from "../transport/direct-host.js";

const PDF_MAGIC = "%PDF";

export async function ingestPdf(source, {
  pages,
  includeText = true,
  onProgress = null,
} = {}) {
  const { data, name } = await readPdfSource(source);
  validatePdfBytes(data, name);
  configurePdfjs();

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
      throw new Error(describePdfOpenError(err, name));
    }

    const notes = [];
    notes.push("Embedded raster extraction is disabled in the browser importer; page render PNGs were created instead.");
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
    if (includeText !== false) result.text = [];

    for (let index = 0; index < processedPages.length; index += 1) {
      const pageNumber = processedPages[index];
      onProgress?.({ phase: "page", page: pageNumber, index: index + 1, total: processedPages.length, pageCount: doc.numPages });
      let page = null;
      try {
        page = await doc.getPage(pageNumber);
        if (includeText !== false) {
          result.text.push({ page: pageNumber, text: await extractPdfPageText(page) });
        }
        const rendered = await renderPageToPngBlob(page, pageNumber);
        result.assets.pages.push(rendered.asset);
        result.blobs.push({ name: rendered.asset.name, blob: rendered.blob });
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
} = {}) {
  if (!store) throw new Error("PDF import needs a store.");
  const result = await ingestPdf(source, { pages, includeText, onProgress });
  const sourceName = typeof File !== "undefined" && source instanceof File ? source.name : "";
  const holeTitle = title || result.title || titleFromFileName(sourceName) || "PDF Document";
  const markdown = buildPdfMarkdown({
    title: holeTitle,
    pageCount: result.page_count,
    processedPages: result.processed_pages,
    pageAssets: result.assets.pages,
    pageText: result.text || [],
    notes: result.notes,
  });
  const hole = createHoleFromMarkdown({ title: holeTitle, markdown, baseUrl });
  for (const asset of result.blobs) {
    await store.putAsset(hole.hole_id, asset.name, asset.blob);
  }
  await store.saveHole(hole);
  return { hole, result };
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
  let magic = "";
  for (let i = 0; i < 4; i += 1) magic += String.fromCharCode(data[i]);
  if (magic !== PDF_MAGIC) {
    throw new Error(`${name || "PDF"} is not a PDF: expected a %PDF header.`);
  }
}

function configurePdfjs() {
  pdfjs.GlobalWorkerOptions.workerSrc = webAssetUrl("pdf.worker.mjs");
}

async function renderPageToPngBlob(page, pageNumber) {
  const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  const canvas = createRenderCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);
  const renderTask = page.render({ canvasContext: context, viewport });
  await renderTask.promise;
  const blob = await canvasToPngBlob(canvas);
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

function canvasToPngBlob(canvas) {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: "image/png" });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas could not be encoded as PNG."));
    }, "image/png");
  });
}

function releaseCanvas(canvas) {
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {}
}

function describePdfOpenError(err, name) {
  const message = err instanceof Error ? err.message : String(err);
  if (/password|encrypted|PasswordException/i.test(`${err?.name || ""} ${message}`)) {
    return `PDF is encrypted or password-protected: ${name || "selected file"}. Provide a decrypted copy, or paste the text instead.`;
  }
  return `PDF could not be opened by pdf.js: ${name || "selected file"}. Check that the file is not corrupt. Original error: ${message}`;
}

function webAssetUrl(relativePath) {
  const base = globalThis.__RABBITHOLE_WEB_ASSET_BASE__ || document.baseURI || location.href;
  return new URL(relativePath, base).href;
}

function titleFromFileName(name) {
  return String(name || "").replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}
