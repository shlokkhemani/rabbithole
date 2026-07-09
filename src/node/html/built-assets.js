import fs from "node:fs";

const CLIENT_PATH = new URL("../../../dist/client.js", import.meta.url);
const FROZEN_CLIENT_PATH = new URL("../../../dist/frozen-client.js", import.meta.url);
const KATEX_CSS_PATH = new URL("../../../dist/katex.css", import.meta.url);
const DOMPURIFY_SCRIPT_PATH = new URL("../../../dist/dompurify.js", import.meta.url);

let cachedClientBundle = null;
let cachedClientMtime = 0;
let cachedFrozenClientBundle = null;
let cachedFrozenClientMtime = 0;
let cachedKatexCss = null;
let cachedKatexMtime = 0;
let cachedDompurifyScript = null;
let cachedDompurifyMtime = 0;

export function getClientBundle() {
  const mtime = fs.statSync(CLIENT_PATH).mtimeMs;
  if (cachedClientBundle && cachedClientMtime === mtime) return cachedClientBundle;
  cachedClientBundle = fs.readFileSync(CLIENT_PATH, "utf8");
  cachedClientMtime = mtime;
  return cachedClientBundle;
}

export function getFrozenClientBundle() {
  const mtime = fs.statSync(FROZEN_CLIENT_PATH).mtimeMs;
  if (cachedFrozenClientBundle && cachedFrozenClientMtime === mtime) return cachedFrozenClientBundle;
  cachedFrozenClientBundle = fs.readFileSync(FROZEN_CLIENT_PATH, "utf8");
  cachedFrozenClientMtime = mtime;
  return cachedFrozenClientBundle;
}

export function getKatexCss() {
  const mtime = fs.statSync(KATEX_CSS_PATH).mtimeMs;
  if (cachedKatexCss && cachedKatexMtime === mtime) return cachedKatexCss;
  cachedKatexCss = fs.readFileSync(KATEX_CSS_PATH, "utf8");
  cachedKatexMtime = mtime;
  return cachedKatexCss;
}

export function getDompurifyScript() {
  const mtime = fs.statSync(DOMPURIFY_SCRIPT_PATH).mtimeMs;
  if (cachedDompurifyScript && cachedDompurifyMtime === mtime) return cachedDompurifyScript;
  cachedDompurifyScript = fs.readFileSync(DOMPURIFY_SCRIPT_PATH, "utf8");
  cachedDompurifyMtime = mtime;
  return cachedDompurifyScript;
}
