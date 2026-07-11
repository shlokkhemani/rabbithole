import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { budgetDefinitions, measureBudgets } from "./budget-measurements.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const file = path.join(ROOT, "test/budgets.json");
const previous = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{\"budgets\":[]}"));
const priorById = new Map(previous.budgets.map((budget) => [budget.id, budget]));
const measured = await measureBudgets({ samples: 3, onSample: (id, value, n, total) => {
  console.log(`calibrate ${id} sample ${n}/${total}: ${format(value)}`);
} });
const commit = process.env.BUDGET_COMMIT || gitCommit();
const budgets = budgetDefinitions.map((definition) => {
  const baseline = round(measured[definition.id].value);
  return {
    ...definition,
    baseline,
    ceiling: round(Math.max(baseline * (1 + definition.tolerance), definition.floor ?? 0)),
    measured_at_commit: commit,
  };
});
await fs.writeFile(file, `${JSON.stringify({
  note: "Machine-relative ceilings. Run node test/calibrate-budgets.mjs in each enforcement environment; commit worsening only with an explicit recorded trade-off.",
  samples: 3,
  statistic: "Exact for byte gauges; minimum of repeated samples for timing and DOM-batch gauges.",
  budgets,
}, null, 2)}\n`);
for (const budget of budgets) {
  const old = priorById.get(budget.id);
  console.log(`${old ? "changed" : "added"} ${budget.id}: baseline ${format(old?.baseline)} -> ${format(budget.baseline)}, ceiling ${format(old?.ceiling)} -> ${format(budget.ceiling)} ${budget.unit}`);
}
console.log("ok stage16: calibrated budget baselines and ratcheted ceilings");

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
function round(value) { return Math.round(value * 100) / 100; }
function format(value) { return value == null ? "unrecorded" : Number(value).toFixed(2); }
