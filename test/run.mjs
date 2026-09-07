import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(rootDir, "test");
const tiers = ["unit", "contracts", "integration", "e2e", "performance", "packaging"];
const options = parseArgs(process.argv.slice(2));
if (!["unit", "packaging"].includes(options.tier)) await ensureFullBuild();
const checks = {
  icons: [process.execPath, [path.join(rootDir, "scripts/generate-ionicons.mjs"), "--check"]],
  css: [process.execPath, [path.join(rootDir, "scripts/check-css-integrity.mjs")]],
  types: [process.execPath, [path.join(rootDir, "scripts/check-types.mjs")]],
  purity: [process.execPath, [path.join(rootDir, "scripts/check-ui-purity.mjs")]],
  design: [process.execPath, [path.join(rootDir, "scripts/check-design.mjs")]],
  "design-doc": [process.execPath, [path.join(rootDir, "scripts/generate-design-doc.mjs"), "--check"]],
  ui: [path.join(rootDir, "node_modules/.bin/biome"), ["check", "src/ui"]],
  "ui-architecture": [process.execPath, [path.join(rootDir, "scripts/check-ui-architecture.mjs")]],
  "suite-purity": [process.execPath, [path.join(rootDir, "test/harness/suite-purity.mjs")]],
};

async function ensureFullBuild() {
  try {
    await fs.access(path.join(rootDir, "web/dist/index.html"));
  } catch {
    const code = await run(process.execPath, [path.join(rootDir, "build.mjs")]);
    if (code !== 0) process.exit(code);
  }
}

let jobs = [];
if (options.tier === "all") {
  jobs.push(...Object.entries(checks).map(([name, command]) => ({ name: `check:${name}`, command })));
  for (const name of tiers) jobs.push(...await testJobs(name));
} else if (options.tier === "isolation-live") {
  jobs.push(...await testJobs(options.tier));
} else if (tiers.includes(options.tier)) {
  if (options.tier === "unit") jobs.push(
    { name: "check:icons", command: checks.icons },
    { name: "check:css", command: checks.css },
    { name: "check:design", command: checks.design },
    { name: "check:design-doc", command: checks["design-doc"] },
    { name: "check:ui", command: checks.ui },
    { name: "check:ui-architecture", command: checks["ui-architecture"] },
    { name: "check:suite-purity", command: checks["suite-purity"] },
  );
  jobs.push(...await testJobs(options.tier));
} else {
  usage(`Unknown test tier ${JSON.stringify(options.tier)}.`);
}

if (options.files.length) {
  jobs = jobs.filter((job) => !job.name.startsWith("check:") && options.files.some((pattern) => matchesFile(job.name, pattern)));
  if (!jobs.length) usage(`No tests matched --files ${JSON.stringify(options.files.join(","))}.`);
}

const { failures, started } = await runJobs(jobs, options);
const skipped = jobs.length - started;
process.stdout.write(`\n${started - failures.length} passed, ${failures.length} failed, ${skipped} skipped\n`);
if (failures.length) {
  process.stderr.write(`Failures:\n${failures.map((name) => `- ${name}`).join("\n")}\n`);
  process.exit(1);
}

async function testJobs(name) {
  const directory = path.join(testDir, name);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => testJob(path.join(directory, entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function testJob(file) {
  return {
    name: path.relative(rootDir, file),
    command: [process.execPath, ["--test", file]],
  };
}

async function runJobs(queue, { failFast, jobs: concurrency }) {
  const failures = [];
  let next = 0;
  let started = 0;
  async function worker() {
    while (next < queue.length && !(failFast && failures.length)) {
      const job = queue[next++];
      started += 1;
      process.stdout.write(`\n==> ${job.name}\n`);
      const code = await run(...job.command);
      if (code !== 0) failures.push(job.name);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
  return { failures, started };
}

async function run(command, args) {
  // A store belongs to exactly one child. Concurrent tests must never share
  // holes, host preferences, or cleanup responsibility.
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-test-store-"));
  try {
    return await new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: rootDir,
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

function parseArgs(args) {
  let tier = "all";
  let tierSeen = false;
  let failFast = false;
  let jobs = 1;
  const files = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--fail-fast") {
      failFast = true;
    } else if (arg === "--jobs" || arg.startsWith("--jobs=")) {
      const value = arg === "--jobs" ? args[++index] : arg.slice("--jobs=".length);
      jobs = Number(value);
      if (!Number.isInteger(jobs) || jobs < 1) usage("--jobs must be a positive integer.");
    } else if (arg === "--files" || arg.startsWith("--files=")) {
      const value = arg === "--files" ? args[++index] : arg.slice("--files=".length);
      if (!value) usage("--files requires a comma-separated path or quoted glob.");
      files.push(...value.split(",").map((entry) => entry.trim()).filter(Boolean));
    } else if (!arg.startsWith("-") && !tierSeen) {
      tier = arg;
      tierSeen = true;
    } else {
      usage(`Unknown argument ${JSON.stringify(arg)}.`);
    }
  }
  return { tier, failFast, jobs, files };
}

function matchesFile(name, rawPattern) {
  const pattern = rawPattern.replace(/^\.\//, "").replaceAll(path.sep, "/");
  const normalizedName = name.replaceAll(path.sep, "/");
  const candidate = pattern.includes("/") ? normalizedName : path.basename(normalizedName);
  if (!/[?*]/.test(pattern)) return candidate === pattern || normalizedName.endsWith(`/${pattern}`);
  return globRegex(pattern).test(candidate);
}

function globRegex(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$.[\]{}()+|]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function usage(message) {
  process.stderr.write(`${message}\nUsage: node test/run.mjs [tier] [--files <glob,list>] [--fail-fast] [--jobs N]\n`);
  process.exit(2);
}
