/**
 * Shared utility functions.
 */

// U+2028 / U+2029 are valid in JSON strings but illegal in JS source — they
// break inline <script> embedding. Built from char codes to keep this file
// itself free of those characters.
const LINE_SEP = new RegExp(String.fromCharCode(0x2028), "g");
const PARA_SEP = new RegExp(String.fromCharCode(0x2029), "g");

/**
 * Escapes a value for safe embedding in HTML text/attribute context.
 * @param {unknown} str
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @param {unknown} title
 * @param {{ fallback?: string }} [options]
 */
export function slugifyTitle(title, { fallback = "" } = {}) {
  const slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}

export function randomUuidOrFallback() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** @param {string} prefix */
export function randomId(prefix) {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** @template T @param {T} value @returns {T} */
export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

/**
 * @param {Uint8Array | { arrayBuffer: () => Promise<ArrayBuffer> }} binary
 * @returns {Promise<string>}
 */
export async function binaryToBase64(binary) {
  const bytes = binary instanceof Uint8Array
    ? binary
    : new Uint8Array(await binary.arrayBuffer());
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

/**
 * Serializes a value for safe embedding inside an inline `<script>`.
 * @param {unknown} value
 */
export function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LINE_SEP, "\\u2028")
    .replace(PARA_SEP, "\\u2029");
}
