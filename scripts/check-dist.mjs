import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedDir = path.join(rootDir, "dist");
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-dist-"));
const actualDir = path.join(tmpRoot, "dist");

try {
  const build = spawnSync(process.execPath, ["build.mjs", `--outdir=${actualDir}`], {
    cwd: rootDir,
    encoding: "utf8"
  });
  if (build.status !== 0) {
    process.stderr.write(build.stderr || build.stdout || "build failed\n");
    process.exit(build.status || 1);
  }

  const diffs = await diffDirs(expectedDir, actualDir);
  if (diffs.length) {
    process.stderr.write(`dist/ is stale. Run npm run build and commit dist/.\n${diffs.join("\n")}\n`);
    process.exit(1);
  }
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

async function diffDirs(left, right) {
  const [leftFiles, rightFiles] = await Promise.all([listFiles(left), listFiles(right)]);
  const names = new Set([...leftFiles, ...rightFiles]);
  const diffs = [];
  for (const name of [...names].sort()) {
    const leftPath = path.join(left, name);
    const rightPath = path.join(right, name);
    if (!leftFiles.includes(name)) {
      diffs.push(`only rebuilt: ${name}`);
      continue;
    }
    if (!rightFiles.includes(name)) {
      diffs.push(`only committed: ${name}`);
      continue;
    }
    const [a, b] = await Promise.all([fs.readFile(leftPath), fs.readFile(rightPath)]);
    if (!a.equals(b)) diffs.push(`differs: ${name}`);
  }
  return diffs;
}

async function listFiles(dir) {
  const out = [];
  async function walk(base, rel) {
    const entries = await fs.readdir(path.join(base, rel), { withFileTypes: true });
    for (const entry of entries) {
      const next = path.join(rel, entry.name);
      if (entry.isDirectory()) await walk(base, next);
      else if (entry.isFile()) out.push(next);
    }
  }
  await walk(dir, "");
  return out.sort();
}
