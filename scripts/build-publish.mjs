import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDist = path.join(rootDir, "web/dist");
const publishDir = path.join(rootDir, "publish");

run(process.execPath, ["build.mjs"], { cwd: rootDir });

await assertFile(path.join(webDist, "index.html"), "web/dist/index.html");
await assertFile(path.join(webDist, "favicon.svg"), "web/dist/favicon.svg");

await fs.rm(publishDir, { recursive: true, force: true });
await fs.mkdir(publishDir, { recursive: true });
await copyContents(webDist, publishDir);
await fs.copyFile(path.join(rootDir, "website/public/og.jpg"), path.join(publishDir, "og.jpg"));
await fs.copyFile(path.join(rootDir, "website/public/robots.txt"), path.join(publishDir, "robots.txt"));
await fs.writeFile(path.join(publishDir, "_redirects"), redirectsText(), "utf8");
await fs.writeFile(path.join(publishDir, "llms.txt"), llmsText(), "utf8");

await assertFile(path.join(publishDir, "index.html"), "publish/index.html");
await assertFile(path.join(publishDir, "app.js"), "publish/app.js");
await assertFile(path.join(publishDir, "styles.css"), "publish/styles.css");
await assertFile(path.join(publishDir, "og.jpg"), "publish/og.jpg");
await assertFile(path.join(publishDir, "robots.txt"), "publish/robots.txt");
await assertFile(path.join(publishDir, "llms.txt"), "publish/llms.txt");
await assertFile(path.join(publishDir, "favicon.svg"), "publish/favicon.svg");
await assertFile(path.join(publishDir, "_redirects"), "publish/_redirects");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
  }
}

async function copyContents(sourceDir, targetDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    await fs.cp(path.join(sourceDir, entry.name), path.join(targetDir, entry.name), {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
  }
}

function redirectsText() {
  return "/* /index.html 200\n";
}

function llmsText() {
  return [
    "# Rabbithole",
    "",
    "Rabbithole is an infinite canvas for learning. Humans open the browser app at https://rabbithole.ing/ and bring their own model key.",
    "",
    "Agents install and open Rabbithole through the local MCP server:",
    "",
    "```bash",
    "claude mcp add rabbithole -- npx -y github:shlokkhemani/rabbithole",
    "```",
    "",
    "- Human path: https://rabbithole.ing/",
    "- Agent path: use the MCP command above from Claude Code or an MCP-compatible coding agent.",
    "- Source: https://github.com/shlokkhemani/rabbithole",
    "",
  ].join("\n");
}

async function assertFile(file, label) {
  try {
    const stat = await fs.stat(file);
    if (stat.isFile()) return;
  } catch {
    // fall through
  }
  throw new Error(`Expected ${label} to exist after build.`);
}
