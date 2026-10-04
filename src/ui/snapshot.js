import { extractNodeAssetRefs } from "../core/assets.js";
import { binaryToBase64 } from "../core/portable-projection.js";
import {
  buildSnapshotHtml as assembleSnapshotHtml,
  snapshotProjectionUsesMermaid,
  snapshotProjectionUsesPdf,
} from "../core/snapshot-html.js";
import { createSnapshotProjection } from "../core/snapshot-projection.js";
import { slugifyTitle } from "../core/utils.js";
import { currentNodeId, mode, view } from "./core.js";
import { flushPendingSaves } from "./transport-status.js";

function defaultSnapshotHooks() {
  return {
    fetchAssetBinary: null,
    getSnapshotHole: null,
    getFrozenClientSource: null,
    getDompurifySource: null,
    getMermaidSource: function () {
      const carrier = document.getElementById("rabbithole-mermaid-runtime");
      return carrier ? carrier.textContent || "" : "";
    },
    getPdfWorkerSource: function () {
      const carrier = document.getElementById("rabbithole-pdf-worker-runtime");
      return globalThis.__RABBITHOLE_PDF_WORKER_SOURCE__ || (carrier ? carrier.textContent || "" : "");
    },
    getPdfJsSource: function () {
      const carrier = document.getElementById("rabbithole-pdfjs-runtime");
      return globalThis.__RABBITHOLE_PDFJS_SOURCE__ || (carrier ? carrier.textContent || "" : "");
    },
    getStylesheetText: null,
  };
}

let snapshotHooks = defaultSnapshotHooks();
let preparedSources = Object.create(null);

export function setSnapshotHooks(hooks) {
  snapshotHooks = Object.assign(defaultSnapshotHooks(), hooks || {});
  preparedSources = Object.create(null);
}

export function resetSnapshotHooks() {
  snapshotHooks = defaultSnapshotHooks();
  preparedSources = Object.create(null);
}

function snapshotViewState() {
  return {
    mode: mode,
    node_id: currentNodeId,
    view: { x: view.x, y: view.y, scale: view.scale },
  };
}

function collectAssetNames(snapshotNodes) {
  const names = {};
  snapshotNodes.forEach(function (node) {
    extractNodeAssetRefs(node).forEach(function (name) {
      names[name] = true;
    });
  });
  return Object.keys(names).sort();
}

async function fetchAssetBinary(name) {
  if (typeof snapshotHooks.fetchAssetBinary === "function") {
    try {
      const hooked = await snapshotHooks.fetchAssetBinary(name);
      if (hooked) return hooked;
    } catch (e) {}
  }
  try {
    const slash = String.fromCharCode(47);
    const res = await fetch(slash + "assets" + slash + name, { cache: "no-store" });
    if (!res.ok) return new Uint8Array();
    return await res.blob();
  } catch (e) {
    return new Uint8Array();
  }
}

async function buildAssetData(snapshotNodes) {
  const names = collectAssetNames(snapshotNodes);
  const entries = new Array(names.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, names.length) }, async function () {
      while (next < names.length) {
        const index = next++,
          name = names[index];
        entries[index] = [name, await binaryToBase64(await fetchAssetBinary(name))];
      }
    }),
  );
  return Object.fromEntries(entries);
}

function extractDompurifySource() {
  if (typeof snapshotHooks.getDompurifySource === "function") {
    return snapshotHooks.getDompurifySource() || "";
  }
  const marker = "\n(function(){";
  const scripts = document.scripts || [];
  for (let i = 0; i < scripts.length; i++) {
    const script = scripts[i].textContent || "";
    const idx = script.indexOf(marker);
    if (idx !== -1) return script.slice(0, idx);
  }
  return "";
}

async function prepareSource(name, getter, fallback) {
  const value = typeof getter === "function" ? await getter() : typeof fallback === "function" ? fallback() : fallback;
  preparedSources[name] = value || "";
  return preparedSources[name];
}

function preparedSource(name, getter, fallback) {
  if (Object.prototype.hasOwnProperty.call(preparedSources, name)) return preparedSources[name];
  const value = typeof getter === "function" ? getter() : typeof fallback === "function" ? fallback() : fallback;
  // buildSnapshotHtml is deliberately synchronous. Async host adapters are
  // resolved by buildSnapshotProjection before assembly.
  return value && typeof value.then !== "function" ? value : "";
}

export async function buildSnapshotProjection() {
  const viewState = snapshotViewState();
  if (typeof snapshotHooks.getSnapshotHole !== "function") throw new Error("Snapshot document is unavailable");
  await flushPendingSaves();
  const hole = await snapshotHooks.getSnapshotHole();
  const projection = createSnapshotProjection(hole, /** @type {any} */ (viewState), await buildAssetData(hole.nodes));
  const usesMermaid = snapshotProjectionUsesMermaid(projection);
  const usesPdf = snapshotProjectionUsesPdf(projection);
  preparedSources = Object.create(null);
  await Promise.all([
    prepareSource("stylesheet", snapshotHooks.getStylesheetText, ""),
    prepareSource("dompurify", snapshotHooks.getDompurifySource, extractDompurifySource),
    prepareSource("frozenClient", snapshotHooks.getFrozenClientSource, function () {
      return window.__RABBITHOLE_FROZEN_CLIENT__ || "";
    }),
  ]);
  if (usesMermaid) {
    if (typeof snapshotHooks.getMermaidSource !== "function")
      throw new Error("Mermaid runtime is unavailable for this snapshot");
    if (!(await prepareSource("mermaid", snapshotHooks.getMermaidSource, "")))
      throw new Error("Mermaid runtime is unavailable for this snapshot");
  }
  if (usesPdf) {
    await Promise.all([
      prepareSource("pdfWorker", snapshotHooks.getPdfWorkerSource, ""),
      prepareSource("pdfJs", snapshotHooks.getPdfJsSource, ""),
    ]);
  }
  return projection;
}

export function buildSnapshotHtml(snapshotProjection) {
  const title = (snapshotProjection && snapshotProjection.hole && snapshotProjection.hole.title) || "Rabbithole";
  const usesMermaid = snapshotProjectionUsesMermaid(snapshotProjection);
  const usesPdf = snapshotProjectionUsesPdf(snapshotProjection);
  const styleText = preparedSource("stylesheet", snapshotHooks.getStylesheetText, "");
  if (!styleText) throw new Error("Frozen stylesheet is unavailable");
  const dompurifySource = preparedSource("dompurify", snapshotHooks.getDompurifySource, extractDompurifySource);
  const frozenClient = preparedSource("frozenClient", snapshotHooks.getFrozenClientSource, function () {
    return window.__RABBITHOLE_FROZEN_CLIENT__;
  });
  if (!frozenClient) throw new Error("Frozen client bundle is unavailable");
  return assembleSnapshotHtml({
    title,
    stylesheetText: styleText,
    dompurifySource,
    mermaidSource: usesMermaid ? preparedSource("mermaid", snapshotHooks.getMermaidSource, "") : "",
    pdfWorkerSource: usesPdf ? preparedSource("pdfWorker", snapshotHooks.getPdfWorkerSource, "") : "",
    pdfJsSource: usesPdf ? preparedSource("pdfJs", snapshotHooks.getPdfJsSource, "") : "",
    frozenClientSource: frozenClient,
    snapshotProjection,
  });
}

function exportFilename(title) {
  return "rabbithole-" + slugifyTitle(title, { fallback: "export" }) + ".html";
}

export async function downloadSnapshot() {
  const snapshotProjection = await buildSnapshotProjection();
  const html = buildSnapshotHtml(snapshotProjection);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFilename(snapshotProjection.hole.title);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () {
    URL.revokeObjectURL(url);
  }, 30000);
  return html;
}
