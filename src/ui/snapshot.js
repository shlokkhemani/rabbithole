import { extractNodeAssetRefs } from "../core/assets.js";
import { binaryToBase64 } from "../core/portable-projection.js";
import { createSnapshotProjection } from "../core/snapshot-projection.js";
import { buildSnapshotHtml as assembleSnapshotHtml, snapshotUsesMermaid } from "../core/snapshot-html.js";
import { slugifyTitle } from "../core/utils.js";
import {
  currentNodeId,
  mode,
  nodes,
  readerMain,
  view
} from "./core.js";
import { flushPendingSaves } from "./transport-status.js";

function defaultSnapshotHooks(){
  return {
    fetchAssetBinary: null,
    getSnapshotHole: null,
    getFrozenClientSource: null,
    getMermaidSource: null,
    getDompurifySource: null,
    getStylesheetText: null
  };
}

var snapshotHooks = defaultSnapshotHooks();

export function setSnapshotHooks(hooks) {
  snapshotHooks = Object.assign(defaultSnapshotHooks(), hooks || {});
}

export function resetSnapshotHooks() { snapshotHooks = defaultSnapshotHooks(); }

function snapshotViewState() {
  var cur = nodes[currentNodeId];
  var scroll = mode === "reader" ? readerMain.scrollTop : ((cur && cur._scrollTop) || 0);
  return {
    mode: mode,
    node_id: currentNodeId,
    scroll: scroll,
    view: { x: view.x, y: view.y, scale: view.scale }
  };
}

function collectAssetNames(snapshotNodes) {
  var names = {};
  snapshotNodes.forEach(function(node){
    extractNodeAssetRefs(node).forEach(function(name){ names[name] = true; });
  });
  return Object.keys(names).sort();
}

async function fetchAssetBinary(name) {
  if (typeof snapshotHooks.fetchAssetBinary === "function") {
    try {
      var hooked = await snapshotHooks.fetchAssetBinary(name);
      if (hooked) return hooked;
    } catch(e) {}
  }
  try {
    var slash = String.fromCharCode(47);
    var res = await fetch(slash + "assets" + slash + name, { cache: "no-store" });
    if (!res.ok) return new Uint8Array();
    return await res.blob();
  } catch(e) {
    return new Uint8Array();
  }
}

async function buildAssetData(snapshotNodes) {
  var names = collectAssetNames(snapshotNodes);
  var entries = new Array(names.length);
  var next = 0;
  await Promise.all(Array.from({ length: Math.min(4, names.length) }, async function(){
    while (next < names.length){
      var index = next++, name = names[index];
      entries[index] = [name, await binaryToBase64(await fetchAssetBinary(name))];
    }
  }));
  return Object.fromEntries(entries);
}

function extractDompurifySource() {
  if (typeof snapshotHooks.getDompurifySource === "function") {
    return snapshotHooks.getDompurifySource() || "";
  }
  var script = document.scripts && document.scripts[0] ? document.scripts[0].textContent || "" : "";
  var marker = "\n(function(){";
  var idx = script.indexOf(marker);
  return idx === -1 ? "" : script.slice(0, idx);
}

export async function buildSnapshotProjection() {
  var viewState = snapshotViewState();
  if (typeof snapshotHooks.getSnapshotHole !== "function") throw new Error("Snapshot document is unavailable");
  await flushPendingSaves();
  var hole = await snapshotHooks.getSnapshotHole();
  return createSnapshotProjection(hole, viewState, await buildAssetData(hole.nodes));
}

export async function buildSnapshotHtml(snapshotProjection) {
  var title = (snapshotProjection && snapshotProjection.hole && snapshotProjection.hole.title) || "Rabbithole";
  var styleText = typeof snapshotHooks.getStylesheetText === "function"
    ? snapshotHooks.getStylesheetText()
    : "";
  if (!styleText) throw new Error("Frozen stylesheet is unavailable");
  var dompurifySource = extractDompurifySource();
  var frozenClient = typeof snapshotHooks.getFrozenClientSource === "function"
    ? snapshotHooks.getFrozenClientSource()
    : window.__RABBITHOLE_FROZEN_CLIENT__;
  if (!frozenClient) throw new Error("Frozen client bundle is unavailable");
  var mermaidSource = "";
  if (snapshotUsesMermaid(snapshotProjection)) {
    if (typeof snapshotHooks.getMermaidSource === "function") {
      mermaidSource = await snapshotHooks.getMermaidSource() || "";
    } else {
      mermaidSource = window.__RABBITHOLE_MERMAID_SOURCE__ || "";
    }
    if (!mermaidSource) throw new Error("Mermaid runtime is unavailable for this snapshot");
  }
  return assembleSnapshotHtml({
    title,
    stylesheetText: styleText,
    dompurifySource,
    mermaidSource,
    frozenClientSource: frozenClient,
    snapshotProjection,
  });
}

function exportFilename(title) {
  return "rabbithole-" + slugifyTitle(title, { fallback: "export" }) + ".html";
}

export async function downloadSnapshot() {
  var snapshotProjection = await buildSnapshotProjection();
  var html = await buildSnapshotHtml(snapshotProjection);
  var blob = new Blob([html], { type: "text/html;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = exportFilename(snapshotProjection.hole.title);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 30000);
  return html;
}
