import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { budgetDefinitions, measureBudgets } from "../support/budget-measurements.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const WEB_DIST = path.join(ROOT, "web/dist");
const recorded = JSON.parse(await fs.readFile(path.join(ROOT, "test/budgets.json"), "utf8"));
const chunkNames = await fs.readdir(path.join(WEB_DIST, "chunks")).catch((error) => {
  if (error?.code === "ENOENT") return [];
  throw error;
});
const browserRuntimeFiles = [
  path.join(WEB_DIST, "app.js"),
  path.join(WEB_DIST, "pdf.mjs"),
  ...chunkNames.filter((name) => name.endsWith(".js")).map((name) => path.join(WEB_DIST, "chunks", name)),
];
assert.equal(chunkNames.some((name) => /^pdf-/.test(name)), false,
  "the tiny PDF importer must stay in the initial app instead of creating a fragile lazy network boundary");
const pdfImplementations = [];
for (const file of browserRuntimeFiles) {
  if ((await fs.readFile(file, "utf8")).includes("PDFDocumentLoadingTask")) pdfImplementations.push(path.relative(WEB_DIST, file));
}
assert.deepEqual(pdfImplementations, ["pdf.mjs"], "the web application must ship one lazy PDF.js implementation, never a second bundled copy");
assert.equal(recorded.budgets.length, budgetDefinitions.length, "every defined gauge must have a recorded budget");
const measured = await measureBudgets({ samples: 3 });
const failures = [];
for (const budget of recorded.budgets) {
  assert.equal(typeof budget.ceiling, "number", `${budget.id} must record a numeric ceiling`);
  const actual = Math.round(measured[budget.id].value * 100) / 100;
  const status = actual <= budget.ceiling ? "ok" : "FAIL";
  console.log(`${status} performance budget: ${budget.id} ${actual} <= ${budget.ceiling} ${budget.unit}`);
  if (actual > budget.ceiling) failures.push(`${budget.id}: measured ${actual} ${budget.unit}, ceiling ${budget.ceiling} ${budget.unit}`);
}
assert.equal(failures.length, 0,
  `budget regression(s):\n- ${failures.join("\n- ")}\nRun npm run calibrate:budgets only when deliberately ratcheting ceilings; any worsening requires an explicit recorded trade-off.`);
console.log("ok performance budgets: gauges are within recorded machine-relative ceilings");
