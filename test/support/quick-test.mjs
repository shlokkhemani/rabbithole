// Impact-aware quick gate. Keep source-to-test knowledge in IMPACT_RULES only:
// overlay/camera/canvas-design changes exercise the six browser tests that
// caught the hidden-selection regression. Every run also covers the static
// checks; outside the table, directly changed contract/integration/e2e tests
// are the focused default for their touched tier.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const IMPACT_RULES = [
  {
    paths: ["src/ui/overlay/**", "src/ui/canvas/camera.js", "src/design/canvas/**"],
    tests: [
      "test/e2e/selection-popover.test.mjs",
      "test/e2e/auto-tidy.test.mjs",
      "test/e2e/web-app-mobile.test.mjs",
      "test/e2e/web-app-sharing.test.mjs",
      "test/integration/pdf-precision.test.mjs",
      "test/integration/web-ingestion.test.mjs",
    ],
  },
];

const changed = changedFiles();
const focused = new Set(changed.filter((file) => /^test\/(?:contracts|integration|e2e)\/[^/]+\.test\.mjs$/.test(file)));
for (const rule of IMPACT_RULES) {
  if (changed.some((file) => rule.paths.some((pattern) => matches(file, pattern)))) {
    for (const test of rule.tests) focused.add(test);
  }
}
const focusedTests = [...focused].sort();

process.stdout.write(`Changed paths considered: ${changed.length}\n`);
if (focusedTests.length) process.stdout.write(`Focused impact tests (${focusedTests.length}):\n${focusedTests.map((file) => `- ${file}`).join("\n")}\n`);
else process.stdout.write("Focused impact tests: none; the static checks are the default gate.\n");

await requireStep("build", process.execPath, ["build.mjs"]);
await requireStep("static checks", process.execPath, ["test/run.mjs", "checks", "--fail-fast"]);
if (focusedTests.length) {
  const jobs = positiveInteger(process.env.RABBITHOLE_TEST_JOBS || 2, "RABBITHOLE_TEST_JOBS");
  await requireStep("focused impact tests", process.execPath, [
    "test/run.mjs", "all", "--files", focusedTests.join(","), "--jobs", String(jobs),
  ]);
}
process.stdout.write("\nok quick gate\n");

function changedFiles() {
  const tracked = git(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...tracked, ...untracked].filter(Boolean))].sort();
}

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.split(/\r?\n/);
}

function matches(file, pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      index += 1;
      source += ".*";
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[\\^$.[\]{}()+|?]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`).test(file);
}

async function requireStep(name, command, args) {
  process.stdout.write(`\n==> ${name}\n`);
  const code = await run(command, args);
  if (code !== 0) process.exit(code);
}

async function run(command, args) {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-test-store-"));
  try {
    return await new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: ROOT,
        env: { ...process.env, RABBITHOLE_DIR: storeDir },
        stdio: "inherit",
      });
      child.once("error", (error) => {
        process.stderr.write(`${error.stack || error.message}\n`);
        resolve(1);
      });
      child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    });
  } finally {
    await fs.rm(storeDir, { recursive: true, force: true });
  }
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}
