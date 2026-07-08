import fs from "node:fs";

const CLIENT_PATH = new URL("../../../dist/client.js", import.meta.url);
const FROZEN_CLIENT_PATH = new URL("../../../dist/frozen-client.js", import.meta.url);
const KATEX_CSS_PATH = new URL("../../../dist/katex.css", import.meta.url);
const DOMPURIFY_SCRIPT_PATH = new URL("../../../dist/dompurify.js", import.meta.url);

let cachedClientBundle = null;
let cachedFrozenClientBundle = null;
let cachedKatexCss = null;
let cachedDompurifyScript = null;

export function getClientBundle() {
  if (cachedClientBundle) return cachedClientBundle;
  cachedClientBundle = fs.readFileSync(CLIENT_PATH, "utf8");
  return cachedClientBundle;
}

export function getFrozenClientBundle() {
  if (cachedFrozenClientBundle) return cachedFrozenClientBundle;
  cachedFrozenClientBundle = fs.readFileSync(FROZEN_CLIENT_PATH, "utf8");
  return cachedFrozenClientBundle;
}

export function getKatexCss() {
  if (cachedKatexCss) return cachedKatexCss;
  cachedKatexCss = fs.readFileSync(KATEX_CSS_PATH, "utf8");
  return cachedKatexCss;
}

export function getDompurifyScript() {
  if (cachedDompurifyScript) return cachedDompurifyScript;
  cachedDompurifyScript = fs.readFileSync(DOMPURIFY_SCRIPT_PATH, "utf8");
  return cachedDompurifyScript;
}
