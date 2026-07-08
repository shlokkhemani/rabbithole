import fs from "node:fs/promises";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = path.join(rootDir, "src/ui");
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const failures = [];

for (const file of await listJs(uiDir)) {
  const source = await fs.readFile(file, "utf8");
  for (const specifier of importSpecifiers(source)) {
    if (builtins.has(specifier)) {
      failures.push(`${rel(file)} imports Node builtin ${specifier}`);
      continue;
    }
    if (specifier.startsWith(".")) {
      const resolved = path.resolve(path.dirname(file), specifier);
      const relToUi = path.relative(uiDir, resolved);
      if (relToUi.startsWith("..") || path.isAbsolute(relToUi)) {
        failures.push(`${rel(file)} reaches outside src/ui via ${specifier}`);
      }
      continue;
    }
    failures.push(`${rel(file)} imports non-UI package ${specifier}`);
  }
}

if (failures.length) {
  process.stderr.write(`src/ui purity check failed:\n${failures.join("\n")}\n`);
  process.exit(1);
}

async function listJs(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listJs(file));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(file);
  }
  return out.sort();
}

function importSpecifiers(source) {
  const out = [];
  const re = /\bimport\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = re.exec(source))) out.push(match[1] || match[2]);
  return out;
}

function rel(file) {
  return path.relative(rootDir, file);
}
