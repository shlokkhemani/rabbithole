export const MAX_PDF_BYTES = 100 * 1024 * 1024;
const DEFAULT_PAGE_CAP = 40;
export const PDF_RENDER_VERSION = 2;
export const PDF_AGENT_CROP_MAX_LONG_EDGE = 3072;
export const PDF_AGENT_CROP_PADDING_POINTS = 12;

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
export const MAX_PDF_FIGURE_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const MAX_PDF_LINES = 25000;

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

/** @param {unknown} digest */
export function pdfSourceAssetName(digest) {
  const value = String(digest || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("PDF source needs a SHA-256 digest");
  return `pdf-${value}.pdf`;
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
  /** @type {TextGeometry[]} */
  const textItems = [];
  for (const item of items) {
    if (typeof item.str !== "string" || !item.str.length || !item.transform) continue;
    const geometry = getTextItemGeometry(item);
    if (geometry.str.trim().length) textItems.push(geometry);
  }

  textItems.sort((a, b) => {
    const yDelta = b.y - a.y;
    if (Math.abs(yDelta) > 1.5) return yDelta;
    return a.x - b.x;
  });

  /** @type {{ y: number, items: TextGeometry[], ordinal: number, bucket: number }[]} */
  const lines = [];
  const bucketSize = 2;
  /** @type {Map<number, { y: number, items: TextGeometry[], ordinal: number, bucket: number }[]>} */
  const linesByY = new Map();
  const addToBucket = (/** @type {{ y: number, items: TextGeometry[], ordinal: number, bucket: number }} */ line) => {
    const bucket = Math.floor(line.y / bucketSize);
    line.bucket = bucket;
    const entries = linesByY.get(bucket);
    if (entries) entries.push(line);
    else linesByY.set(bucket, [line]);
  };
  const moveBucket = (/** @type {{ y: number, items: TextGeometry[], ordinal: number, bucket: number }} */ line) => {
    const bucket = Math.floor(line.y / bucketSize);
    if (bucket === line.bucket) return;
    const previous = linesByY.get(line.bucket);
    const index = previous?.indexOf(line) ?? -1;
    if (previous && index !== -1) previous.splice(index, 1);
    if (previous && !previous.length) linesByY.delete(line.bucket);
    addToBucket(line);
  };
  for (const item of textItems) {
    const threshold = Math.max(1.8, item.height * 0.45);
    const firstBucket = Math.floor((item.y - threshold) / bucketSize);
    const lastBucket = Math.floor((item.y + threshold) / bucketSize);
    let line = null;
    for (let bucket = firstBucket; bucket <= lastBucket; bucket++) {
      const candidates = linesByY.get(bucket);
      if (!candidates) continue;
      for (const candidate of candidates) {
        if (Math.abs(candidate.y - item.y) <= threshold && (!line || candidate.ordinal < line.ordinal)) line = candidate;
      }
    }
    if (!line) {
      line = { y: item.y, items: [], ordinal: lines.length, bucket: 0 };
      lines.push(line);
      addToBucket(line);
    }
    line.items.push(item);
    line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
    moveBucket(line);
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
        let maxHeight = 0;
        for (const item of entry.items) {
          minX = Math.min(minX, item.x);
          maxX = Math.max(maxX, item.x + item.width);
          maxHeight = Math.max(maxHeight, item.height);
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
          height: maxHeight,
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
  let leftCount = 0;
  let rightCount = 0;
  const classified = lines.map((line) => {
    let column = "full";
    if (line.maxX < mid + gutter) column = "left";
    else if (line.minX > mid - gutter) column = "right";
    if (column === "left") leftCount++;
    else if (column === "right") rightCount++;
    return { ...line, column };
  });
  if (leftCount < 8 || rightCount < 8) return classified;

  /** @type {ClassifiedLine[]} */
  const ordered = [];
  /** @type {ClassifiedLine[]} */
  let run = [];
  const flushRun = () => {
    if (run.length === 0) return;
    /** @type {ClassifiedLine[]} */
    const left = [], right = [], other = [];
    for (const line of run) {
      if (line.column === "left") left.push(line);
      else if (line.column === "right") right.push(line);
      else other.push(line);
    }
    left.sort((a, b) => b.y - a.y);
    right.sort((a, b) => b.y - a.y);
    other.sort((a, b) => b.y - a.y || a.minX - b.minX);
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
  const view = Array.isArray(page.view) ? page.view : [0, 0, 1, 1];
  return orderLinesForReading(clusterTextLines(content?.items || []), view[2] - view[0]).map((line) => ({ text: line.text }));
}

/** Metadata used by every renderer and coordinate conversion. */
/** @param {any} page @param {number} [pageNumber] */
export function pdfPageMetadata(page, pageNumber = page?.pageNumber) {
  const view = Array.from(page?.view || [], Number);
  if (view.length !== 4 || !view.every(Number.isFinite) || !(view[2] > view[0]) || !(view[3] > view[1])) {
    throw new Error(`PDF page ${pageNumber || "?"} has an invalid visible page box`);
  }
  const rotate = ((Math.round(Number(page?.rotate) || 0) % 360) + 360) % 360;
  if (rotate % 90 !== 0) throw new Error(`PDF page ${pageNumber || "?"} has an unsupported rotation`);
  return {
    n: Math.floor(Number(pageNumber)),
    view,
    rotate,
    user_unit: Number(page?.userUnit) > 0 ? Number(page.userUnit) : 1,
  };
}

/** @param {{title?: unknown, pageCount?: number, processedPages?: number[], pageMetadata?: any[], pageLines?: any[], notes?: unknown[], source?: any}} [input] */
export function buildPdfDocument({ title, pageCount, processedPages, pageMetadata: metadata, pageLines, notes, source } = {}) {
  const bodyLines = [`# ${cleanHeading(title || "PDF Document")}`, ""];
  const provenance = [];
  const linesByPage = new Map((pageLines || []).map((entry) => [entry.page, Array.isArray(entry.lines) ? entry.lines : []]));
  for (const pageNumber of Array.isArray(processedPages) ? processedPages : []) {
    const lines = linesByPage.get(pageNumber) || [];
    if (!lines.length) bodyLines.push(`*(page ${pageNumber}: no extractable text)*`);
    for (const line of lines) {
      const ordinal = bodyLines.length;
      bodyLines.push(String(line.text || ""));
      provenance.push({ p: pageNumber, ordinal });
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
  const pagesByNumber = new Map((metadata || []).map((entry) => [entry.n, entry]));
  const pages = (processedPages || []).map((n) => pagesByNumber.get(n)).filter(Boolean);
  return {
    markdown,
    pdfExtension: {
      version: PDF_RENDER_VERSION,
      source,
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
    if (!value || value.version !== PDF_RENDER_VERSION || !Array.isArray(value.pages) || !Array.isArray(value.lines)) return null;
    if (value.pages.length > MAX_PDF_PAGES || value.lines.length > MAX_PDF_LINES) return null;
    const finite = (/** @type {unknown} */ number) => typeof number === "number" && Number.isFinite(number);
    if (!finite(value.page_count) || value.page_count < value.pages.length) return null;
    const source = value.source;
    if (!source || typeof source !== "object") return null;
    const sourceAsset = validateAssetName(source.asset);
    if (!sourceAsset.endsWith(".pdf") || !/^[a-f0-9]{64}$/.test(String(source.sha256 || ""))) return null;
    if (!finite(source.byte_length) || source.byte_length <= 0 || source.byte_length > MAX_PDF_BYTES) return null;
    const pages = value.pages.map((/** @type {any} */ page) => {
      if (!finite(page.n) || page.n < 1 || !Array.isArray(page.view) || page.view.length !== 4 || !page.view.every(finite)) throw new Error("bad page");
      if (!(page.view[2] > page.view[0]) || !(page.view[3] > page.view[1])) throw new Error("bad page box");
      const rotate = ((Math.round(Number(page.rotate) || 0) % 360) + 360) % 360;
      if (rotate % 90 !== 0) throw new Error("bad rotation");
      const userUnit = finite(page.user_unit) && page.user_unit > 0 ? page.user_unit : 1;
      return { n: Math.floor(page.n), view: page.view.map(Number), rotate, user_unit: userUnit };
    });
    let previous = -1;
    const lines = value.lines.map((/** @type {any} */ line) => {
      for (const key of ["p", "s", "e"]) if (!finite(line[key])) throw new Error("bad line");
      if (line.s < previous || line.s < 0 || line.e < line.s || line.e > body.length) throw new Error("bad offsets");
      previous = line.e;
      return { p: Math.floor(line.p), s: line.s, e: line.e };
    });
    return { ...value, source: { asset: sourceAsset, sha256: source.sha256, byte_length: source.byte_length }, pages, lines, notes: Array.isArray(value.notes) ? value.notes.map(String) : [] };
  } catch {
    return null;
  }
}

/** @param {any} anchor @param {number} pageNumber */
export function pdfAnchorBounds(anchor, pageNumber) {
  const fragment = anchor?.fragments?.find((/** @type {any} */ entry) => Number(entry?.page) === Number(pageNumber));
  if (!fragment) return null;
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (const quad of fragment.quads || []) {
    for (const point of quad || []) {
      const x = Number(point?.[0]), y = Number(point?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      xMin = Math.min(xMin, x); yMin = Math.min(yMin, y);
      xMax = Math.max(xMax, x); yMax = Math.max(yMax, y);
    }
  }
  return xMax > xMin && yMax > yMin ? [xMin, yMin, xMax, yMax] : null;
}

/** @param {number[]} bounds @param {number[]} pageView @param {number} [padding] */
export function expandPdfBounds(bounds, pageView, padding = PDF_AGENT_CROP_PADDING_POINTS) {
  if (!Array.isArray(bounds) || !Array.isArray(pageView) || bounds.length !== 4 || pageView.length !== 4) return null;
  const pad = Math.max(0, Number(padding) || 0);
  const expanded = [
    Math.max(pageView[0], bounds[0] - pad),
    Math.max(pageView[1], bounds[1] - pad),
    Math.min(pageView[2], bounds[2] + pad),
    Math.min(pageView[3], bounds[3] + pad),
  ];
  return expanded[2] > expanded[0] && expanded[3] > expanded[1] ? expanded : null;
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
/** @param {unknown} value */
function cleanHeading(value) {
  return String(value || "PDF Document").replace(/\s+/g, " ").replace(/^#+\s*/, "").trim() || "PDF Document";
}
