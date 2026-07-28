import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nora-build-check-"));

try {
  const first = path.join(tempRoot, "first");
  const second = path.join(tempRoot, "second");
  await execFileAsync(process.execPath, ["scripts/build-nora.mjs", "--outdir", first], { cwd: rootDir, maxBuffer: 20 * 1024 * 1024 });
  await execFileAsync(process.execPath, ["scripts/build-nora.mjs", "--outdir", second], { cwd: rootDir, maxBuffer: 20 * 1024 * 1024 });
  const left = await fileHashes(first);
  const right = await fileHashes(second);
  const leftJson = JSON.stringify(left, null, 2);
  const rightJson = JSON.stringify(right, null, 2);
  if (leftJson !== rightJson) throw new Error(`Nora build is not deterministic:\n${leftJson}\n---\n${rightJson}`);
  console.log(`ok build: ${left.length} deterministic Nora outputs`);
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

/** @param {string} dir */
async function fileHashes(dir) {
  const files = await filesBelow(dir);
  const out = [];
  for (const file of files) {
    const relative = path.relative(dir, file).split(path.sep).join("/");
    const hash = createHash("sha256").update(await fs.readFile(file)).digest("hex");
    out.push([relative, hash]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

/** @param {string} dir */
async function filesBelow(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}
