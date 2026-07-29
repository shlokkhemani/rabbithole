import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const self = path.relative(rootDir, fileURLToPath(import.meta.url)).split(path.sep).join("/");
const scanRoots = ["src", "scripts", ".github", "package.json", ".vscodeignore", ".gitignore"];
const removedPaths = [
  "dist",
  "build.mjs",
  "scripts/check-dist.mjs",
  "docs/compatibility.md",
  "src/node",
  "src/web",
  "web",
  "website",
  "workers",
  "src/core/portable-import.js",
  "src/core/portable-projection.js",
  "src/core/store.js",
  "src/core/reducer.js",
  "src/core/hole-host.js",
  "src/core/schema.js",
  "src/core/generation-run.js",
  "src/core/contracts/artifact.d.ts",
  "src/core/contracts/store.d.ts",
  "src/core/contracts/engine.d.ts",
  "src/core/contracts/generation.d.ts",
  "src/ui/entry.js",
];

const forbidden = [
  ["legacy product token", /rabbithole/i],
  ["legacy archive extension", /\.rabbithole\b/i],
  ["legacy MCP tool", /\b(?:open_rabbithole|answer_branch|list_rabbitholes)\b/],
  ["legacy browser storage", /\bIndexedDB\b/],
  ["legacy fetch proxy", /\bfetch[- ]proxy\b/i],
  ["legacy environment variable", /\bRABBITHOLE_[A-Z0-9_]+\b/],
  ["native canvas package", new RegExp(`@napi-rs/${"canvas"}`)],
  ["optional clipboard package", new RegExp(`@mariozechner/${"clipboard"}`)],
  ["standalone deployment surface", /\b(?:deploy-pages|build:publish|wrangler|Cloudflare|website|web\/dist|publish\/)\b/i],
];

const failures = [];

for (const removedPath of removedPaths) {
  if (await exists(path.join(rootDir, removedPath))) failures.push(`removed path still exists: ${removedPath}`);
}

for (const file of await scanFiles()) {
  if (file === self) continue;
  const source = await fs.readFile(path.join(rootDir, file), "utf8");
  for (const [label, pattern] of forbidden) {
    const match = pattern.exec(source);
    if (match) failures.push(`${file}: ${label}: ${match[0]}`);
  }
}

if (failures.length) {
  process.stderr.write(`legacy surface check failed:\n${failures.join("\n")}\n`);
  process.exit(1);
}

console.log("ok legacy surfaces: no old host/runtime tokens in Nora code");

async function scanFiles() {
  const files = [];
  for (const root of scanRoots) {
    const absolute = path.join(rootDir, root);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat) continue;
    if (stat.isFile()) files.push(root);
    else if (stat.isDirectory()) files.push(...await filesBelow(absolute));
  }
  return files.sort();
}

/** @param {string} dir */
async function filesBelow(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...await filesBelow(absolute));
    } else if (entry.isFile() && /\.(?:cjs|js|json|mjs|ya?ml|gitignore|vscodeignore)$/.test(entry.name)) {
      out.push(path.relative(rootDir, absolute).split(path.sep).join("/"));
    }
  }
  return out;
}

/** @param {string} filePath */
async function exists(filePath) {
  return !!await fs.stat(filePath).catch(() => null);
}
