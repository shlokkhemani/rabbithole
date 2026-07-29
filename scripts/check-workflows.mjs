import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLinter } from "actionlint";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
];
const actionRefPattern = /^\s*uses:\s*([^@\s]+)@([0-9a-f]{40})(?:\s*(?:#.*)?)?$/i;
const anyUsesPattern = /^\s*uses:\s*([^@\s]+)@([^\s#]+)/i;
const localActionPattern = /^\s*uses:\s*\.\/\.github\/actions\//;

const lint = await createLinter();
const failures = [];

for (const workflowPath of workflowPaths) {
  const absolute = path.join(rootDir, workflowPath);
  const source = await fs.readFile(absolute, "utf8");
  for (const diagnostic of lint(source, workflowPath)) {
    if (isKnownActionlintGap(diagnostic)) continue;
    failures.push(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`);
  }
  assertPinnedActionRefs(workflowPath, source);
}

if (failures.length) {
  throw new Error(`Workflow check failed:\n${failures.join("\n")}`);
}

console.log("ok workflows: actionlint passed and external actions are pinned");

/** @param {string} workflowPath @param {string} source */
function assertPinnedActionRefs(workflowPath, source) {
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!anyUsesPattern.test(line) || localActionPattern.test(line)) return;
    if (!actionRefPattern.test(line)) {
      failures.push(`${workflowPath}:${index + 1}: action reference must be pinned to a full commit SHA`);
    }
  });
}

/** @param {{ file: string, line: number, column: number, message: string, kind: string }} diagnostic */
function isKnownActionlintGap(diagnostic) {
  return diagnostic.file === ".github/workflows/release.yml"
    && diagnostic.kind === "expression"
    && /^undefined variable "vars"/.test(diagnostic.message);
}
