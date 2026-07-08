import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const KATEX_CSS_PATH = require.resolve("katex/dist/katex.css");
const DOMPURIFY_SCRIPT_PATH = require.resolve("dompurify/dist/purify.min.js");
const KATEX_FONT_SRC =
  /src:\s*url\((fonts\/[^)]+\.woff2)\)\s*format\("woff2"\),\s*url\((fonts\/[^)]+\.woff)\)\s*format\("woff"\),\s*url\((fonts\/[^)]+\.ttf)\)\s*format\("truetype"\);/g;

let cachedKatexCss = null;
let cachedDompurifyScript = null;

export function getKatexCss() {
  if (cachedKatexCss) return cachedKatexCss;

  const css = fs.readFileSync(KATEX_CSS_PATH, "utf8");
  const cssDir = path.dirname(KATEX_CSS_PATH);
  let fontCount = 0;
  cachedKatexCss = css.replace(KATEX_FONT_SRC, (_match, woff2Path) => {
    fontCount += 1;
    const font = fs.readFileSync(path.join(cssDir, woff2Path));
    return `src: url(data:font/woff2;base64,${font.toString("base64")}) format("woff2");`;
  });

  if (fontCount === 0) {
    throw new Error("Failed to inline KaTeX woff2 fonts");
  }

  return cachedKatexCss;
}

export function getDompurifyScript() {
  if (cachedDompurifyScript) return cachedDompurifyScript;
  cachedDompurifyScript = fs.readFileSync(DOMPURIFY_SCRIPT_PATH, "utf8").replace(/<\/script/gi, "<\\/script");
  return cachedDompurifyScript;
}
