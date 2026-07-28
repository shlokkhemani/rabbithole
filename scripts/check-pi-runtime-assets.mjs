import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(rootDir, "out");
const metafilePath = path.join(outDir, "extension.metafile.json");
const photonDir = path.join(outDir, "runtime", "photon");
const requiredRuntimeFiles = new Set([
  "runtime/photon/LICENSE.photon-node.md",
  "runtime/photon/photon_rs_bg.wasm",
]);
const forbiddenInput = /(?:@mariozechner\/clipboard|@napi-rs\/canvas|\.node$|\.so$|\.dylib$|\.dll$)/;

const metafile = JSON.parse(await fs.readFile(metafilePath, "utf8"));
const inputs = Object.keys(metafile.inputs ?? {});
const forbidden = inputs.filter((input) => forbiddenInput.test(input));
if (forbidden.length) {
  throw new Error(`Pi bundle references forbidden native runtime inputs:\n${forbidden.join("\n")}`);
}

await assertRuntimeAllowlist();

const referencesPhoton = inputs.some((input) => input.includes("@silvia-odwyer/photon-node") || input.includes("utils/photon"));
if (referencesPhoton) {
  await fs.access(path.join(photonDir, "photon_rs_bg.wasm"));
  await fs.access(path.join(photonDir, "LICENSE.photon-node.md"));
}

console.log("ok pi runtime assets: explicit Photon WASM allowlist is present and native optional packages are absent");

async function assertRuntimeAllowlist() {
  const actual = new Set();
  await collect(path.join(outDir, "runtime"), actual);
  for (const expected of requiredRuntimeFiles) {
    if (!actual.has(expected)) throw new Error(`Missing required runtime asset: ${expected}`);
  }
  const unexpected = [...actual].filter((entry) => !requiredRuntimeFiles.has(entry));
  if (unexpected.length) throw new Error(`Unexpected runtime assets:\n${unexpected.join("\n")}`);
}

/** @param {string} dir @param {Set<string>} actual */
async function collect(dir, actual) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(fullPath, actual);
    } else if (entry.isFile()) {
      actual.add(path.relative(outDir, fullPath).split(path.sep).join("/"));
    }
  }
}
