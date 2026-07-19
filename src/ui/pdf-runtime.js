const documents = new Map();
let workerObjectUrl = null;
let configured = false;
let pdfjs = null;
let pdfjsPromise = null;
let pdfjsNetworkAttempts = 0;

export async function loadPdfJsModule() {
  if (pdfjs) return pdfjs;
  if (!pdfjsPromise) {
    const carrier = typeof document !== "undefined" && document.getElementById("rabbithole-pdfjs-runtime");
    const source = globalThis.__RABBITHOLE_PDFJS_SOURCE__ || carrier?.textContent || "";
    if (source && typeof Blob === "function" && globalThis.URL?.createObjectURL) {
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      pdfjsPromise = import(url)
        .finally(() => setTimeout(() => URL.revokeObjectURL(url), 1000))
        .catch((error) => { pdfjsPromise = null; throw error; });
    } else {
      const nodeRuntime = typeof process !== "undefined" && process.versions?.node;
      let runtimeUrl = nodeRuntime ? ["pdfjs-dist", "build/pdf.mjs"].join("/") : new URL("pdf.mjs", document.baseURI).href;
      if (!nodeRuntime && pdfjsNetworkAttempts) {
        const retryUrl = new URL(runtimeUrl);
        retryUrl.searchParams.set("retry", String(pdfjsNetworkAttempts));
        runtimeUrl = retryUrl.href;
      }
      pdfjsNetworkAttempts++;
      pdfjsPromise = import(runtimeUrl).catch((error) => { pdfjsPromise = null; throw error; });
    }
  }
  pdfjs = await pdfjsPromise;
  configurePdfJs();
  return pdfjs;
}

function configurePdfJs() {
  if (configured || !pdfjs) return;
  configured = true;
  const carrier = typeof document !== "undefined" && document.getElementById("rabbithole-pdf-worker-runtime");
  const source = globalThis.__RABBITHOLE_PDF_WORKER_SOURCE__ || carrier?.textContent || "";
  if (source && typeof Blob === "function" && globalThis.URL?.createObjectURL) {
    workerObjectUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    pdfjs.GlobalWorkerOptions.workerSrc = workerObjectUrl;
  } else if (typeof window !== "undefined") {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.mjs", document.baseURI).href;
  }
}

function runtimeAssetUrl(directory) {
  if (typeof document === "undefined" || location.protocol === "file:") return undefined;
  return new URL(`${directory}/`, document.baseURI).href;
}

/** Share a parsed PDF between Reader and Canvas mounts of the same node. */
export async function acquirePdfDocument({ key, url, data, blob }) {
  await loadPdfJsModule();
  const cacheKey = String(key || url || "");
  let entry = documents.get(cacheKey);
  if (!entry) {
    const sourceData = data || (blob ? new Uint8Array(await blob.arrayBuffer()) : null);
    const loadingTask = pdfjs.getDocument({
      ...(sourceData ? { data: sourceData } : { url }),
      ...runtimeCanvasFactoryOption(),
      standardFontDataUrl: runtimeAssetUrl("standard_fonts"),
      cMapUrl: runtimeAssetUrl("cmaps"),
      cMapPacked: true,
      isEvalSupported: false,
      enableXfa: false,
      useWorkerFetch: true,
      verbosity: pdfjs.VerbosityLevel?.ERRORS,
    });
    entry = { loadingTask, promise: loadingTask.promise, refs: 0, destroyTimer: 0 };
    documents.set(cacheKey, entry);
    entry.promise.catch(() => { if (documents.get(cacheKey) === entry) documents.delete(cacheKey); });
  }
  clearTimeout(entry.destroyTimer);
  entry.refs++;
  const documentProxy = await entry.promise;
  let released = false;
  return {
    document: documentProxy,
    pdfjs,
    release() {
      if (released) return;
      released = true;
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs) return;
      scheduleDestroy(cacheKey, entry, 1500);
    },
  };
}

/**
 * Hand an already parsed import document to an imminent Reader/Canvas mount.
 * The cache owns the loading task only when this returns true.
 */
export function primePdfDocument({ key, loadingTask, document: documentProxy }) {
  const cacheKey = String(key || "");
  if (!cacheKey || !loadingTask || !documentProxy || documents.has(cacheKey)) return false;
  const entry = { loadingTask, promise: Promise.resolve(documentProxy), refs: 0, destroyTimer: 0 };
  documents.set(cacheKey, entry);
  scheduleDestroy(cacheKey, entry, 5000);
  return true;
}

function scheduleDestroy(cacheKey, entry, delay) {
  clearTimeout(entry.destroyTimer);
  entry.destroyTimer = setTimeout(() => {
    if (entry.refs || documents.get(cacheKey) !== entry) return;
    documents.delete(cacheKey);
    entry.loadingTask.destroy().catch(() => {});
  }, delay);
  entry.destroyTimer?.unref?.();
}

function runtimeCanvasFactoryOption() {
  if (typeof process === "undefined" || !process.versions?.node || typeof document === "undefined" || typeof document.createElement !== "function") return {};
  const RuntimeCanvasFactory = class {
    create(width, height) {
      if (!(width > 0 && height > 0)) throw new Error("Canvas dimensions must be positive.");
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      return { canvas, context: canvas.getContext("2d") };
    }
    reset(target, width, height) {
      if (!target?.canvas) throw new Error("Canvas target is missing.");
      target.canvas.width = width; target.canvas.height = height;
    }
    destroy(target) {
      if (!target?.canvas) return;
      target.canvas.width = 0; target.canvas.height = 0; target.canvas = null; target.context = null;
    }
  };
  return { canvasFactory: new RuntimeCanvasFactory() };
}

export function renderPdfTextLayer(params) {
  if (!pdfjs) throw new Error("PDF.js is not loaded");
  return pdfjs.renderTextLayer(params);
}

export function updatePdfTextLayer(params) {
  if (!pdfjs) throw new Error("PDF.js is not loaded");
  return pdfjs.updateTextLayer(params);
}

export function pdfAnnotationModeDisabled() {
  return pdfjs.AnnotationMode?.DISABLE ?? 0;
}

export function pdfShowTextOpcode() {
  return pdfjs?.OPS?.showText;
}
