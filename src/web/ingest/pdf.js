import {
  MAX_PDF_BYTES,
  describePdfOpenError,
  buildPdfDocument,
  extractPdfPageLines,
  normalizePdfTitle,
  pdfPageMetadata,
  pdfSourceAssetName,
  resolvePagesToProcess,
  hasPdfMagic,
} from "../../core/pdf-shared.js";
import { createHoleFromMarkdown } from "../transport/direct-host.js";
import { loadPdfJsModule, primePdfDocument } from "../../ui/pdf-runtime.js";

async function ingestPdf(source, {
  pages,
  includeText = true,
  onProgress = null,
  onSource = null,
} = {}) {
  const { data, name } = await readPdfSource(source);
  validatePdfBytes(data, name);
  const sha256 = await sha256Hex(data);
  const sourceAsset = pdfSourceAssetName(sha256);
  const sourceBlob = new Blob([data], { type: "application/pdf" });
  if (onSource) await onSource({ asset: sourceAsset, sha256, byte_length: sourceBlob.size }, sourceBlob);
  const pdfjs = await loadPdfJsModule();

  const loadingTask = pdfjs.getDocument({
    data,
    standardFontDataUrl: webAssetUrl("standard_fonts/"),
    cMapUrl: webAssetUrl("cmaps/"),
    cMapPacked: true,
    isEvalSupported: false,
    useWorkerFetch: true,
  });

  let doc;
  let transferred = false;
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
      source: { asset: sourceAsset, sha256, byte_length: sourceBlob.size },
      page_metadata: [],
      notes,
    };
    if (includeText !== false) result.page_lines = [];
    for (let index = 0; index < processedPages.length; index += 1) {
      const pageNumber = processedPages[index];
      onProgress?.({ phase: "page", message: `Preparing page ${index + 1} of ${processedPages.length}`, page: pageNumber, index: index + 1, total: processedPages.length, pageCount: doc.numPages });
      let page = null;
      try {
        page = await doc.getPage(pageNumber);
        result.page_metadata.push(pdfPageMetadata(page, pageNumber));
        if (includeText !== false) {
          result.page_lines.push({ page: pageNumber, lines: await extractPdfPageLines(page) });
        }
      } catch (err) {
        notes.push(`Page ${pageNumber} could not be fully processed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        page?.cleanup?.();
      }
    }

    // Import and the first viewer mount are one user action. Transfer the
    // parsed document into the shared runtime so the same bytes are not sent
    // through PDF.js and parsed a second time immediately afterward.
    transferred = primePdfDocument({ key: sha256, loadingTask, document: doc });
    return result;
  } finally {
    if (!transferred) {
      doc?.cleanup?.();
      await loadingTask.destroy().catch(() => {});
    }
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
      onSource: (_source, blob) => store.putStagedAsset(staging.ingest_id, _source.asset, blob),
    });
    const sourceName = typeof File !== "undefined" && source instanceof File ? source.name : "";
    const holeTitle = title || result.title || titleFromFileName(sourceName) || "PDF Document";
    const built = buildPdfDocument({
      title: holeTitle,
      pageCount: result.page_count,
      processedPages: result.processed_pages,
      pageMetadata: result.page_metadata,
      pageLines: result.page_lines || [],
      notes: result.notes,
      source: result.source,
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

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function webAssetUrl(relativePath) {
  const base = globalThis.__RABBITHOLE_WEB_ASSET_BASE__ || document.baseURI || location.href;
  return new URL(relativePath, base).href;
}

function titleFromFileName(name) {
  return String(name || "").replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}
