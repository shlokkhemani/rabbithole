import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rawTag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(rawTag)) {
  throw new Error(`Release workflow must run from a v* semver tag, got ${rawTag || "(empty)"}`);
}

const manifest = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
const expected = rawTag.slice(1);
if (manifest.version !== expected) {
  throw new Error(`Release tag ${rawTag} does not match package.json version ${manifest.version}`);
}

console.log(`ok release version: ${rawTag} matches package.json`);
