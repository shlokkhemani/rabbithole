import fs from "node:fs/promises";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = path.join(rootDir, "src/ui");
const coreDir = path.join(rootDir, "src/core");
const nodeDir = path.join(rootDir, "src/node");
const removedWebDir = path.join(rootDir, "src/web");
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const failures = [];

await checkRemovedWebSource();
for (const file of await listJs(uiDir)) {
  await checkUiFile(file);
}
for (const file of await listJs(coreDir)) {
  await checkCoreFile(file);
}

if (failures.length) {
  process.stderr.write(`purity check failed:\n${failures.join("\n")}\n`);
  process.exit(1);
}

async function checkUiFile(file) {
  const source = await fs.readFile(file, "utf8");
  for (const specifier of importSpecifiers(source)) {
    if (builtins.has(specifier)) {
      failures.push(`${rel(file)} imports Node builtin ${specifier}`);
      continue;
    }
    if (specifier.startsWith(".")) {
      const resolved = resolveImport(file, specifier);
      const relToUi = path.relative(uiDir, resolved);
      const relToCore = path.relative(coreDir, resolved);
      if ((relToUi.startsWith("..") || path.isAbsolute(relToUi)) && (relToCore.startsWith("..") || path.isAbsolute(relToCore))) {
        failures.push(`${rel(file)} reaches outside src/ui or src/core via ${specifier}`);
      }
      continue;
    }
    failures.push(`${rel(file)} imports non-UI package ${specifier}`);
  }
}

async function checkCoreFile(file) {
  const source = await fs.readFile(file, "utf8");
  for (const specifier of importSpecifiers(source)) {
    if (builtins.has(specifier)) {
      failures.push(`${rel(file)} imports Node builtin ${specifier}`);
      continue;
    }
    if (!specifier.startsWith(".")) continue;
    const resolved = resolveImport(file, specifier);
    const relToCore = path.relative(coreDir, resolved);
    const relToNode = path.relative(nodeDir, resolved);
    const relToUi = path.relative(uiDir, resolved);
    if (relToNode && !relToNode.startsWith("..") && !path.isAbsolute(relToNode)) {
      failures.push(`${rel(file)} imports src/node via ${specifier}`);
    }
    if (relToUi && !relToUi.startsWith("..") && !path.isAbsolute(relToUi)) {
      failures.push(`${rel(file)} imports src/ui via ${specifier}`);
    }
    if (relToCore.startsWith("..") || path.isAbsolute(relToCore)) {
      failures.push(`${rel(file)} reaches outside src/core via ${specifier}`);
    }
  }
}

async function checkRemovedWebSource() {
  if (await pathExists(removedWebDir)) {
    failures.push("src/web must stay deleted; standalone web-app code was removed from the Nora runtime");
  }
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

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function importSpecifiers(source) {
  const out = [];
  const re = /\bimport\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = re.exec(source))) out.push(match[1] || match[2]);
  return out;
}

function resolveImport(file, specifier) {
  const resolved = path.resolve(path.dirname(file), specifier);
  return path.extname(resolved) ? resolved : `${resolved}.js`;
}

function rel(file) {
  return path.relative(rootDir, file);
}
