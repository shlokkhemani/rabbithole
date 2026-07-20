import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { CANVAS_STYLES } from "./src/core/html/styles.js";
import { faviconSvg } from "./src/core/html/icons.js";

const require = createRequire(import.meta.url);
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const parsed = parseOutdir(process.argv.slice(2));
const outdir = parsed.outdir;
const absOutdir = path.resolve(rootDir, outdir);
// Rabbithole's hosted link relay; RABBITHOLE_PROXY_URL overrides it, and an
// empty value ships the app with no default relay.
const PUBLIC_FETCH_PROXY_URL = "https://rabbithole-fetch-proxy.khemanishlok.workers.dev";
const proxyConfig = readProxyConfig(process.env.RABBITHOLE_PROXY_URL ?? PUBLIC_FETCH_PROXY_URL);

// This runs in the parser-blocking head, before the external stylesheet or app
// module can produce a frame. Keep it tiny: its hash is pinned in the CSP below.
const INITIAL_THEME_SCRIPT = `(function(){var theme="";try{theme=localStorage.getItem("rh-theme")||"";}catch(error){}if(theme!=="dark"&&theme!=="light"){theme=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.setAttribute("data-theme",theme);})();`;
const INITIAL_THEME_STYLE = `:root{color-scheme:dark;background:#1a1918}:root[data-theme="light"]{color-scheme:light;background:#f5f3ee}`;

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
  minify: true,
  sourcemap: false,
  tsconfigRaw: {},
  legalComments: "none",
  external: ["pdfjs-dist/build/pdf.mjs"],
  logLevel: "silent"
});

const pdfPackageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
await fs.copyFile(path.join(pdfPackageRoot, "build/pdf.worker.min.mjs"), path.join(absOutdir, "pdf.worker.mjs"));
await fs.copyFile(path.join(pdfPackageRoot, "build/pdf.min.mjs"), path.join(absOutdir, "pdf.mjs"));

await esbuild.build({
  entryPoints: [path.join(rootDir, "src/ui/frozen-entry.js")],
  outfile: path.join(absOutdir, "frozen-client.js"),
  bundle: true,
  format: "iife",
  globalName: "RabbitholeFrozenClient",
  target: "es2018",
  minify: true,
  sourcemap: false,
  tsconfigRaw: {},
  legalComments: "none",
  external: ["pdfjs-dist/build/pdf.mjs"],
  logLevel: "silent"
});

await fs.writeFile(path.join(absOutdir, "katex.css"), await buildKatexCss(), "utf8");
await fs.writeFile(path.join(absOutdir, "dompurify.js"), await buildDompurifyScript(), "utf8");
await fs.writeFile(path.join(absOutdir, "mermaid.js"), await buildMermaidScript(), "utf8");

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

async function buildMermaidScript() {
  const scriptPath = require.resolve("@mermaid-js/tiny/dist/mermaid.tiny.js");
  return (await fs.readFile(scriptPath, "utf8"))
    .replace(/[ \t]+$/gm, "")
    .replace(/<\/script/gi, "<\\/script");
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
    entryPoints: { app: path.join(rootDir, "src/web/app.js") },
    outdir: webDist,
    bundle: true,
    format: "esm",
    platform: "browser",
    splitting: true,
    target: "es2022",
    entryNames: "[name]",
    chunkNames: "chunks/[name]-[hash]",
    minify: true,
    sourcemap: false,
    // PDF.js imports `canvas` only inside its Node path. Native optional
    // dependencies are installed on some operating systems and omitted on
    // others, so resolving the package normally changes otherwise-identical
    // browser chunk names. Pin it to the browser stub for reproducible builds.
    alias: {
      canvas: path.join(rootDir, "src/web/browser-canvas-stub.js"),
    },
    define: {
      __RABBITHOLE_DEFAULT_PROXY_URL__: JSON.stringify(proxyConfig.defaultUrl),
    },
    legalComments: "none",
    logLevel: "silent"
  });

  const [katexCss, dompurify, mermaid, frozenClient, webCss, pdfWorker, pdfJs] = await Promise.all([
    fs.readFile(path.join(assetDir, "katex.css"), "utf8"),
    fs.readFile(path.join(assetDir, "dompurify.js"), "utf8"),
    fs.readFile(path.join(assetDir, "mermaid.js"), "utf8"),
    fs.readFile(path.join(assetDir, "frozen-client.js"), "utf8"),
    fs.readFile(path.join(rootDir, "src/web/styles.css"), "utf8"),
    fs.readFile(path.join(assetDir, "pdf.worker.mjs"), "utf8"),
    fs.readFile(path.join(assetDir, "pdf.mjs"), "utf8"),
  ]);
  const frozenStyles = `${CANVAS_STYLES}\n${katexCss}`;

  await fs.writeFile(path.join(webDist, "styles.css"), `${frozenStyles}\n${webCss}`, "utf8");
  await fs.writeFile(path.join(webDist, "dompurify.js"), dompurify, "utf8");
  await fs.writeFile(path.join(webDist, "mermaid.js"), mermaid, "utf8");
  await fs.writeFile(path.join(webDist, "favicon.svg"), faviconSvg(), "utf8");
  await copyPdfAssets(webDist);
  await fs.writeFile(
    path.join(webDist, "frozen-source.js"),
    `window.__RABBITHOLE_FROZEN_CLIENT__=${safeJsString(frozenClient)};\n` +
      `window.__RABBITHOLE_DOMPURIFY_SOURCE__=${safeJsString(dompurify)};\n` +
      `window.__RABBITHOLE_FROZEN_PDF_WORKER_SOURCE__=${safeJsString(pdfWorker)};\n` +
      `window.__RABBITHOLE_FROZEN_PDFJS_SOURCE__=${safeJsString(pdfJs)};\n` +
      `window.__RABBITHOLE_FROZEN_STYLES__=${safeJsString(frozenStyles)};\n`,
    "utf8"
  );
  const assetVersion = await hashWebEntryAssets(webDist);
  await fs.writeFile(path.join(webDist, "index.html"), buildWebIndexHtml(proxyConfig, assetVersion), "utf8");
}

async function hashWebEntryAssets(webDist) {
  const hash = createHash("sha256");
  for (const name of ["app.js", "styles.css", "dompurify.js", "frozen-source.js", "favicon.svg"]) {
    hash.update(name);
    hash.update("\0");
    hash.update(await fs.readFile(path.join(webDist, name)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

async function copyPdfAssets(webDist) {
  const packageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  await fs.copyFile(path.join(packageRoot, "build/pdf.min.mjs"), path.join(webDist, "pdf.mjs"));
  await fs.copyFile(path.join(packageRoot, "build/pdf.worker.min.mjs"), path.join(webDist, "pdf.worker.mjs"));
  await fs.cp(path.join(packageRoot, "standard_fonts"), path.join(webDist, "standard_fonts"), { recursive: true });
  await copyPackedCMaps(path.join(packageRoot, "cmaps"), path.join(webDist, "cmaps"));
}

async function copyPackedCMaps(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".bcmap")) continue;
    await fs.copyFile(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
  }
}

function buildWebIndexHtml({ proxyOrigin = "" } = {}, assetVersion = "") {
  if (!/^[a-f0-9]{12}$/.test(assetVersion)) throw new Error("Web asset version must be a 12-character SHA-256 prefix");
  const assetQuery = `?v=${assetVersion}`;
  const connectSrc = [
    "'self'",
    "blob:",
    "https://openrouter.ai",
    "https://api.github.com",
    "https://arxiv.org",
    "https://www.arxiv.org",
    "https://ar5iv.labs.arxiv.org",
    "https://ar5iv.org",
    "https://openreview.net",
    "https://*.workers.dev",
    "http://localhost:*",
    "http://127.0.0.1:*",
  ];
  if (proxyOrigin && !connectSrc.includes(proxyOrigin)) {
    connectSrc.push(proxyOrigin);
  }
  const initialThemeHash = createHash("sha256").update(INITIAL_THEME_SCRIPT).digest("base64");
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'sha256-${initialThemeHash}'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' blob: data: https:",
    `connect-src ${connectSrc.join(" ")}`,
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style id="initial-theme-style">${INITIAL_THEME_STYLE}</style>
<script id="initial-theme-script">${INITIAL_THEME_SCRIPT}</script>
<title>Rabbithole — an infinite canvas for learning</title>
<meta name="description" content="Rabbithole is an infinite canvas for learning. Open a document, ask from selections, and branch your understanding.">
<link rel="canonical" href="https://rabbithole.ing/">
<meta property="og:type" content="website">
<meta property="og:url" content="https://rabbithole.ing/">
<meta property="og:title" content="Rabbithole — an infinite canvas for learning">
<meta property="og:description" content="Open a document, ask from selections, and branch your understanding on an infinite canvas.">
<meta property="og:image" content="https://rabbithole.ing/og.jpg">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Rabbithole — an infinite canvas for learning">
<meta name="twitter:description" content="Open a document, ask from selections, and branch your understanding on an infinite canvas.">
<meta name="twitter:image" content="https://rabbithole.ing/og.jpg">
<link rel="icon" href="./favicon.svg${assetQuery}" type="image/svg+xml">
<link rel="stylesheet" href="./styles.css${assetQuery}">
</head>
<body>
<script src="./dompurify.js${assetQuery}"></script>
<script src="./frozen-source.js${assetQuery}"></script>
<script type="module" src="./app.js${assetQuery}"></script>
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

function readProxyConfig(raw) {
  const defaultUrl = String(raw || "").trim();
  if (!defaultUrl) return { defaultUrl: "", proxyOrigin: "" };
  let parsedUrl;
  try {
    parsedUrl = new URL(defaultUrl);
  } catch {
    throw new Error("RABBITHOLE_PROXY_URL must be an absolute http(s) URL.");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("RABBITHOLE_PROXY_URL must use http: or https:.");
  }
  return { defaultUrl, proxyOrigin: parsedUrl.origin };
}

function parseOutdir(args) {
  const prefix = "--outdir=";
  const arg = args.find((item) => item.startsWith(prefix));
  return arg ? { outdir: arg.slice(prefix.length), explicit: true } : { outdir: "dist", explicit: false };
}
