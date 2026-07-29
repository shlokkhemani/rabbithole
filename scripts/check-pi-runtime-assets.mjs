import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(rootDir, "out");
const metafilePath = path.join(outDir, "extension.metafile.json");
const requiredPhotonFiles = new Set([
  "LICENSE.photon-node.md",
  "photon_rs_bg.wasm",
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
  for (const file of requiredPhotonFiles) await fs.access(path.join(outDir, file));
}

console.log("ok pi runtime assets: explicit Photon WASM files are present and native optional packages are absent");

async function assertRuntimeAllowlist() {
  const actual = new Set();
  await collect(path.join(outDir, "runtime"), actual);
  const unexpected = [...actual];
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
