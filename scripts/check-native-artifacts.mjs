import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenBinary = /\.(?:node|so|dylib|dll)$/i;
const forbiddenPackages = [`@napi-rs/${"canvas"}`, `@mariozechner/${"clipboard"}`];
const forbiddenPath = new RegExp(`(?:^|/)(?:${forbiddenPackages.map(escapeRegExp).join("[^/]*|")}[^/]*)/`);
const optionalInventoryNames = await readOptionalInventoryNames();
const failures = [];

await scanDirectory(path.join(rootDir, "out"), "out");
await scanVsix(path.join(rootDir, "artifacts", "nora.vsix"));
await scanProductionDependencies();

if (failures.length) {
  throw new Error(`Forbidden native artifacts found:\n${failures.join("\n")}`);
}
console.log("ok native: no forbidden Nora package artifacts");

/** @param {string} dir @param {string} label */
async function scanDirectory(dir, label) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(rootDir, absolute).split(path.sep).join("/");
    if (entry.isDirectory()) await scanDirectory(absolute, label);
    else if (entry.isFile() && isForbidden(relative)) failures.push(`${label}: ${relative}`);
  }
}

/** @param {string} vsixPath */
async function scanVsix(vsixPath) {
  await fs.access(vsixPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!await exists(vsixPath)) return;
  const entries = await zipEntries(vsixPath);
  for (const entry of entries) {
    if (isForbidden(entry)) failures.push(`vsix: ${entry}`);
  }
}

async function scanProductionDependencies() {
  let stdout = "{}";
  try {
    ({ stdout } = await execFileAsync("npm", ["ls", "--omit=dev", "--omit=optional", "--all", "--json"], {
      cwd: rootDir,
      maxBuffer: 50 * 1024 * 1024,
    }));
  } catch (error) {
    stdout = String(error.stdout || "{}");
  }
  const tree = JSON.parse(stdout || "{}");
  walkDependencyTree(tree, []);
}

/** @param {any} node @param {string[]} ancestry */
function walkDependencyTree(node, ancestry) {
  const name = String(node?.name || "");
  const pathName = [...ancestry, name].filter(Boolean).join("/");
  const installed = !!(node?.version || node?.resolved || node?.path);
  if (installed && (name === forbiddenPackages[0] || name.startsWith(forbiddenPackages[1]))) {
    if (!optionalInventoryNames.has(name)) failures.push(`production dependency: ${pathName || name}`);
  }
  for (const [dependencyName, dependency] of Object.entries(node?.dependencies || {})) {
    walkDependencyTree({ name: dependencyName, ...dependency }, [...ancestry, name].filter(Boolean));
  }
}

async function readOptionalInventoryNames() {
  const lockPath = path.join(rootDir, "package-lock.json");
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8").catch(() => "{}"));
  const names = new Set();
  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    if (!entry?.optional) continue;
    const name = packageNameFromLockPath(packagePath);
    if (name) names.add(name);
  }
  return names;
}

/** @param {string} packagePath */
function packageNameFromLockPath(packagePath) {
  const parts = packagePath.split("node_modules/");
  const last = parts[parts.length - 1];
  if (!last) return "";
  const segments = last.split("/");
  return last.startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0];
}

/** @param {string} value */
function isForbidden(value) {
  return forbiddenBinary.test(value) || forbiddenPath.test(value);
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @param {string} filePath */
async function exists(filePath) {
  return !!await fs.stat(filePath).catch(() => null);
}

/** @param {string} filePath */
function zipEntries(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (openError, zip) => {
      if (openError) {
        reject(openError);
        return;
      }
      const entries = [];
      zip.readEntry();
      zip.on("entry", (entry) => {
        entries.push(entry.fileName);
        zip.readEntry();
      });
      zip.on("end", () => resolve(entries));
      zip.on("error", reject);
    });
  });
}
