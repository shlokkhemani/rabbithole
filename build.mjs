import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const require = createRequire(import.meta.url);
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const outdir = parseOutdir(process.argv.slice(2));
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
  minify: true,
  sourcemap: false,
  tsconfigRaw: {},
  legalComments: "none",
  external: ["pdfjs-dist/build/pdf.mjs"],
  logLevel: "silent"
});
await stripTrailingWhitespace(path.join(absOutdir, "client.js"));

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
await stripTrailingWhitespace(path.join(absOutdir, "frozen-client.js"));

await fs.writeFile(path.join(absOutdir, "katex.css"), await buildKatexCss(), "utf8");
await fs.writeFile(path.join(absOutdir, "dompurify.js"), await buildDompurifyScript(), "utf8");
await fs.writeFile(path.join(absOutdir, "mermaid.js"), await buildMermaidScript(), "utf8");

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

/** @param {string} filePath */
async function stripTrailingWhitespace(filePath) {
  const source = await fs.readFile(filePath, "utf8");
  await fs.writeFile(filePath, source.replace(/[ \t]+$/gm, ""), "utf8");
}

function parseOutdir(args) {
  const prefix = "--outdir=";
  const arg = args.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "dist";
}
