import fs from "node:fs";

const CLIENT_PATH = new URL("../../../dist/client.js", import.meta.url);
const FROZEN_CLIENT_PATH = new URL("../../../dist/frozen-client.js", import.meta.url);
const KATEX_CSS_PATH = new URL("../../../dist/katex.css", import.meta.url);
const DOMPURIFY_SCRIPT_PATH = new URL("../../../dist/dompurify.js", import.meta.url);
const MERMAID_SCRIPT_PATH = new URL("../../../dist/mermaid.js", import.meta.url);
const PDF_WORKER_PATH = new URL("../../../dist/pdf.worker.mjs", import.meta.url);
const PDFJS_PATH = new URL("../../../dist/pdf.mjs", import.meta.url);

function memoizeFile(path) {
  let cached = null;
  return function getFile() {
    if (cached) return cached;
    cached = fs.readFileSync(path, "utf8");
    return cached;
  };
}

export const getClientBundle = memoizeFile(CLIENT_PATH);
export const getFrozenClientBundle = memoizeFile(FROZEN_CLIENT_PATH);
export const getKatexCss = memoizeFile(KATEX_CSS_PATH);
export const getDompurifyScript = memoizeFile(DOMPURIFY_SCRIPT_PATH);
export const getMermaidScript = memoizeFile(MERMAID_SCRIPT_PATH);
export const getPdfWorkerScript = memoizeFile(PDF_WORKER_PATH);
export const getPdfJsScript = memoizeFile(PDFJS_PATH);
