import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createStagedAssetDir, ensureAssetDir, loadHole, validateAssetName } from "./fs-store.js";
import {
  MAX_PDF_BYTES,
  PDF_RENDER_SCALE,
  describePdfOpenError,
  extractPdfPageText,
  normalizePdfTitle,
  pdfPageAssetName,
  resolvePagesToProcess,
  hasPdfMagic,
} from "../core/pdf-shared.js";

const require = createRequire(import.meta.url);

const IMAGE_TIMEOUT_MS = 7000;
let activeCanvasModule = null;

function optionalDepsCommand() {
  return "npm install --include=optional";
}

function isMissingPackageError(err, packageName) {
  const message = String(err?.message || "");
  return (
    err?.code === "ERR_MODULE_NOT_FOUND" ||
    err?.code === "MODULE_NOT_FOUND" ||
    message.includes(`Cannot find package '${packageName}'`) ||
    message.includes(`Cannot find module '${packageName}'`)
  );
}

async function loadPdfjs() {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const packageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
    return {
      pdfjs,
      standardFontDataUrl: path.join(packageRoot, "standard_fonts") + path.sep,
    };
  } catch (err) {
    if (isMissingPackageError(err, "pdfjs-dist")) {
      throw new Error(
        `PDF support needs optional dependencies. Reinstall Rabbithole with optional deps enabled, e.g. run \`${optionalDepsCommand()}\` in the Rabbithole package.`
      );
    }
    throw err;
  }
}

async function loadCanvas() {
  try {
    const canvas = await import("@napi-rs/canvas");
    return { canvas, note: null };
  } catch (err) {
    return {
      canvas: null,
      note:
        "PNG page renders and embedded raster extraction were skipped because @napi-rs/canvas could not load. " +
        `Reinstall optional dependencies with \`${optionalDepsCommand()}\`. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function installCanvasGlobals(canvasModule) {
  for (const name of ["DOMMatrix", "DOMPoint", "DOMRect", "Path2D"]) {
    if (!globalThis[name] && canvasModule?.[name]) globalThis[name] = canvasModule[name];
  }
}

class NapiCanvasFactory {
  constructor(canvasModule = activeCanvasModule) {
    this.canvasModule = canvasModule?.createCanvas ? canvasModule : activeCanvasModule;
  }

  create(width, height) {
    if (!this.canvasModule) throw new Error("@napi-rs/canvas is not available.");
    const canvas = this.canvasModule.createCanvas(Math.ceil(width), Math.ceil(height));
    return {
      canvas,
      context: canvas.getContext("2d"),
    };
  }

  reset(entry, width, height) {
    if (!entry?.canvas) throw new Error("Canvas entry is missing a canvas.");
    entry.canvas.width = Math.ceil(width);
    entry.canvas.height = Math.ceil(height);
  }

  destroy(entry) {
    if (!entry?.canvas) return;
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    entry.canvas = null;
    entry.context = null;
  }
}

async function validatePdfFile(filePath) {
  const rawPath = String(filePath ?? "");
  if (!rawPath) throw new Error("file_path is required");
  const absolute = path.resolve(rawPath);
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch {
    throw new Error(`PDF file does not exist: ${absolute}`);
  }
  if (!stat.isFile()) throw new Error(`PDF path is not a file: ${absolute}`);
  if (stat.size > MAX_PDF_BYTES) {
    throw new Error(`PDF file exceeds the 100 MB limit: ${absolute}`);
  }

  const handle = await fs.open(absolute, "r");
  try {
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, magic.length, 0);
    if (!hasPdfMagic(magic)) {
      throw new Error(`file_path is not a PDF: expected a %PDF header at ${absolute}`);
    }
  } finally {
    await handle.close();
  }
  return absolute;
}

async function prepareDestination(holeId) {
  if (holeId) {
    try {
      const hole = await loadHole(holeId);
      return { hole_id: hole.hole_id, dir: await ensureAssetDir(hole.hole_id) };
    } catch (err) {
      throw new Error(`hole_id was not found or could not be loaded: ${holeId}`);
    }
  }
  return createStagedAssetDir();
}

function imageKindName(pdfjs, kind) {
  for (const [name, code] of Object.entries(pdfjs.ImageKind || {})) {
    if (code === kind) return name;
  }
  return `UNKNOWN_${kind}`;
}

function rgbaFromMask(pdfjs, mask, width, height) {
  if (!mask || mask.width !== width || mask.height !== height || !mask.data) return null;
  const data = mask.data;
  if (mask.kind === pdfjs.ImageKind.RGBA_32BPP && data.length >= width * height * 4) {
    const alpha = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 3; i < alpha.length; i += 1, j += 4) alpha[i] = data[j];
    return alpha;
  }
  if (mask.kind === pdfjs.ImageKind.RGB_24BPP && data.length >= width * height * 3) {
    const alpha = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 0; i < alpha.length; i += 1, j += 3) alpha[i] = data[j];
    return alpha;
  }
  if (data.length >= width * height) return new Uint8ClampedArray(data.subarray(0, width * height));
  if (mask.kind === pdfjs.ImageKind.GRAYSCALE_1BPP) {
    const alpha = new Uint8ClampedArray(width * height);
    for (let i = 0; i < alpha.length; i += 1) {
      alpha[i] = (data[i >> 3] >> (7 - (i & 7))) & 1 ? 255 : 0;
    }
    return alpha;
  }
  return null;
}

function imageToRgba(pdfjs, imgData) {
  const width = imgData.width;
  const height = imgData.height;
  const pixelCount = width * height;
  const data = imgData.data;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Image has invalid dimensions.");
  }
  if (!data) throw new Error("Image has no decoded pixel data.");

  let rgba;
  if (imgData.kind === pdfjs.ImageKind.RGBA_32BPP || data.length >= pixelCount * 4) {
    rgba = new Uint8ClampedArray(data.subarray(0, pixelCount * 4));
  } else if (imgData.kind === pdfjs.ImageKind.RGB_24BPP || data.length >= pixelCount * 3) {
    rgba = new Uint8ClampedArray(pixelCount * 4);
    for (let src = 0, dst = 0; dst < rgba.length; src += 3, dst += 4) {
      rgba[dst] = data[src];
      rgba[dst + 1] = data[src + 1];
      rgba[dst + 2] = data[src + 2];
      rgba[dst + 3] = 255;
    }
  } else if (imgData.kind === pdfjs.ImageKind.GRAYSCALE_1BPP) {
    rgba = new Uint8ClampedArray(pixelCount * 4);
    for (let i = 0, dst = 0; i < pixelCount; i += 1, dst += 4) {
      const value = (data[i >> 3] >> (7 - (i & 7))) & 1 ? 255 : 0;
      rgba[dst] = value;
      rgba[dst + 1] = value;
      rgba[dst + 2] = value;
      rgba[dst + 3] = 255;
    }
  } else if (data.length >= pixelCount) {
    rgba = new Uint8ClampedArray(pixelCount * 4);
    for (let src = 0, dst = 0; src < pixelCount; src += 1, dst += 4) {
      const value = data[src];
      rgba[dst] = value;
      rgba[dst + 1] = value;
      rgba[dst + 2] = value;
      rgba[dst + 3] = 255;
    }
  } else {
    throw new Error(`Unsupported image data length ${data.length} for ${width}x${height}.`);
  }

  const alpha = rgbaFromMask(pdfjs, imgData.smask || imgData.mask, width, height);
  if (alpha) {
    for (let i = 0, dst = 3; i < alpha.length; i += 1, dst += 4) rgba[dst] = alpha[i];
  }
  return rgba;
}

function getPdfObject(store, objId, timeoutMs) {
  if (store.has(objId)) return Promise.resolve(store.get(objId));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for image object ${objId}`)), timeoutMs);
    try {
      store.get(objId, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

async function resolveImageObject(page, objId) {
  try {
    return await getPdfObject(page.objs, objId, IMAGE_TIMEOUT_MS);
  } catch (firstErr) {
    try {
      return await getPdfObject(page.commonObjs, objId, Math.min(1500, IMAGE_TIMEOUT_MS));
    } catch {
      throw firstErr;
    }
  }
}

async function saveImageData({ pdfjs, canvasModule, imgData, destDir, name }) {
  const width = imgData.width;
  const height = imgData.height;
  const rgba = imageToRgba(pdfjs, imgData);
  const canvas = canvasModule.createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new canvasModule.ImageData(rgba, width, height), 0, 0);
  const buffer = canvas.toBuffer("image/png");
  await fs.writeFile(path.join(destDir, validateAssetName(name)), buffer);
  canvas.width = 0;
  canvas.height = 0;
  return { width, height };
}

async function extractEmbeddedImages({ pdfjs, canvasModule, page, pageNumber, destDir, notes }) {
  const imageOps = new Set([
    pdfjs.OPS.paintImageXObject,
    pdfjs.OPS.paintImageXObjectRepeat,
    pdfjs.OPS.paintInlineImageXObject,
  ]);
  const opList = await page.getOperatorList();
  const seenXObjects = new Set();
  const images = [];
  let imageOrdinal = 0;

  for (let i = 0; i < opList.fnArray.length; i += 1) {
    const fn = opList.fnArray[i];
    if (!imageOps.has(fn)) continue;
    const args = opList.argsArray[i] || [];
    try {
      let imgData;
      if (fn === pdfjs.OPS.paintInlineImageXObject) {
        imgData = args[0];
      } else {
        const objId = args[0];
        if (seenXObjects.has(objId)) continue;
        seenXObjects.add(objId);
        imgData = await resolveImageObject(page, objId);
      }

      imageOrdinal += 1;
      const name = `embed-p${String(pageNumber).padStart(3, "0")}-${String(imageOrdinal).padStart(2, "0")}.png`;
      const saved = await saveImageData({ pdfjs, canvasModule, imgData, destDir, name });
      images.push({ page: pageNumber, name, ...saved });
    } catch (err) {
      notes.push(
        `Skipped embedded image on page ${pageNumber}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return images;
}

async function renderPage({ canvasModule, canvasFactory, page, pageNumber, destDir }) {
  const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  const canvas = canvasModule.createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);
  const renderTask = page.render({
    canvasContext: context,
    viewport,
    canvasFactory,
  });
  await renderTask.promise;
  const buffer = canvas.toBuffer("image/png");
  const name = pdfPageAssetName(pageNumber);
  await fs.writeFile(path.join(destDir, validateAssetName(name)), buffer);
  canvas.width = 0;
  canvas.height = 0;
  return { page: pageNumber, name, width, height };
}

/**
 * Extract page PNGs, embedded rasters, metadata, and text from a local PDF.
 * Page rendering and image extraction are best-effort; text still works when
 * the optional native canvas package is unavailable.
 */
export async function ingestPdf({ filePath, holeId, pages, includeText = true } = {}) {
  const absolutePath = await validatePdfFile(filePath);
  const { canvas: canvasModule, note: canvasNote } = await loadCanvas();
  const notes = [];
  if (canvasNote) notes.push(canvasNote);
  if (canvasModule) {
    activeCanvasModule = canvasModule;
    installCanvasGlobals(canvasModule);
  }
  const { pdfjs, standardFontDataUrl } = await loadPdfjs();

  const data = new Uint8Array(await fs.readFile(absolutePath));
  const documentCanvasFactory = canvasModule ? new NapiCanvasFactory(canvasModule) : undefined;
  const loadingTask = pdfjs.getDocument({
    data,
    standardFontDataUrl,
    CanvasFactory: canvasModule ? NapiCanvasFactory : undefined,
    canvasFactory: documentCanvasFactory,
    disableFontFace: true,
    isEvalSupported: false,
    useWorkerFetch: false,
  });

  let doc;
  let destination;
  let completed = false;
  try {
    try {
      doc = await loadingTask.promise;
    } catch (err) {
      throw new Error(describePdfOpenError(err, {
        label: absolutePath,
        encryptedHint: "Provide a decrypted copy and run ingest_pdf again.",
        engine: "pdfjs",
      }));
    }

    const metadata = await doc.getMetadata().catch((err) => {
      notes.push(`PDF metadata could not be read: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    const processedPages = resolvePagesToProcess(doc.numPages, pages, notes);
    destination = await prepareDestination(holeId);
    const result = {
      ...(destination.hole_id ? { hole_id: destination.hole_id } : { ingest_id: destination.ingest_id }),
      title: normalizePdfTitle(metadata),
      page_count: doc.numPages,
      processed_pages: processedPages,
      assets: {
        pages: [],
        embedded_images: [],
      },
      notes,
    };
    if (includeText !== false) result.text = [];

    const canvasFactory = documentCanvasFactory || (canvasModule ? new NapiCanvasFactory(canvasModule) : null);
    for (const pageNumber of processedPages) {
      let page = null;
      try {
        page = await doc.getPage(pageNumber);
        if (includeText !== false) {
          result.text.push({ page: pageNumber, text: await extractPdfPageText(page) });
        }
        if (canvasModule) {
          result.assets.embedded_images.push(
            ...(await extractEmbeddedImages({ pdfjs, canvasModule, page, pageNumber, destDir: destination.dir, notes }))
          );
          result.assets.pages.push(
            await renderPage({ canvasModule, canvasFactory, page, pageNumber, destDir: destination.dir })
          );
        }
      } catch (err) {
        notes.push(`Page ${pageNumber} could not be fully processed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        page?.cleanup?.();
      }
    }

    completed = true;
    return result;
  } finally {
    doc?.cleanup?.();
    await loadingTask.destroy();
    if (!completed && destination?.ingest_id) {
      await fs.rm(destination.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
