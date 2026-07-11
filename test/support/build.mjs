import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

export function ensureWebDist() {
  const build = spawnSync(process.execPath, ["build.mjs"], { cwd: ROOT, encoding: "utf8" });
  if (build.status !== 0) throw new Error(build.stderr || build.stdout || "build failed");
}
