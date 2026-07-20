/** Supported Node-side renderer adapter for tests, evals, and external Node consumers. */
import { defaultAssetUrlResolver } from "./assets.js";
import { createMarkdownRenderer } from "./markdown-renderer.js";

export { createMarkdownRenderer } from "./markdown-renderer.js";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** @param {unknown} value */
export function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += BASE64[(n >> 18) & 63];
    out += BASE64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? BASE64[n & 63] : "=";
  }
  return out;
}

const nodeRenderer = createMarkdownRenderer({
  encodeBase64: encodeBase64Utf8,
  resolveAssetUrl: /** @type {(name: string) => string | null} */ (defaultAssetUrlResolver),
});

/** Renders markdown to safe HTML, collapsing inter-tag whitespace for compact embedding. */
/** @param {unknown} markdown @param {{ baseUrl?: string | null, assetNames?: Set<string> | null, resolveAssetUrl?: ((name: string) => string | null) | null }} [options] */
export async function renderMarkdownToHtml(markdown, options = {}) {
  return nodeRenderer.renderMarkdownToHtml(markdown, options);
}
