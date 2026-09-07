import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { minify as minifyJavaScript } from "terser";
import { faviconSvg } from "./src/core/html/icons.js";
import { mapConcurrent } from "./src/core/concurrency.js";
import { DEFAULT_FETCH_PROXY_URL } from "./policy/origins.js";
import { webContentSecurityPolicy } from "./policy/csp.js";
import { checkStylesheets, cssFilesUnder, formatCssIntegrityFailure } from "./scripts/check-css-integrity.mjs";

const require = createRequire(import.meta.url);
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const parsed = parseOutdir(process.argv.slice(2));
const outdir = parsed.outdir;
const absOutdir = path.resolve(rootDir, outdir);
// Rabbithole's hosted link relay; RABBITHOLE_PROXY_URL overrides it, and an
// empty value ships the app with no default relay.
const proxyConfig = readProxyConfig(process.env.RABBITHOLE_PROXY_URL ?? DEFAULT_FETCH_PROXY_URL);
// package.json is the single source of truth for the release version; every
// host reads it from here. Package bundles carry the version alone; only the
// continuously deployed web build is stamped with a commit.
// RABBITHOLE_COMMIT overrides the stamp for builds without a git dir.
const packageVersion = require("./package.json").version;
const buildCommit = readBuildCommit();

const CANONICAL_HOST_SCRIPT = `if(location.hostname==="www.rabbithole.ing")location.replace("https://rabbithole.ing"+location.pathname+location.search+location.hash);`;
// This runs in the parser-blocking head, before the external stylesheet or app
// module can produce a frame. Keep it tiny: its hash is pinned in the CSP below.
const INITIAL_THEME_SCRIPT = `(function(){var theme="";try{theme=localStorage.getItem("rh-theme")||"";}catch(error){}if(theme!=="dark"&&theme!=="light"){theme=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.setAttribute("data-theme",theme);})();`;
const INITIAL_THEME_STYLE = `:root{color-scheme:dark;background:#1a1918}:root[data-theme="light"]{color-scheme:light;background:#f5f3ee}`;

const KATEX_FONT_SRC =
  /src:\s*url\((fonts\/[^)]+\.woff2)\)\s*format\("woff2"\),\s*url\((fonts\/[^)]+\.woff)\)\s*format\("woff"\),\s*url\((fonts\/[^)]+\.ttf)\)\s*format\("truetype"\);/g;

await requireCssIntegrity(await cssFilesUnder(path.join(rootDir, "src/design")));

await fs.rm(absOutdir, { recursive: true, force: true });
await fs.mkdir(absOutdir, { recursive: true });

await Promise.all([
  buildUiBundle("src/ui/entry.js", "client.js", "RabbitholeClient"),
  buildUiBundle("src/ui/frozen-entry.js", "frozen-client.js", "RabbitholeFrozenClient"),
  buildCss("index.canvas.css", path.join(absOutdir, "canvas.css")),
  buildCss("index.visual.css", path.join(absOutdir, "visual-block.css")),
  buildKatexCss().then((source) => fs.writeFile(path.join(absOutdir, "katex.css"), source, "utf8")),
]);

if (!parsed.explicit) {
  await buildWebApp(absOutdir);
}

const builtCssFiles = await cssFilesUnder(absOutdir);
if (!parsed.explicit) builtCssFiles.push(...await cssFilesUnder(path.join(rootDir, "web/dist")));
await requireCssIntegrity(builtCssFiles);

async function requireCssIntegrity(files) {
  const errors = await checkStylesheets(files, { rootDir });
  if (!errors.length) return;
  process.stderr.write(formatCssIntegrityFailure(errors));
  process.exit(1);
}

async function buildUiBundle(entry, outfile, globalName) {
  const outputPath = path.join(absOutdir, outfile);
  await esbuild.build({
    entryPoints: [path.join(rootDir, entry)],
    outfile: outputPath,
    bundle: true,
    format: "iife",
    globalName,
    target: "es2018",
    minify: true,
    sourcemap: false,
    tsconfigRaw: {},
    loader: { ".css": "text" },
    define: {
      __RABBITHOLE_VERSION__: JSON.stringify(packageVersion),
      __RABBITHOLE_COMMIT__: JSON.stringify(""),
    },
    legalComments: "none",
    external: ["pdfjs-dist/build/pdf.mjs"],
    logLevel: "silent",
  });
  // esbuild owns bundling and ES2018 lowering; Terser then performs the deeper
  // compression pass that keeps live/frozen artifacts inside their
  // byte budgets without changing the browser target or runtime boundaries.
  const bundled = await fs.readFile(outputPath, "utf8");
  const compressed = await minifyJavaScript(bundled, {
    ecma: 2018,
    compress: true,
    mangle: true,
    format: { comments: false },
  });
  if (!compressed.code) throw new Error(`Terser produced no output for ${outfile}`);
  const embeddingSafe = compressed.code
    .replace(/<script/gi, "<scr\\x69pt")
    .replace(/<\/script/gi, "<\\/script");
  await fs.writeFile(outputPath, embeddingSafe, "utf8");
}

function buildCss(entry, outfile) {
  return esbuild.build({
    entryPoints: [path.join(rootDir, "src/design", entry)],
    outfile,
    bundle: true,
    minify: true,
    loader: { ".css": "css" },
    legalComments: "none",
    logLevel: "silent",
  });
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
  const matches = [...source.matchAll(regex)];
  const replacements = await Promise.all(matches.map((match) => replacer(...match)));
  const parts = [];
  let lastIndex = 0;
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    parts.push(source.slice(lastIndex, match.index));
    parts.push(replacements[index]);
    lastIndex = match.index + match[0].length;
  }
  parts.push(source.slice(lastIndex));
  return parts.join("");
}

async function buildWebApp(assetDir) {
  const webDist = path.join(rootDir, "web/dist");
  await fs.rm(webDist, { recursive: true, force: true });
  await fs.mkdir(webDist, { recursive: true });

  const appBuild = esbuild.build({
    entryPoints: { app: path.join(rootDir, "src/web/main.js") },
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
    loader: { ".css": "text" },
    define: {
      __RABBITHOLE_DEFAULT_PROXY_URL__: JSON.stringify(proxyConfig.defaultUrl),
      __RABBITHOLE_VERSION__: JSON.stringify(packageVersion),
      __RABBITHOLE_COMMIT__: JSON.stringify(buildCommit),
    },
    legalComments: "none",
    logLevel: "silent"
  });

  const sources = Promise.all([
    fs.readFile(path.join(assetDir, "katex.css"), "utf8"),
    buildDompurifyScript(),
    buildMermaidScript(),
    fs.readFile(path.join(assetDir, "frozen-client.js"), "utf8"),
    fs.readFile(path.join(assetDir, "canvas.css"), "utf8"),
  ]);
  const [, [katexCss, dompurify, mermaid, frozenClient, canvasCss]] = await Promise.all([
    Promise.all([appBuild, copyPdfAssets(webDist), buildCss("index.web.css", path.join(webDist, "styles.css"))]),
    sources,
  ]);
  const frozenStyles = `${canvasCss}\n${katexCss}`;

  await Promise.all([
    fs.writeFile(path.join(webDist, "katex.css"), katexCss, "utf8"),
    fs.writeFile(path.join(webDist, "dompurify.js"), dompurify, "utf8"),
    fs.writeFile(path.join(webDist, "mermaid.js"), mermaid, "utf8"),
    fs.writeFile(path.join(webDist, "frozen-client.js"), frozenClient, "utf8"),
    fs.writeFile(path.join(webDist, "frozen-styles.css"), frozenStyles, "utf8"),
    fs.writeFile(path.join(webDist, "favicon.svg"), faviconSvg(), "utf8"),
  ]);
  const assetVersion = await hashWebEntryAssets(webDist);
  await fs.writeFile(path.join(webDist, "index.html"), buildWebIndexHtml(proxyConfig, assetVersion), "utf8");
}

async function hashWebEntryAssets(webDist) {
  const hash = createHash("sha256");
  const names = ["app.js", "styles.css", "dompurify.js", "katex.css", "frozen-client.js", "frozen-styles.css", "pdf.mjs", "pdf.worker.mjs", "favicon.svg"];
  const contents = await Promise.all(names.map((name) => fs.readFile(path.join(webDist, name))));
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    hash.update(name);
    hash.update("\0");
    hash.update(contents[index]);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

async function copyPdfAssets(webDist) {
  const packageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  await Promise.all([
    fs.copyFile(path.join(packageRoot, "build/pdf.min.mjs"), path.join(webDist, "pdf.mjs")),
    fs.copyFile(path.join(packageRoot, "build/pdf.worker.min.mjs"), path.join(webDist, "pdf.worker.mjs")),
    fs.cp(path.join(packageRoot, "standard_fonts"), path.join(webDist, "standard_fonts"), { recursive: true }),
    copyPackedCMaps(path.join(packageRoot, "cmaps"), path.join(webDist, "cmaps")),
  ]);
}

async function copyPackedCMaps(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".bcmap"));
  await mapConcurrent(files, 32, (entry) => fs.copyFile(path.join(sourceDir, entry.name), path.join(targetDir, entry.name)));
}

function buildWebIndexHtml({ proxyOrigin = "" } = {}, assetVersion = "") {
  if (!/^[a-f0-9]{12}$/.test(assetVersion)) throw new Error("Web asset version must be a 12-character SHA-256 prefix");
  const assetQuery = `?v=${assetVersion}`;
  const csp = webContentSecurityPolicy({ proxyOrigin, canonicalHostScript: CANONICAL_HOST_SCRIPT, initialThemeScript: INITIAL_THEME_SCRIPT });
  return `<!doctype html>
<html lang="en">
<head>
<script id="canonical-host-script">${CANONICAL_HOST_SCRIPT}</script>
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
<script type="module" src="./app.js${assetQuery}"></script>
</body>
</html>`;
}

function readBuildCommit() {
  const override = String(process.env.RABBITHOLE_COMMIT || "").trim();
  if (override) return override;
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: rootDir, encoding: "utf8" });
  const sha = result.status === 0 ? String(result.stdout).trim() : "";
  return sha || "dev";
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
