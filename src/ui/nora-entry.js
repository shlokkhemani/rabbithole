import { createNoraUi } from "./composition.js";
import { mountPdfView } from "./pdf-view.js";
import { cropPdfSourceToBlob } from "./pdf-crop.js";
import { loadPdfJsModule } from "./pdf-runtime.js";
import {
  buildPdfDocument,
  extractPdfPageLines,
  normalizePdfExtension,
  normalizePdfTitle,
  pdfPageMetadata,
  resolvePagesToProcess,
} from "../core/pdf-shared.js";
import { showWholeCanvasAsk } from "./ask-followups.js";

const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
let runtime = null;
let mermaidPromise = null;
let lastHydration = null;
let startChain = Promise.resolve();

window.addEventListener("message", (event) => {
  let message;
  try {
    message = validateIncomingMessage(event.data);
  } catch (error) {
    showBootError(error);
    return;
  }
  if (message.type === "hydrate") {
    startChain = startChain.then(() => startNora(message.hydration)).catch((error) => { showBootError(error); });
  }
  else if (message.type === "command") handleCommand(message.command);
  else if (message.type === "error") showBootError(new Error(message.message));
});

postToExtension({ type: "ready" });

/** @param {Record<string, unknown>} hydration */
async function startNora(hydration) {
  document.documentElement.classList.add("nora-webview");
  lastHydration = hydration;
  applyNoraChromeLabels();
  if (runtime && !runtime.disposed) await runtime.dispose();
  runtime = createNoraUi({
    hydration,
    host: {
      post: async (event) => {
        const prepared = await prepareOutgoingEvent(event);
        postToExtension({ type: "uiEvent", event: prepared.event });
        return { ok: true, crop_asset: prepared.cropAsset ?? null };
      },
      refreshStatus: () => {},
      start: () => {},
      flush: () => Promise.resolve(),
      dispose: () => {},
    },
    capabilities: {
      mountPdfView,
      loadMermaid: loadMermaidRuntime,
      exportSnapshot: null,
      exportPortable: null,
    },
  });
  exposeTestApi();
}

/** @param {Record<string, unknown>} event */
async function prepareOutgoingEvent(event) {
  if (event?.type === "branch_request" && event.anchor && typeof event.anchor === "object") {
    const crop = await preparePdfCropForEvent(event).catch(() => null);
    if (crop) return { event: { ...event, crop }, cropAsset: crop.asset_name };
  }
  if (event?.type === "convert_pdf") {
    const conversion = await preparePdfConversionForEvent(event);
    return { event: { ...event, conversion }, cropAsset: null };
  }
  return { event, cropAsset: null };
}

/** @param {Record<string, unknown>} event */
async function preparePdfCropForEvent(event) {
  const anchor = /** @type {{ pdf?: any }} */ (event.anchor).pdf;
  const pageNumber = Number(anchor?.fragments?.[0]?.page);
  if (!anchor || !Number.isFinite(pageNumber)) return null;
  const source = pdfSourceForAnchor(anchor, String(event.parent_id ?? ""));
  if (!source) return null;
  const blob = await fetchPdfBlob(source);
  const crop = await cropPdfSourceToBlob(blob, { sourceKey: source.sha256, pageNumber, anchor });
  const bytes = new Uint8Array(await crop.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  const assetName = `image-${sha256}.png`;
  return {
    media_type: "image/png",
    bytes_base64: base64Bytes(bytes),
    sha256,
    asset_name: assetName,
    filename: assetName,
    title: `PDF crop page ${pageNumber}`,
    source_sha256: source.sha256,
    page: pageNumber,
    anchor,
    selected_text: String(event.selected_text ?? ""),
  };
}

/** @param {Record<string, unknown>} event */
async function preparePdfConversionForEvent(event) {
  const node = findHydratedNode(String(event.node_id ?? ""));
  const pdf = normalizePdfExtension(node);
  if (!node || !pdf) throw new Error("PDF conversion needs a hydrated PDF node");
  const blob = await fetchPdfBlob(pdf.source);
  const pdfjs = await loadPdfJsModule();
  const data = new Uint8Array(await blob.arrayBuffer());
  const loadingTask = pdfjs.getDocument({
    data,
    standardFontDataUrl: new URL("standard_fonts/", import.meta.url).href,
    cMapUrl: new URL("cmaps/", import.meta.url).href,
    cMapPacked: true,
    isEvalSupported: false,
    useWorkerFetch: true,
  });
  let loaded = null;
  try {
    loaded = await loadingTask.promise;
    const notes = [];
    const metadata = await loaded.getMetadata().catch((error) => {
      notes.push(`PDF metadata could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    const processedPages = resolvePagesToProcess(loaded.numPages, null, notes);
    const pageMetadata = [];
    const pageLines = [];
    for (const pageNumber of processedPages) {
      const page = await loaded.getPage(pageNumber);
      try {
        pageMetadata.push(pdfPageMetadata(page, pageNumber));
        pageLines.push({ page: pageNumber, lines: await extractPdfPageLines(page) });
      } finally {
        page.cleanup?.();
      }
    }
    const title = normalizePdfTitle(metadata) || String(node.title || "PDF Document");
    const built = buildPdfDocument({
      title,
      pageCount: loaded.numPages,
      processedPages,
      pageMetadata,
      pageLines,
      notes,
      source: pdf.source,
    });
    return { markdown: built.markdown, pdfExtension: built.pdfExtension };
  } finally {
    loaded?.cleanup?.();
    await loadingTask.destroy().catch(() => {});
  }
}

/** @param {{ source_sha256?: string }} anchor @param {string} parentNodeId */
function pdfSourceForAnchor(anchor, parentNodeId) {
  const wanted = String(anchor.source_sha256 ?? "");
  for (const node of lastHydration?.nodes || []) {
    const pdf = normalizePdfExtension(node);
    if (pdf && (!wanted || pdf.source.sha256 === wanted)) return pdf.source;
  }
  let cursor = findHydratedNode(parentNodeId);
  const seen = new Set();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const pdf = normalizePdfExtension(cursor);
    if (pdf) return pdf.source;
    cursor = findHydratedNode(String(cursor.parent_id ?? ""));
  }
  return null;
}

/** @param {string} nodeId */
function findHydratedNode(nodeId) {
  return (lastHydration?.nodes || []).find((node) => String(node?.id ?? "") === nodeId) || null;
}

/** @param {{ asset: string }} source */
async function fetchPdfBlob(source) {
  const url = lastHydration?.asset_data?.[source.asset];
  if (!url || url === "data:,") throw new Error(`PDF asset is unavailable: ${source.asset}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`PDF asset could not be loaded: ${response.status}`);
  return response.blob();
}

/** @param {Uint8Array} bytes */
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

/** @param {Uint8Array} bytes */
function base64Bytes(bytes) {
  const chunks = [];
  for (let index = 0; index < bytes.length; index += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 8192)));
  }
  return btoa(chunks.join(""));
}

/** @param {{ type: "ready" } | { type: "uiEvent", event: Record<string, unknown> }} message */
function postToExtension(message) {
  if (!vscode) return;
  if (message.type === "ready") {
    vscode.postMessage({ type: "ready" });
    return;
  }
  if (message.type === "uiEvent" && message.event && typeof message.event.type === "string") {
    vscode.postMessage({ type: "uiEvent", event: message.event });
  }
}

function loadMermaidRuntime() {
  if (globalThis.mermaid) return Promise.resolve(globalThis.mermaid);
  if (!mermaidPromise) {
    mermaidPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("mermaid.js", document.baseURI).href;
      script.async = true;
      const nonce = document.querySelector("script[nonce]")?.nonce;
      if (nonce) script.nonce = nonce;
      script.addEventListener("load", () => globalThis.mermaid ? resolve(globalThis.mermaid) : reject(new Error("Mermaid runtime did not initialize")), { once: true });
      script.addEventListener("error", () => reject(new Error("Unable to load Mermaid")), { once: true });
      document.head.appendChild(script);
    }).catch((error) => {
      mermaidPromise = null;
      throw error;
    });
  }
  return mermaidPromise;
}

function applyNoraChromeLabels() {
  setLabel("t-rail", "Toggle branches");
  setLabel("t-new", "New Nora research");
  setLabel("t-ask", "Ask Nora");
  setLabel("t-share", "Export");
  setLabel("t-settings", "Profiles");
  setLabel("tb-done", "Close Nora document");
  const search = document.getElementById("pal-text");
  if (search) {
    search.setAttribute("placeholder", "Search this Nora document...");
    search.setAttribute("aria-label", "Search this Nora document");
  }
  const portable = document.getElementById("sm-portable");
  if (portable) portable.textContent = "Export Nora archive";
}

/** @param {string} command */
function handleCommand(command) {
  if (command === "ask") showWholeCanvasAsk(null, "command");
}

/** @param {unknown} raw */
function validateIncomingMessage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("message must be an object");
  const message = /** @type {Record<string, unknown>} */ (raw);
  if (message.type === "error" && typeof message.message === "string") return { type: "error", message: message.message };
  if (message.type === "command" && typeof message.command === "string") return { type: "command", command: message.command };
  if (message.type !== "hydrate" || !message.hydration || typeof message.hydration !== "object" || Array.isArray(message.hydration)) {
    throw new TypeError("unsupported Nora message");
  }
  return { type: "hydrate", hydration: /** @type {Record<string, unknown>} */ (message.hydration) };
}

/** @param {string} id @param {string} label */
function setLabel(id, label) {
  const element = document.getElementById(id);
  if (!element) return;
  element.setAttribute("title", label);
  element.setAttribute("aria-label", label);
}

/** @param {unknown} error */
function showBootError(error) {
  const message = error instanceof Error ? error.message : String(error);
  document.body.textContent = `Nora could not open this document: ${message}`;
}

function exposeTestApi() {
  if (!location.href.includes("__noraTest=1")) return;
  window.__noraTest = {
    hydration: () => lastHydration,
    ask: () => showWholeCanvasAsk(null, "test"),
    prepareOutgoingEvent,
    dispose: () => runtime?.dispose(),
  };
}
