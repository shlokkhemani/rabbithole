import { Buffer } from "node:buffer";
import { defaultAssetUrlResolver } from "./assets.js";
import { createMarkdownRenderer } from "./markdown-renderer.js";

export { MARKDOWN_RENDERER_SENTINEL, createMarkdownRenderer } from "./markdown-renderer.js";

export function encodeBase64Utf8(value) {
  return Buffer.from(String(value ?? ""), "utf8").toString("base64");
}

const nodeRenderer = createMarkdownRenderer({
  encodeBase64: encodeBase64Utf8,
  resolveAssetUrl: defaultAssetUrlResolver,
});

export function registerFenceRenderer(language, render) {
  nodeRenderer.registerFenceRenderer(language, render);
}

/** Renders markdown to safe HTML, collapsing inter-tag whitespace for compact embedding. */
export async function renderMarkdownToHtml(markdown, options = {}) {
  return nodeRenderer.renderMarkdownToHtml(markdown, options);
}
