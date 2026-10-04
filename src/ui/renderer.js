import { createMarkdownRenderer, MARKDOWN_RENDERER_SENTINEL } from "../core/markdown-renderer.js";

let assetData = null;
let assetNames = null;
const utf8Encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;

export function setRendererAssetData(data) {
  assetData = data && typeof data === "object" ? data : null;
  assetNames = assetData ? new Set(Object.keys(assetData)) : null;
}

export function registerRendererAssetName(name) {
  if (assetNames) assetNames.add(name);
}

function browserEncodeBase64Utf8(value) {
  const source = String(value == null ? "" : value);
  if (utf8Encoder) {
    const bytes = utf8Encoder.encode(source);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 8192) {
      const end = Math.min(i + 8192, bytes.length);
      let part = "";
      for (let j = i; j < end; j++) part += String.fromCharCode(bytes[j]);
      chunks.push(part);
    }
    return btoa(chunks.join(""));
  }
  return btoa(unescape(encodeURIComponent(source)));
}

function liveAssetUrl(name) {
  const slash = String.fromCharCode(47);
  return slash + "assets" + slash + name;
}

export function resolveAssetUrl(name) {
  if (assetData) return assetData[name] || "data:,";
  return liveAssetUrl(name);
}

const markdownRenderer = createMarkdownRenderer({
  encodeBase64: browserEncodeBase64Utf8,
  resolveAssetUrl: resolveAssetUrl,
});

function renderMarkdownToHtml(markdown, options) {
  return markdownRenderer.renderMarkdownToHtml(markdown, options || {});
}

export function renderMarkdownForSurface(markdown, options) {
  return renderMarkdownToHtml(markdown, { ...(options || {}), assetNames: assetNames });
}

function renderNodeMarkdown(node) {
  return renderMarkdownToHtml(node && node.markdown, {
    baseUrl: (node && node.base_url) || null,
    assetNames: assetNames,
  });
}

export function refreshNodeHtml(node) {
  if (!node) return "";
  node.html = renderNodeMarkdown(node);
  node._htmlFor = node.markdown;
  node._plainFor = null;
  node._stream = null;
  return node.html;
}

export function ensureNodeHtml(node) {
  if (!node) return "";
  return node._htmlFor === node.markdown ? node.html : refreshNodeHtml(node);
}

/*
 * An answer still arriving only grows at its end, and a block a blank line
 * has closed can no longer change. Each block is rendered once, as it
 * settles (`_stream.blocks`); a frame renders only what is still open
 * (`_stream.live`), so its work follows the new text, not the whole answer.
 * Joined, the pieces are exactly the whole answer rendered at once
 * (`node.html`): the newlines a whole render would keep after a block's last
 * tag (it drops them before a tag) wait on the piece that follows.
 */
export function refreshStreamingHtml(node) {
  const markdown = String(node.markdown || "");
  const options = { baseUrl: node.base_url || null, assetNames: assetNames };
  let stream = node._stream;
  if (!stream || !markdown.startsWith(stream.source)) stream = emptyStream();
  const tail = markdown.slice(stream.source.length);
  const settled = markdownRenderer.settledMarkdownLength(tail);
  // A link definition can change text anywhere, even in settled blocks.
  if (settled < 0) stream = emptyStream();
  else if (settled > 0) {
    const html = afterSettled(stream, renderMarkdownToHtml(tail.slice(0, settled), options));
    const newlines = /\n+$/.exec(html);
    const kept = newlines && html[newlines.index - 1] === ">" ? newlines.index : html.length;
    stream.blocks.push(html.slice(0, kept));
    stream.html += html.slice(0, kept);
    stream.newlines = html.slice(kept);
    stream.source += tail.slice(0, settled);
  }
  stream.live = afterSettled(stream, renderMarkdownToHtml(markdown.slice(stream.source.length), options));
  node._stream = stream;
  node.html = stream.html + stream.live;
  node._htmlFor = node.markdown;
  node._plainFor = null;
  return node.html;
}

function emptyStream() {
  return { source: "", html: "", blocks: [], newlines: "", live: "" };
}

function afterSettled(stream, html) {
  return html.charAt(0) === "<" ? html : stream.newlines + html;
}

if (typeof window !== "undefined") {
  window.__rhMarkdownRendererSentinel = MARKDOWN_RENDERER_SENTINEL;
}
