import { CANVAS_SHELL } from "../core/html/shell.js";

/** @param {number} length */
export function createNonce(length = 32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const values = new Uint8Array(length);
  crypto.getRandomValues(values);
  for (const value of values) out += alphabet[value % alphabet.length];
  return out;
}

/**
 * @param {{
 *   nonce: string,
 *   cspSource: string,
 *   assetBaseUri: string,
 *   scriptUri: string,
 *   canvasStyleUri: string,
 *   katexStyleUri: string,
 *   dompurifyUri: string
 * }} options
 */
export function createNoraWebviewHtml(options) {
  const nonce = escapeAttribute(options.nonce);
  const cspSource = escapeAttribute(options.cspSource);
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} blob: data:`,
    `font-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `worker-src ${cspSource} blob:`,
    `connect-src ${cspSource}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base href="${escapeAttribute(options.assetBaseUri)}">
<link rel="stylesheet" href="${escapeAttribute(options.canvasStyleUri)}">
<link rel="stylesheet" href="${escapeAttribute(options.katexStyleUri)}">
<title>Nora</title>
</head>
<body>
${CANVAS_SHELL}
<script nonce="${nonce}" src="${escapeAttribute(options.dompurifyUri)}"></script>
<script nonce="${nonce}" type="module" src="${escapeAttribute(options.scriptUri)}"></script>
</body>
</html>`;
}

/** @param {unknown} value */
function escapeAttribute(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
