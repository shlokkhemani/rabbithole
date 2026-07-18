import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { iconSvg } from "../src/core/html/icons.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDist = path.join(rootDir, "web/dist");
const aboutSourceDir = path.join(rootDir, "website/about");
const websitePublicDir = path.join(rootDir, "website/public");
const publishDir = path.join(rootDir, "publish");

run(process.execPath, ["build.mjs"], { cwd: rootDir });

await assertFile(path.join(webDist, "index.html"), "web/dist/index.html");
await assertFile(path.join(webDist, "favicon.svg"), "web/dist/favicon.svg");

await fs.rm(publishDir, { recursive: true, force: true });
await fs.mkdir(publishDir, { recursive: true });
await copyContents(webDist, publishDir);
await fs.mkdir(path.join(publishDir, "about"), { recursive: true });
await copyContents(aboutSourceDir, path.join(publishDir, "about"));
await injectAboutIcons(path.join(publishDir, "about", "index.html"));
for (const asset of ["demo-ask.mp4", "demo-ask-poster.jpg", "demo-map.mp4", "demo-map-poster.jpg"]) {
  await fs.copyFile(path.join(websitePublicDir, asset), path.join(publishDir, "about", asset));
}
await versionAboutAssets(path.join(publishDir, "about"));
await fs.copyFile(path.join(websitePublicDir, "og.jpg"), path.join(publishDir, "og.jpg"));
await fs.copyFile(path.join(websitePublicDir, "robots.txt"), path.join(publishDir, "robots.txt"));
await fs.writeFile(path.join(publishDir, "_redirects"), redirectsText(), "utf8");
await fs.writeFile(path.join(publishDir, "_headers"), headersText(), "utf8");
await fs.writeFile(path.join(publishDir, "llms.txt"), llmsText(), "utf8");
await fs.writeFile(path.join(publishDir, "sitemap.xml"), sitemapText(), "utf8");

await assertFile(path.join(publishDir, "index.html"), "publish/index.html");
await assertFile(path.join(publishDir, "app.js"), "publish/app.js");
await assertFile(path.join(publishDir, "styles.css"), "publish/styles.css");
await assertFile(path.join(publishDir, "og.jpg"), "publish/og.jpg");
await assertFile(path.join(publishDir, "robots.txt"), "publish/robots.txt");
await assertFile(path.join(publishDir, "llms.txt"), "publish/llms.txt");
await assertFile(path.join(publishDir, "favicon.svg"), "publish/favicon.svg");
await assertFile(path.join(publishDir, "_redirects"), "publish/_redirects");
await assertFile(path.join(publishDir, "_headers"), "publish/_headers");
await assertFile(path.join(publishDir, "about/index.html"), "publish/about/index.html");
await assertFile(path.join(publishDir, "about/styles.css"), "publish/about/styles.css");
await assertFile(path.join(publishDir, "about/about.js"), "publish/about/about.js");
await assertFile(path.join(publishDir, "sitemap.xml"), "publish/sitemap.xml");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
  }
}

async function copyContents(sourceDir, targetDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    await fs.cp(path.join(sourceDir, entry.name), path.join(targetDir, entry.name), {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
  }
}

async function versionAboutAssets(aboutDir) {
  const names = ["styles.css", "about.js", "demo-ask.mp4", "demo-ask-poster.jpg", "demo-map.mp4", "demo-map-poster.jpg"];
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name);
    hash.update("\0");
    hash.update(await fs.readFile(path.join(aboutDir, name)));
    hash.update("\0");
  }
  const version = hash.digest("hex").slice(0, 12);
  const htmlPath = path.join(aboutDir, "index.html");
  let html = await fs.readFile(htmlPath, "utf8");
  for (const name of names) {
    const reference = `./${name}`;
    if (!html.includes(reference)) throw new Error(`Expected about/index.html to reference ${reference}`);
    html = html.replaceAll(reference, `${reference}?v=${version}`);
  }
  await fs.writeFile(htmlPath, html, "utf8");
}

async function injectAboutIcons(htmlPath) {
  let html = await fs.readFile(htmlPath, "utf8");
  const token = "<!-- rabbithole-icon:bunny -->";
  const occurrences = html.split(token).length - 1;
  if (occurrences !== 2) throw new Error(`Expected two bunny icon slots in website/about/index.html; found ${occurrences}`);
  html = html.replaceAll(token, iconSvg("bunny"));
  await fs.writeFile(htmlPath, html, "utf8");
}

function redirectsText() {
  return [
    "/about /about/ 301",
    "/install https://github.com/shlokkhemani/rabbithole#quick-start 302",
    "/self-host https://github.com/shlokkhemani/rabbithole#run-the-browser-version-locally 302",
    "/github https://github.com/shlokkhemani/rabbithole 302",
    "/* /index.html 200",
    "",
  ].join("\n");
}

function headersText() {
  return [
    "# Mutable entry assets must revalidate on every visit. The HTML adds a",
    "# content-derived query as an additional guarantee for already-open clients.",
    "/app.js",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "",
    "/styles.css",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "",
    "/dompurify.js",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "",
    "/mermaid.js",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "",
    "/frozen-source.js",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "",
    "/pdf.worker.mjs",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "",
    "/cmaps/*",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "",
    "/standard_fonts/*",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "",
    "/favicon.svg",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "",
    "/about/*",
    "  Cache-Control: public, max-age=0, must-revalidate",
    "",
  ].join("\n");
}

function llmsText() {
  return [
    "# Rabbithole",
    "",
    "Rabbithole is an infinite canvas for learning. Humans can use the hosted browser app or connect Rabbithole to an MCP-compatible AI agent.",
    "",
    "Agents install and open Rabbithole through the local MCP server:",
    "",
    "```bash",
    "claude mcp add rabbithole -- npx -y github:shlokkhemani/rabbithole",
    "```",
    "",
    "- Human path: https://rabbithole.ing/",
    "- About and demos: https://rabbithole.ing/about/",
    "- Browser models: use OpenRouter or an OpenAI-compatible local endpoint such as Ollama.",
    "- Agent path: use the MCP command above from Claude Code or an MCP-compatible coding agent.",
    "- MCP install: https://github.com/shlokkhemani/rabbithole#quick-start",
    "- Run the browser app locally: https://github.com/shlokkhemani/rabbithole#run-the-browser-version-locally",
    "- Source: https://github.com/shlokkhemani/rabbithole",
    "",
  ].join("\n");
}

function sitemapText() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    "  <url><loc>https://rabbithole.ing/</loc></url>",
    "  <url><loc>https://rabbithole.ing/about/</loc></url>",
    "</urlset>",
    "",
  ].join("\n");
}

async function assertFile(file, label) {
  try {
    const stat = await fs.stat(file);
    if (stat.isFile()) return;
  } catch {
    // fall through
  }
  throw new Error(`Expected ${label} to exist after build.`);
}
