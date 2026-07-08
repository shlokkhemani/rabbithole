import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { CANVAS_STYLES } from "./src/core/html/styles.js";

const require = createRequire(import.meta.url);
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const parsed = parseOutdir(process.argv.slice(2));
const outdir = parsed.outdir;
const absOutdir = path.resolve(rootDir, outdir);

const KATEX_FONT_SRC =
  /src:\s*url\((fonts\/[^)]+\.woff2)\)\s*format\("woff2"\),\s*url\((fonts\/[^)]+\.woff)\)\s*format\("woff"\),\s*url\((fonts\/[^)]+\.ttf)\)\s*format\("truetype"\);/g;

await fs.rm(absOutdir, { recursive: true, force: true });
await fs.mkdir(absOutdir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(rootDir, "src/ui/entry.js")],
  outfile: path.join(absOutdir, "client.js"),
  bundle: true,
  format: "iife",
  globalName: "RabbitholeClient",
  target: "es2018",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "silent"
});

await esbuild.build({
  entryPoints: [path.join(rootDir, "src/ui/frozen-entry.js")],
  outfile: path.join(absOutdir, "frozen-client.js"),
  bundle: true,
  format: "iife",
  globalName: "RabbitholeFrozenClient",
  target: "es2018",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "silent"
});

await fs.writeFile(path.join(absOutdir, "katex.css"), await buildKatexCss(), "utf8");
await fs.writeFile(path.join(absOutdir, "dompurify.js"), await buildDompurifyScript(), "utf8");

if (!parsed.explicit) {
  await buildWebApp(absOutdir);
}

async function buildKatexCss() {
  const cssPath = require.resolve("katex/dist/katex.css");
  const css = await fs.readFile(cssPath, "utf8");
  const cssDir = path.dirname(cssPath);
  let fontCount = 0;
  const inlined = await replaceAsync(css, KATEX_FONT_SRC, async (_match, woff2Path) => {
    fontCount += 1;
    const font = await fs.readFile(path.join(cssDir, woff2Path));
    return `src: url(data:font/woff2;base64,${font.toString("base64")}) format("woff2");`;
  });
  if (fontCount === 0) throw new Error("Failed to inline KaTeX woff2 fonts");
  return inlined;
}

async function buildDompurifyScript() {
  const scriptPath = require.resolve("dompurify/dist/purify.min.js");
  return (await fs.readFile(scriptPath, "utf8")).replace(/<\/script/gi, "<\\/script");
}

async function replaceAsync(source, regex, replacer) {
  const parts = [];
  let lastIndex = 0;
  for (const match of source.matchAll(regex)) {
    parts.push(source.slice(lastIndex, match.index));
    parts.push(await replacer(...match));
    lastIndex = match.index + match[0].length;
  }
  parts.push(source.slice(lastIndex));
  return parts.join("");
}

async function buildWebApp(assetDir) {
  const webDist = path.join(rootDir, "web/dist");
  await fs.rm(webDist, { recursive: true, force: true });
  await fs.mkdir(webDist, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(rootDir, "src/web/app.js")],
    outfile: path.join(webDist, "app.js"),
    bundle: true,
    format: "iife",
    globalName: "RabbitholeWebApp",
    target: "es2018",
    minify: false,
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent"
  });

  const [katexCss, dompurify, frozenClient, webCss] = await Promise.all([
    fs.readFile(path.join(assetDir, "katex.css"), "utf8"),
    fs.readFile(path.join(assetDir, "dompurify.js"), "utf8"),
    fs.readFile(path.join(assetDir, "frozen-client.js"), "utf8"),
    fs.readFile(path.join(rootDir, "src/web/styles.css"), "utf8"),
  ]);

  await fs.writeFile(path.join(webDist, "styles.css"), `${CANVAS_STYLES}\n${katexCss}\n${webCss}`, "utf8");
  await fs.writeFile(path.join(webDist, "dompurify.js"), dompurify, "utf8");
  await fs.writeFile(
    path.join(webDist, "frozen-source.js"),
    `window.__RABBITHOLE_FROZEN_CLIENT__=${safeJsString(frozenClient)};\n` +
      `window.__RABBITHOLE_DOMPURIFY_SOURCE__=${safeJsString(dompurify)};\n`,
    "utf8"
  );
  await fs.writeFile(path.join(webDist, "index.html"), buildWebIndexHtml(), "utf8");
}

function buildWebIndexHtml() {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' blob: data: https:",
    "connect-src 'self' https://openrouter.ai https://api.openai.com https://api.anthropic.com http://localhost:* http://127.0.0.1:*",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Rabbithole</title>
<link rel="stylesheet" href="./styles.css">
</head>
<body>
<script src="./dompurify.js"></script>
<script src="./frozen-source.js"></script>
<script src="./app.js"></script>
</body>
</html>`;
}

function safeJsString(value) {
  return JSON.stringify(String(value ?? ""))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function parseOutdir(args) {
  const prefix = "--outdir=";
  const arg = args.find((item) => item.startsWith(prefix));
  return arg ? { outdir: arg.slice(prefix.length), explicit: true } : { outdir: "dist", explicit: false };
}
