import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VSIX = path.join(ROOT, "artifacts", "nora.vsix");
const execFile = promisify(execFileCallback);

await fs.access(VSIX);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nora-vsix-smoke-"));
try {
  const extensionsDir = path.join(tempDir, "extensions");
  const userDataDir = path.join(tempDir, "user-data");
  const workspaceDir = path.join(tempDir, "workspace");
  const runnerDir = path.join(tempDir, "runner");
  await fs.mkdir(extensionsDir, { recursive: true });
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(runnerDir, { recursive: true });

  const { writeMinimalNoraArchive } = await import("../../src/extension/nora-document.js");
  const noraFile = path.join(workspaceDir, "smoke.nora");
  await writeMinimalNoraArchive(noraFile, "VSIX Smoke", {
    now: "2026-07-28T00:00:00.000Z",
    idFactory: () => "vsix-smoke-document",
  });
  await writeRunner(runnerDir);

  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: "stable" });
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  await runCodeCli(cli, [
    ...cliArgs,
    "--extensions-dir",
    extensionsDir,
    "--user-data-dir",
    userDataDir,
    "--install-extension",
    VSIX,
    "--force",
  ]);
  const listed = await runCodeCli(cli, [
    ...cliArgs,
    "--extensions-dir",
    extensionsDir,
    "--user-data-dir",
    userDataDir,
    "--list-extensions",
  ]);
  assert.match(listed.stdout, /^r13v\.nora$/m);

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: runnerDir,
    extensionTestsPath: path.join(runnerDir, "index.cjs"),
    reuseMachineInstall: true,
    launchArgs: [
      workspaceDir,
      "--extensions-dir",
      extensionsDir,
      "--user-data-dir",
      userDataDir,
      "--skip-welcome",
    ],
    extensionTestsEnv: {
      NORA_VSIX_SMOKE: "1",
      NORA_SMOKE_DOC: noraFile,
      NORA_SOURCE_ROOT: ROOT,
    },
  });

  console.log("ok vsix smoke: installed package activates from clean VS Code and passes Pi smoke API");
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

/** @param {string} runnerDir */
async function writeRunner(runnerDir) {
  await fs.writeFile(path.join(runnerDir, "package.json"), JSON.stringify({
    name: "nora-vsix-smoke-runner",
    version: "0.0.0",
    main: "index.cjs",
    engines: { vscode: "^1.130.0" },
    activationEvents: [],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(runnerDir, "index.cjs"), `
const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

exports.run = async function run() {
  const extension = vscode.extensions.getExtension("r13v.nora");
  assert(extension, "installed Nora extension should be listed");
  assert.equal(extension.packageJSON.name, "nora");
  assert.equal(extension.packageJSON.publisher, "r13v");
  assert.notEqual(path.resolve(extension.extensionPath), path.resolve(process.env.NORA_SOURCE_ROOT), "Nora must activate from installed VSIX, not the source tree");

  const api = await extension.activate();
  assert.equal(typeof api.runVsixSmoke, "function", "NORA_VSIX_SMOKE should expose the private smoke API");
  const uri = vscode.Uri.file(process.env.NORA_SMOKE_DOC);
  await vscode.commands.executeCommand("vscode.openWith", uri, "nora.research");
  await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() === uri.toString());
  const result = await api.runVsixSmoke();
  assert.equal(result.providerId, "nora-vsix-smoke");
  assert.equal(result.agentSession, "completed");
  assert.deepEqual(result.toolCalls, [{ value: "ping" }]);
  assert.deepEqual(result.photon, { mimeType: "image/png", width: 1, height: 1, wasResized: false });
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
};

async function waitFor(predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("condition was not met before timeout");
}
`, "utf8");
}

/** @param {string} command @param {string[]} args */
async function runCodeCli(command, args) {
  try {
    return await execFile(command, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`VS Code CLI failed: ${command} ${args.join(" ")}\n${error.stdout || ""}\n${error.stderr || ""}`);
  }
}
