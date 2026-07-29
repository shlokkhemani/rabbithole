import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { CANVAS_STYLES } from "../src/core/html/styles.js";

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.resolve(rootDir, parseOutdir(process.argv.slice(2)));
const webviewDir = path.join(outdir, "webview");

const KATEX_FONT_SRC =
  /src:\s*url\((fonts\/[^)]+\.woff2)\)\s*format\("woff2"\),\s*url\((fonts\/[^)]+\.woff)\)\s*format\("woff"\),\s*url\((fonts\/[^)]+\.ttf)\)\s*format\("truetype"\);/g;

await fs.rm(outdir, { recursive: true, force: true });
await fs.mkdir(webviewDir, { recursive: true });

const extensionBuild = await esbuild.build({
  entryPoints: [path.join(rootDir, "src/extension/extension.js")],
  outfile: path.join(outdir, "extension.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  mainFields: ["module", "main"],
  external: ["vscode"],
  minify: true,
  sourcemap: false,
  legalComments: "linked",
  banner: {
    js: [
      "const __noraPathToFileURL = require(\"node:url\").pathToFileURL;",
      "const __noraCreateRequire = require(\"node:module\").createRequire;",
      "const __noraImportMetaUrl = __noraPathToFileURL(__filename).href;",
      "const __noraImportMetaRequire = __noraCreateRequire(__filename);",
      "const __noraImportMetaResolve = (specifier) => __noraPathToFileURL(__noraImportMetaRequire.resolve(specifier)).href;",
    ].join("\n"),
  },
  define: {
    "import.meta.url": "__noraImportMetaUrl",
    "import.meta.resolve": "__noraImportMetaResolve",
  },
  metafile: true,
  logLevel: "silent",
});
await fs.writeFile(path.join(outdir, "extension.metafile.json"), JSON.stringify(normalizeMetafile(extensionBuild.metafile), null, 2), "utf8");
await ensureLegalFile(path.join(outdir, "extension.cjs.LEGAL.txt"));

await esbuild.build({
  entryPoints: [path.join(rootDir, "src/ui/nora-entry.js")],
  outfile: path.join(webviewDir, "nora-entry.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "linked",
  logLevel: "silent",
});
await ensureLegalFile(path.join(webviewDir, "nora-entry.js.LEGAL.txt"));

await esbuild.build({
  entryPoints: [path.join(rootDir, "src/ui/frozen-entry.js")],
  outfile: path.join(webviewDir, "frozen-client.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "NoraFrozenClient",
  target: "es2018",
  minify: true,
  sourcemap: false,
  external: ["pdfjs-dist/build/pdf.mjs"],
  legalComments: "linked",
  logLevel: "silent",
});
await ensureLegalFile(path.join(webviewDir, "frozen-client.js.LEGAL.txt"));

await fs.writeFile(path.join(webviewDir, "canvas.css"), CANVAS_STYLES, "utf8");
await fs.writeFile(path.join(webviewDir, "katex.css"), await buildKatexCss(), "utf8");
await fs.writeFile(path.join(webviewDir, "dompurify.js"), await readPackageFile("dompurify/dist/purify.min.js"), "utf8");
await fs.writeFile(path.join(webviewDir, "mermaid.js"), await readPackageFile("@mermaid-js/tiny/dist/mermaid.tiny.js"), "utf8");
await copyPdfAssets(webviewDir);
await copyPhotonRuntime(outdir);

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

/** @param {string} specifier */
async function readPackageFile(specifier) {
  return (await fs.readFile(require.resolve(specifier), "utf8"))
    .replace(/[ \t]+$/gm, "")
    .replace(/<\/script/gi, "<\\/script");
}

async function copyPdfAssets(targetDir) {
  const packageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  await fs.copyFile(path.join(packageRoot, "build/pdf.min.mjs"), path.join(targetDir, "pdf.mjs"));
  await fs.copyFile(path.join(packageRoot, "build/pdf.worker.min.mjs"), path.join(targetDir, "pdf.worker.mjs"));
  await fs.cp(path.join(packageRoot, "standard_fonts"), path.join(targetDir, "standard_fonts"), { recursive: true });
  await copyPackedCMaps(path.join(packageRoot, "cmaps"), path.join(targetDir, "cmaps"));
}

async function copyPhotonRuntime(targetDir) {
  const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const piRoot = path.dirname(path.dirname(piEntry));
  const photonRoot = path.join(piRoot, "node_modules", "@silvia-odwyer", "photon-node");
  await fs.copyFile(path.join(photonRoot, "photon_rs_bg.wasm"), path.join(targetDir, "photon_rs_bg.wasm"));
  await fs.copyFile(path.join(photonRoot, "LICENSE.md"), path.join(targetDir, "LICENSE.photon-node.md"));
}

async function copyPackedCMaps(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".bcmap")) {
      await fs.copyFile(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
    }
  }
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

/** @param {string} filePath */
async function ensureLegalFile(filePath) {
  await fs.writeFile(
    filePath,
    await fs.readFile(filePath, "utf8").catch(() => "No bundled third-party license comments emitted by esbuild.\n"),
    "utf8",
  );
}

/** @param {string[]} args */
function parseOutdir(args) {
  const index = args.findIndex((arg) => arg === "--outdir" || arg.startsWith("--outdir="));
  if (index === -1) return "out";
  const arg = args[index];
  const value = arg.startsWith("--outdir=") ? arg.slice("--outdir=".length) : args[index + 1];
  if (!value) throw new Error("--outdir requires a directory");
  return value;
}

function normalizeMetafile(metafile) {
  const outputs = {};
  for (const [file, record] of Object.entries(metafile.outputs ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const absolute = path.resolve(rootDir, file);
    const relative = path.relative(outdir, absolute).split(path.sep).join("/");
    outputs[relative] = record;
  }
  return { ...metafile, outputs };
}
