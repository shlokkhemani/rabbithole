import { CANVAS_SHELL } from "../core/html/shell.js";
import {
  currentNodeId,
  hydration,
  mode,
  nodes,
  readerMain,
  rootId,
  view
} from "./core.js";

const ASSET_REF_RE = /asset:([a-z0-9][a-z0-9_-]*\.(?:png|jpe?g|gif|webp|svg))/gi;

var snapshotHooks = {
  fetchAssetData: null,
  getFrozenClientSource: null,
  getDompurifySource: null
};

export function setSnapshotHooks(hooks) {
  snapshotHooks = Object.assign({}, snapshotHooks, hooks || {});
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

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

function serializeSnapshotNodes() {
  return Object.keys(nodes).map(function(id){
    var n = nodes[id];
    return {
      id: n.id,
      parent_id: n.parent_id || null,
      title: n.title || "",
      markdown: n.md || "",
      base_url: n.base_url || null,
      base_url_source: n.base_url_source || null,
      origin: n.origin || null,
      position: { x: n.x || 0, y: n.y || 0 },
      size: { w: n.w, h: n.h },
      font_scale: n.font_scale || 1,
      collapsed: !!n.collapsed,
      status: n.status || "answered",
      read: !!n.read
    };
  });
}

function collectAssetNames(snapshotNodes) {
  var names = {};
  snapshotNodes.forEach(function(node){
    var source = String(node.markdown || "");
    var match;
    ASSET_REF_RE.lastIndex = 0;
    while ((match = ASSET_REF_RE.exec(source))) names[match[1]] = true;
  });
  return Object.keys(names).sort();
}

function blobToDataUrl(blob) {
  return new Promise(function(resolve){
    var reader = new FileReader();
    reader.onload = function(){ resolve(String(reader.result || "data:,")); };
    reader.onerror = function(){ resolve("data:,"); };
    reader.readAsDataURL(blob);
  });
}

async function fetchAssetData(name) {
  if (typeof snapshotHooks.fetchAssetData === "function") {
    try {
      var hooked = await snapshotHooks.fetchAssetData(name);
      if (hooked) return hooked;
    } catch(e) {}
  }
  try {
    var slash = String.fromCharCode(47);
    var res = await fetch(slash + "assets" + slash + name, { cache: "no-store" });
    if (!res.ok) return "data:,";
    return await blobToDataUrl(await res.blob());
  } catch(e) {
    return "data:,";
  }
}

async function buildAssetData(snapshotNodes) {
  var out = {};
  var names = collectAssetNames(snapshotNodes);
  for (var i = 0; i < names.length; i++) out[names[i]] = await fetchAssetData(names[i]);
  return out;
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

export async function buildSnapshotHydration() {
  var snapshotNodes = serializeSnapshotNodes();
  return {
    session_id: hydration.session_id || null,
    hole_id: hydration.hole_id || null,
    title: hydration.title || "Rabbithole",
    root_id: rootId,
    last_event_id: 0,
    agent_attached: false,
    view_state: snapshotViewState(),
    frozen: true,
    asset_data: await buildAssetData(snapshotNodes),
    nodes: snapshotNodes
  };
}

export function buildSnapshotHtml(snapshotHydration) {
  var title = (snapshotHydration && snapshotHydration.title) || "Rabbithole";
  var styleText = document.querySelector("style")?.textContent || "";
  var dompurifySource = extractDompurifySource();
  var frozenClient = typeof snapshotHooks.getFrozenClientSource === "function"
    ? snapshotHooks.getFrozenClientSource()
    : window.__RABBITHOLE_FROZEN_CLIENT__;
  if (!frozenClient) throw new Error("Frozen client bundle is unavailable");
  var lt = String.fromCharCode(60);
  var gt = String.fromCharCode(62);
  var scriptOpen = lt + "script" + gt;
  var scriptClose = lt + String.fromCharCode(47) + "script" + gt;
  return "<!DOCTYPE html>\n" +
    '<html lang="en" data-theme="light">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<title>" + escapeHtml(title) + "</title>\n" +
    "<style>\n" + styleText + "\n</style>\n" +
    "</head>\n" +
    "<body>\n" +
    CANVAS_SHELL +
    "\n" + scriptOpen + "\n" +
    dompurifySource +
    "\n(function(){\n" +
    '  "use strict";\n' +
    "  var hydration = " + serializeForInlineScript(snapshotHydration) + ";\n" +
    frozenClient +
    "\n  RabbitholeFrozenClient.startRabbithole(hydration);\n" +
    "})();\n" +
    scriptClose + "\n" +
    "</body>\n" +
    "</html>";
}

function exportFilename(title) {
  var slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return "rabbithole-" + (slug || "export") + ".html";
}

function exportJsonFilename(title) {
  var slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return "rabbithole-" + (slug || "export") + ".json";
}

export function buildSnapshotJson(snapshotHydration) {
  return {
    format: "rabbithole-session-json",
    format_version: 1,
    exported_at: new Date().toISOString(),
    session: snapshotHydration
  };
}

export async function downloadSnapshot() {
  var snapshotHydration = await buildSnapshotHydration();
  var html = buildSnapshotHtml(snapshotHydration);
  var blob = new Blob([html], { type: "text/html;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = exportFilename(snapshotHydration.title);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 30000);
  return html;
}

export async function downloadSnapshotJson() {
  var snapshotHydration = await buildSnapshotHydration();
  var payload = buildSnapshotJson(snapshotHydration);
  var json = JSON.stringify(payload, null, 2) + "\n";
  var blob = new Blob([json], { type: "application/json;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = exportJsonFilename(snapshotHydration.title);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 30000);
  return payload;
}
