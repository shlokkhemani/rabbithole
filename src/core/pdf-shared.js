export const MAX_PDF_BYTES = 100 * 1024 * 1024;
export const DEFAULT_PAGE_CAP = 40;
export const PDF_RENDER_SCALE = 2;
export const PDF_CROP_MAX_LONG_EDGE = 1568;
export const PDF_CROP_PADDING = 0.02;

/** @param {any} rect @param {number} sourceWidth @param {number} sourceHeight @param {{padding?: number, maxLongEdge?: number}} [options] */
export function planPdfCrop(rect, sourceWidth, sourceHeight, { padding = PDF_CROP_PADDING, maxLongEdge = PDF_CROP_MAX_LONG_EDGE } = {}) {
  const width = Number(sourceWidth), height = Number(sourceHeight);
  if (!(width > 0) || !(height > 0)) return null;
  const value = rect && typeof rect === "object" ? rect : {};
  const clamp = (/** @type {unknown} */ n) => Math.min(1, Math.max(0, Number(n) || 0));
  let x = clamp(value.x), y = clamp(value.y);
  let w = Math.min(clamp(value.w), 1 - x), h = Math.min(clamp(value.h), 1 - y);
  if (!(w > 0) || !(h > 0)) return null;
  const padX = w * Math.max(0, Number(padding) || 0);
  const padY = h * Math.max(0, Number(padding) || 0);
  const right = Math.min(1, x + w + padX), bottom = Math.min(1, y + h + padY);
  x = Math.max(0, x - padX); y = Math.max(0, y - padY);
  w = right - x; h = bottom - y;
  const sx = Math.floor(x * width), sy = Math.floor(y * height);
  const sw = Math.max(1, Math.ceil((x + w) * width) - sx);
  const sh = Math.max(1, Math.ceil((y + h) * height) - sy);
  const scale = Math.min(1, Math.max(1, Number(maxLongEdge) || PDF_CROP_MAX_LONG_EDGE) / Math.max(sw, sh));
  return { sx, sy, sw: Math.min(sw, width - sx), sh: Math.min(sh, height - sy), width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.round(sh * scale)) };
}

/** @param {Array<any>} lines @param {number} page @param {any} rect @param {unknown} markdown */
export function enclosedPdfLines(lines, page, rect, markdown) {
  const box = rect && typeof rect === "object" ? rect : {};
  const x = Number(box.x), y = Number(box.y), w = Number(box.w), h = Number(box.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return { text: "", start: 0, end: 0 };
  const enclosed = (Array.isArray(lines) ? lines : []).filter((line) => line.p === page && line.x >= x && line.y >= y && line.x + line.w <= x + w && line.y + line.h <= y + h);
  if (!enclosed.length) return { text: "", start: 0, end: 0 };
  const source = String(markdown ?? "");
  return { text: enclosed.map((line) => source.slice(line.s, line.e)).join("\n"), start: enclosed[0].s, end: enclosed[enclosed.length - 1].e };
}

const FIGURE_REF_RE = /!\[([^\]\n]*)\]\(figure:page-(\d{1,6}):([^\s)]+)\)/g;

/** @param {unknown} markdown */
export function parseFigureRefs(markdown) {
  const source = String(markdown || ""), refs = [];
  for (const match of source.matchAll(FIGURE_REF_RE)) {
    const values = match[3].split(",").map(Number);
    const rect = values.length === 4 && values.every(Number.isFinite) ? { x: values[0], y: values[1], w: values[2], h: values[3] } : null;
    refs.push({ raw: match[0], caption: match[1], page: Number(match[2]), rect, index: match.index });
  }
  return refs;
}

/** @param {unknown} markdown @param {Array<any>} replacements */
export function rewriteFigureRefs(markdown, replacements = []) {
  let cursor = 0, output = "";
  for (const replacement of replacements) {
    const ref = replacement.ref || replacement;
    output += String(markdown).slice(cursor, ref.index) + String(replacement.markdown ?? `*${ref.caption || "Figure"}*`);
    cursor = ref.index + ref.raw.length;
  }
  return output + String(markdown).slice(cursor);
}
export const PDF_MAGIC = "%PDF";
// Page + figure budgets are sized so a maxed-out hole still exports: base64
// inflates assets 4/3, and the portable payload cap is 32 MB —
// (20 + 2) * 4/3 ≈ 29.4 MB, leaving headroom for JSON structure and markdown.
export const MAX_PDF_PAGE_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_FIGURE_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_PDF_PAGES = 100;
export const MAX_PDF_LINES = 25000;

import { validateAssetName } from "./assets.js";
import { normalizeBlockIds } from "./blocks.js";

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
/** @typedef {{ y: number, minX: number, maxX: number, height: number, text: string }} TextLine */
/** @typedef {TextLine & { column: string }} ClassifiedLine */

/** @param {unknown} pages */
function parsePagesRange(pages) {
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
function rangeToArray(start, end) {
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
  return `page-${String(pageNumber).padStart(3, "0")}.jpg`;
}

/** @param {PdfTextItem} item @returns {TextGeometry} */
function getTextItemGeometry(item) {
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
function clusterTextLines(items) {
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
    .flatMap((line) => {
      line.items.sort((a, b) => a.x - b.x);
      // Split a y-cluster at large horizontal gaps: two-column layouts put both
      // columns on the same baseline, and a single merged record would glue the
      // columns' text together and span the gutter — wrecking reading order,
      // selection geometry, and ask anchors alike.
      /** @type {{ items: TextGeometry[] }[]} */
      const segments = [];
      /** @type {{ items: TextGeometry[] } | null} */
      let segment = null;
      /** @type {number | null} */
      let lastRight = null;
      for (const item of line.items) {
        const gapLimit = Math.max(12, item.height * 1.6);
        if (!segment || (lastRight != null && item.x - lastRight > gapLimit)) {
          segment = { items: [] };
          segments.push(segment);
        }
        segment.items.push(item);
        lastRight = Math.max(lastRight ?? -Infinity, item.x + item.width);
      }
      return segments.map((entry) => {
        let text = "";
        let right = null;
        let minX = Infinity;
        let maxX = -Infinity;
        for (const item of entry.items) {
          minX = Math.min(minX, item.x);
          maxX = Math.max(maxX, item.x + item.width);
          const normalized = item.str.replace(/\s+/g, " ");
          if (text.length === 0) {
            text = normalized.trimStart();
          } else {
            const charWidth = item.width / Math.max(item.str.length, 1);
            const gap = item.x - /** @type {number} */ (right);
            if (gap > Math.max(1.5, charWidth * 0.45) && !text.endsWith(" ")) text += " ";
            text += normalized;
          }
          right = Math.max(right ?? -Infinity, item.x + item.width);
        }
        return {
          y: line.y,
          minX,
          maxX,
          height: Math.max(...entry.items.map((item) => item.height)),
          text: text.trimEnd(),
        };
      });
    })
    .filter((line) => line.text.trim().length > 0)
    .sort((a, b) => b.y - a.y || a.minX - b.minX);
}

/** @param {TextLine[]} lines @param {number} pageWidth */
function orderLinesForReading(lines, pageWidth) {
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
  if (leftCount < 8 || rightCount < 8) return classified;

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
  return ordered;
}

/** @param {{ items?: PdfTextItem[] } | null | undefined} content @param {number} pageWidth */
function extractTextFromPdfContent(content, pageWidth) {
  const lines = orderLinesForReading(clusterTextLines(content?.items || []), pageWidth);
  return lines.map((line) => line.text).join("\n");
}

/** @param {any} page */
export async function extractPdfPageLines(page) {
  const content = await page.getTextContent({ includeMarkedContent: false });
  const viewport = page.getViewport({ scale: 1 });
  return orderLinesForReading(clusterTextLines(content?.items || []), viewport.width).map((line) => ({
    text: line.text,
    x: clamp01(line.minX / viewport.width),
    y: clamp01((viewport.height - line.y - line.height) / viewport.height),
    w: clamp01((line.maxX - line.minX) / viewport.width),
    h: clamp01(line.height / viewport.height),
  }));
}

/** @param {{title?: unknown, pageCount?: number, processedPages?: number[], pageAssets?: any[], pageLines?: any[], notes?: unknown[]}} [input] Build the canonical model body and native-view provenance for either host. */
export function buildPdfDocument({ title, pageCount, processedPages, pageAssets, pageLines, notes } = {}) {
  const bodyLines = [`# ${cleanHeading(title || "PDF Document")}`, ""];
  const provenance = [];
  const linesByPage = new Map((pageLines || []).map((entry) => [entry.page, Array.isArray(entry.lines) ? entry.lines : []]));
  for (const pageNumber of Array.isArray(processedPages) ? processedPages : []) {
    const lines = linesByPage.get(pageNumber) || [];
    if (!lines.length) bodyLines.push(`*(page ${pageNumber}: no extractable text)*`);
    for (const line of lines) {
      const ordinal = bodyLines.length;
      bodyLines.push(String(line.text || ""));
      provenance.push({ p: pageNumber, x: line.x, y: line.y, w: line.w, h: line.h, ordinal });
    }
  }
  const usefulNotes = (notes || []).map((note) => String(note || "").trim()).filter(Boolean);
  for (const note of usefulNotes) bodyLines.push(note);
  const assembled = bodyLines.join("\n").trimEnd() + "\n";
  let blockId = 0;
  const markdown = normalizeBlockIds(assembled, { idFactory: () => `pdf${String(blockId++).padStart(3, "0")}` }).markdown;
  const positions = linePositions(markdown);
  const lines = provenance.map(({ ordinal, ...line }) => ({
    ...line,
    s: positions[ordinal].s,
    e: positions[ordinal].e,
  }));
  const assetsByPage = new Map((pageAssets || []).map((entry) => [entry.page, entry]));
  const pages = (processedPages || []).map((n) => {
    const asset = assetsByPage.get(n) || {};
    return { n, asset: asset.name, w: asset.width, h: asset.height };
  });
  return {
    markdown,
    pdfExtension: {
      version: 1,
      scale: PDF_RENDER_SCALE,
      page_count: Number(pageCount) || pages.length,
      pages,
      lines,
      notes: usefulNotes,
      converting: false,
      converted: false,
      original_markdown: null,
    },
  };
}

/** Consumer-side validation for schema-opaque extension data. */
/** @param {any} nodeOrExtension */
export function normalizePdfExtension(nodeOrExtension) {
  try {
    const body = String(nodeOrExtension?.markdown ?? nodeOrExtension?.md ?? "");
    const value = nodeOrExtension?.extensions?.pdf ?? nodeOrExtension?.pdf ?? nodeOrExtension;
    if (!value || value.version !== 1 || !Array.isArray(value.pages) || !Array.isArray(value.lines)) return null;
    if (value.pages.length > MAX_PDF_PAGES || value.lines.length > MAX_PDF_LINES) return null;
    const finite = (/** @type {unknown} */ number) => typeof number === "number" && Number.isFinite(number);
    if (!finite(value.scale) || !finite(value.page_count) || value.page_count < value.pages.length) return null;
    const pages = value.pages.map((/** @type {any} */ page) => {
      if (!finite(page.n) || !finite(page.w) || !finite(page.h) || page.w <= 0 || page.h <= 0) throw new Error("bad page");
      return { n: page.n, asset: validateAssetName(page.asset), w: page.w, h: page.h };
    });
    let previous = -1;
    const lines = value.lines.map((/** @type {any} */ line) => {
      for (const key of ["p", "x", "y", "w", "h", "s", "e"]) if (!finite(line[key])) throw new Error("bad line");
      if (line.s < previous || line.s < 0 || line.e < line.s || line.e > body.length) throw new Error("bad offsets");
      previous = line.e;
      return { p: line.p, x: clamp01(line.x), y: clamp01(line.y), w: clamp01(line.w), h: clamp01(line.h), s: line.s, e: line.e };
    });
    return { ...value, pages, lines, notes: Array.isArray(value.notes) ? value.notes.map(String) : [] };
  } catch {
    return null;
  }
}

/** @param {string} markdown */
function linePositions(markdown) {
  const positions = [];
  let s = 0;
  for (const text of markdown.split("\n").slice(0, -1)) {
    positions.push({ s, e: s + text.length });
    s += text.length + 1;
  }
  return positions;
}

/** @param {unknown} value */
function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

/** @param {unknown} value */
function cleanHeading(value) {
  return String(value || "PDF Document").replace(/\s+/g, " ").replace(/^#+\s*/, "").trim() || "PDF Document";
}
