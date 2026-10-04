import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const designRoot = path.join(root, "src/design");
const cssFiles = await filesUnder(designRoot, (name) => name.endsWith(".css"));
const sourceFiles = await filesUnder(path.join(root, "src"), (name) => name.endsWith(".js"));
const tokenPath = path.join(designRoot, "tokens.css");
const runtimeVariables = new Set([
  "--rh-pan-x", "--rh-pan-y", "--rh-zoom", "--rail-top", "--overlay-viewport-left",
  "--overlay-viewport-top", "--overlay-viewport-width", "--overlay-viewport-height",
  "--rh-pdf-reader-center", "--node-scale", "--reader-scale", "--nc-op",
  "--surface-gap", "--trail-floor",
]);
const errors = [];
const definitions = new Set();
const uses = new Map();

for (const file of cssFiles) {
  const source = await fs.readFile(file, "utf8");
  const relative = path.relative(root, file);
  for (const match of source.matchAll(/(--[a-z][a-z0-9_-]*)\s*:/gi)) definitions.add(match[1]);
  for (const match of source.matchAll(/var\(\s*(--[a-z][a-z0-9_-]*)/gi)) uses.set(match[1], (uses.get(match[1]) || 0) + 1);
  if (file !== tokenPath) {
    reportMatches(relative, source, /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi, "color literals belong in tokens.css");
    reportDeclarations(relative, source, /z-index\s*:\s*([^;}]+)/gi, (value) => !/^(?:var\(|calc\(|auto\b)/.test(value), "z-index must use a --layer-* token");
    reportDeclarations(relative, source, /font-weight\s*:\s*([^;}]+)/gi, (value) => !/^var\(/.test(value), "font-weight must use the weight ladder");
    reportDeclarations(relative, source, /font-size\s*:\s*([^;}]+)/gi, (value) => !/^(?:var\(|calc\(|inherit\b)/.test(value), "font-size must use the type ladder");
    reportDeclarations(relative, source, /(?:transition|animation)(?:-[a-z]+)?\s*:\s*([^;}]+)/gi,
      (value) => /(?:^|[\s,(])\d*\.?\d+m?s\b/i.test(value), "motion time literals must use duration tokens");
  }
}

for (const name of uses.keys()) {
  if (!definitions.has(name) && !runtimeVariables.has(name)) errors.push(`unresolved custom property ${name}`);
}
for (const name of definitions) {
  if (!uses.has(name) && !runtimeVariables.has(name)) errors.push(`unused design token ${name}`);
}

for (const file of sourceFiles) {
  if (file.endsWith(`${path.sep}core${path.sep}html${path.sep}markup.js`)) continue;
  const source = await fs.readFile(file, "utf8");
  reportMatches(path.relative(root, file), source, /<button\b/gi, "button markup belongs in core/html/markup.js");
}

if (errors.length) {
  process.stderr.write(`design check failed (${errors.length})\n${errors.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`ok design: ${cssFiles.length} CSS sources, resolved tokens, laddered type/motion/layers, and centralized button markup\n`);

function reportDeclarations(file, source, pattern, invalid, message) {
  for (const match of source.matchAll(pattern)) if (invalid(match[1].trim())) add(file, source, match.index, message);
}

function reportMatches(file, source, pattern, message) {
  for (const match of source.matchAll(pattern)) add(file, source, match.index, message);
}

function add(file, source, index, message) {
  const line = source.slice(0, index).split("\n").length;
  errors.push(`${file}:${line}: ${message}`);
}

async function filesUnder(dir, include) {
  const output = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && include(entry.name)) output.push(target);
    }
  }
  await walk(dir);
  return output.sort();
}
