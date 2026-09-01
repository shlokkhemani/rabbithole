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

/**
 * Mint an eight-character lowercase hexadecimal id from four secure random
 * bytes. Browser callers use Web Crypto; Node callers on runtimes without the
 * Web Crypto global inject `node:crypto`'s randomBytes through their host
 * adapter so this core module stays isomorphic.
 * @param {(length: number) => Uint8Array} [randomBytes]
 */
export function shortId(randomBytes) {
  let bytes;
  if (randomBytes) {
    bytes = randomBytes(4);
  } else if (globalThis.crypto?.getRandomValues) {
    bytes = globalThis.crypto.getRandomValues(new Uint8Array(4));
  } else {
    throw new Error("Secure random bytes are unavailable");
  }
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) {
    throw new Error("shortId needs at least four random bytes");
  }
  return Array.from(bytes.subarray(0, 4), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Normalize a copied id before a boundary lookup. @param {unknown} value */
export function normalizeId(value) {
  return String(value ?? "")
    .trim()
    .replace(/^[\s'"`]+|[\s'"`]+$/gu, "")
    .replace(/\s+/gu, "");
}

export function randomUuidOrFallback() {
  return shortId();
}

/** @param {string} _prefix */
export function randomId(_prefix) {
  return shortId();
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
