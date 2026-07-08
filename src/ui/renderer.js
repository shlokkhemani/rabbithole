import {
  MARKDOWN_RENDERER_SENTINEL,
  createMarkdownRenderer
} from "../core/markdown-renderer.js";

var assetData = null;

export { MARKDOWN_RENDERER_SENTINEL };

export function setRendererAssetData(data) {
  assetData = data && typeof data === "object" ? data : null;
}

export function browserEncodeBase64Utf8(value) {
  var source = String(value == null ? "" : value);
  if (typeof TextEncoder === "function") {
    var bytes = new TextEncoder().encode(source);
    var chunks = [];
    for (var i = 0; i < bytes.length; i += 8192) {
      var end = Math.min(i + 8192, bytes.length);
      var part = "";
      for (var j = i; j < end; j++) part += String.fromCharCode(bytes[j]);
      chunks.push(part);
    }
    return btoa(chunks.join(""));
  }
  return btoa(unescape(encodeURIComponent(source)));
}

function liveAssetUrl(name) {
  var slash = String.fromCharCode(47);
  return slash + "assets" + slash + name;
}

function resolveAssetUrl(name) {
  if (assetData) return assetData[name] || "data:,";
  return liveAssetUrl(name);
}

var markdownRenderer = createMarkdownRenderer({
  encodeBase64: browserEncodeBase64Utf8,
  resolveAssetUrl: resolveAssetUrl
});

export function renderMarkdownToHtml(markdown, options) {
  return markdownRenderer.renderMarkdownToHtml(markdown, options || {});
}

export function renderNodeMarkdown(node) {
  return renderMarkdownToHtml(node && node.md, {
    baseUrl: (node && node.base_url) || null,
    assetNames: assetData ? new Set(Object.keys(assetData)) : null
  });
}

export function refreshNodeHtml(node) {
  if (!node) return "";
  node.html = renderNodeMarkdown(node);
  node._plainFor = null;
  return node.html;
}

if (typeof window !== "undefined") {
  window.__rhMarkdownRendererSentinel = MARKDOWN_RENDERER_SENTINEL;
}
