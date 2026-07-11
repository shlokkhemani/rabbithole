export const MAX_PDF_BYTES = 100 * 1024 * 1024;
export const DEFAULT_PAGE_CAP = 40;
export const PDF_RENDER_SCALE = 2;
export const PDF_MAGIC = "%PDF";

/** @param {{ length: number, [index: number]: number } | null | undefined} bytes */
export function hasPdfMagic(bytes) {
  if (!bytes || bytes.length < 4) return false;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/**
 * @param {unknown} err
 * @param {{ label: string, encryptedHint: string, engine: string }} options
 */
export function describePdfOpenError(err, { label, encryptedHint, engine }) {
  const message = err instanceof Error ? err.message : String(err);
  if (/password|encrypted|PasswordException/i.test(`${/** @type {{ name?: string }} */ (err)?.name || ""} ${message}`)) {
    return `PDF is encrypted or password-protected: ${label}. ${encryptedHint}`;
  }
  return `PDF could not be opened by ${engine}: ${label}. Check that the file is not corrupt. Original error: ${message}`;
}

/** @typedef {{ str: string, transform: number[], width?: number, height?: number }} PdfTextItem */
/** @typedef {{ str: string, x: number, y: number, width: number, height: number }} TextGeometry */
/** @typedef {{ y: number, minX: number, maxX: number, text: string }} TextLine */
/** @typedef {TextLine & { column: string }} ClassifiedLine */

/** @param {unknown} pages */
export function parsePagesRange(pages) {
  if (pages == null || pages === "") return null;
  const value = String(pages).trim();
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(value);
  if (!match) throw new Error(`pages must be a single page or range like "3" or "1-20"; got ${JSON.stringify(pages)}`);
  const start = Number.parseInt(match[1], 10);
  const end = match[2] ? Number.parseInt(match[2], 10) : start;
  if (start < 1 || end < 1 || end < start) {
    throw new Error(`pages must be a positive ascending range; got ${JSON.stringify(pages)}`);
  }
  return { start, end, explicit: value };
}

/** @param {number} pageCount @param {unknown} pages @param {string[]} [notes] */
export function resolvePagesToProcess(pageCount, pages, notes = []) {
  const range = parsePagesRange(pages);
  if (range) {
    if (range.start > pageCount) {
      throw new Error(`pages starts at ${range.start}, but the PDF has only ${pageCount} pages`);
    }
    const end = Math.min(range.end, pageCount);
    if (range.end > pageCount) {
      notes.push(`Requested pages ${range.explicit}, but the PDF has only ${pageCount} pages; processed through page ${pageCount}.`);
    }
    return rangeToArray(range.start, end);
  }

  const end = Math.min(pageCount, DEFAULT_PAGE_CAP);
  if (pageCount > DEFAULT_PAGE_CAP) {
    notes.push(
      `Processed the first ${DEFAULT_PAGE_CAP} of ${pageCount} pages by default; pass pages: "1-${pageCount}" to ingest all pages.`
    );
  }
  return rangeToArray(1, end);
}

/** @param {number} start @param {number} end */
export function rangeToArray(start, end) {
  /** @type {number[]} */
  const out = [];
  for (let page = start; page <= end; page += 1) out.push(page);
  return out;
}

/** @param {any} metadata */
export function normalizePdfTitle(metadata) {
  const raw = metadata?.info?.Title || metadata?.metadata?.get?.("dc:title") || "";
  const title = String(raw || "").replace(/\s+/g, " ").trim();
  return title || null;
}

/** @param {number} pageNumber */
export function pdfPageAssetName(pageNumber) {
  return `page-${String(pageNumber).padStart(3, "0")}.png`;
}

/** @param {PdfTextItem} item @returns {TextGeometry} */
export function getTextItemGeometry(item) {
  const [a, b, c, d, e, f] = item.transform;
  const height = Math.hypot(c, d) || item.height || Math.hypot(a, b) || 1;
  return {
    str: item.str,
    x: e,
    y: f,
    width: item.width || 0,
    height,
  };
}

/** @param {PdfTextItem[]} items @returns {TextLine[]} */
export function clusterTextLines(items) {
  const textItems = items
    .filter((item) => typeof item.str === "string" && item.str.length > 0 && item.transform)
    .map(getTextItemGeometry)
    .filter((item) => item.str.trim().length > 0);

  textItems.sort((a, b) => {
    const yDelta = b.y - a.y;
    if (Math.abs(yDelta) > 1.5) return yDelta;
    return a.x - b.x;
  });

  /** @type {{ y: number, items: TextGeometry[] }[]} */
  const lines = [];
  for (const item of textItems) {
    const threshold = Math.max(1.8, item.height * 0.45);
    let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= threshold);
    if (!line) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
    line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
  }

  return lines
    .map((line) => {
      line.items.sort((a, b) => a.x - b.x);
      let text = "";
      let lastRight = null;
      let minX = Infinity;
      let maxX = -Infinity;
      for (const item of line.items) {
        minX = Math.min(minX, item.x);
        maxX = Math.max(maxX, item.x + item.width);
        const normalized = item.str.replace(/\s+/g, " ");
        if (text.length === 0) {
          text = normalized.trimStart();
        } else {
          const charWidth = item.width / Math.max(item.str.length, 1);
          const gap = item.x - /** @type {number} */ (lastRight);
          if (gap > Math.max(1.5, charWidth * 0.45) && !text.endsWith(" ")) text += " ";
          text += normalized;
        }
        lastRight = Math.max(lastRight ?? -Infinity, item.x + item.width);
      }
      return {
        y: line.y,
        minX,
        maxX,
        text: text.trimEnd(),
      };
    })
    .filter((line) => line.text.trim().length > 0)
    .sort((a, b) => b.y - a.y || a.minX - b.minX);
}

/** @param {TextLine[]} lines @param {number} pageWidth */
export function orderLinesForReading(lines, pageWidth) {
  const mid = pageWidth / 2;
  const gutter = Math.max(12, pageWidth * 0.035);
  const classified = lines.map((line) => {
    let column = "full";
    if (line.maxX < mid + gutter) column = "left";
    else if (line.minX > mid - gutter) column = "right";
    return { ...line, column };
  });
  const leftCount = classified.filter((line) => line.column === "left").length;
  const rightCount = classified.filter((line) => line.column === "right").length;
  if (leftCount < 8 || rightCount < 8) return classified.map((line) => line.text);

  /** @type {ClassifiedLine[]} */
  const ordered = [];
  /** @type {ClassifiedLine[]} */
  let run = [];
  const flushRun = () => {
    if (run.length === 0) return;
    const left = run.filter((line) => line.column === "left").sort((a, b) => b.y - a.y);
    const right = run.filter((line) => line.column === "right").sort((a, b) => b.y - a.y);
    const other = run.filter((line) => line.column === "full").sort((a, b) => b.y - a.y || a.minX - b.minX);
    if (left.length >= 3 && right.length >= 3) ordered.push(...left, ...right, ...other);
    else ordered.push(...run.sort((a, b) => b.y - a.y || a.minX - b.minX));
    run = [];
  };

  for (const line of classified) {
    if (line.column === "full") {
      flushRun();
      ordered.push(line);
    } else {
      run.push(line);
    }
  }
  flushRun();
  return ordered.map((line) => line.text);
}

/** @param {{ items?: PdfTextItem[] } | null | undefined} content @param {number} pageWidth */
export function extractTextFromPdfContent(content, pageWidth) {
  const lines = orderLinesForReading(clusterTextLines(content?.items || []), pageWidth);
  return lines.join("\n");
}

/** @param {any} page */
export async function extractPdfPageText(page) {
  const content = await page.getTextContent({ includeMarkedContent: false });
  const viewport = page.getViewport({ scale: 1 });
  return extractTextFromPdfContent(content, viewport.width);
}

/** @param {{ title?: unknown, pageCount?: number, processedPages?: number[], pageAssets?: { page: number, name?: string }[], pageText?: { page: number, text?: unknown }[], notes?: unknown[] }} [input] */
export function buildPdfMarkdown({ title, pageCount, processedPages, pageAssets, pageText, notes } = {}) {
  const out = [`# ${cleanHeading(title || "PDF Document")}`, ""];
  const pages = Array.isArray(processedPages) ? processedPages : [];
  if (pageCount && pages.length) {
    out.push(`Imported ${pages.length} of ${pageCount} ${pageCount === 1 ? "page" : "pages"}.`, "");
  }
  const textByPage = new Map((pageText || []).map((entry) => [entry.page, String(entry.text || "").trim()]));
  const assetsByPage = new Map((pageAssets || []).map((entry) => [entry.page, entry]));

  for (const pageNumber of pages) {
    const asset = assetsByPage.get(pageNumber);
    out.push(`## Page ${pageNumber}`, "");
    if (asset?.name) out.push(`![Page ${pageNumber}](asset:${asset.name})`, "");
    const text = textByPage.get(pageNumber);
    if (text) {
      out.push("```text", text, "```", "");
    }
  }

  const usefulNotes = (notes || []).map((note) => String(note || "").trim()).filter(Boolean);
  if (usefulNotes.length) {
    out.push("## Import Notes", "");
    for (const note of usefulNotes) out.push(`- ${note}`);
    out.push("");
  }

  return out.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}

/** @param {unknown} value */
function cleanHeading(value) {
  return String(value || "PDF Document").replace(/\s+/g, " ").replace(/^#+\s*/, "").trim() || "PDF Document";
}
