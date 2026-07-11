import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { budgetDefinitions, measureBudgets } from "../support/budget-measurements.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const recorded = JSON.parse(await fs.readFile(path.join(ROOT, "test/budgets.json"), "utf8"));
assert.equal(recorded.budgets.length, budgetDefinitions.length, "every defined gauge must have a recorded budget");
const measured = await measureBudgets({ samples: 3 });
const failures = [];
for (const budget of recorded.budgets) {
  assert.equal(typeof budget.ceiling, "number", `${budget.id} must record a numeric ceiling`);
  const actual = Math.round(measured[budget.id].value * 100) / 100;
  const status = actual <= budget.ceiling ? "ok" : "FAIL";
  console.log(`${status} stage16: ${budget.id} ${actual} <= ${budget.ceiling} ${budget.unit}`);
  if (actual > budget.ceiling) failures.push(`${budget.id}: measured ${actual} ${budget.unit}, ceiling ${budget.ceiling} ${budget.unit}`);
}
assert.equal(failures.length, 0,
  `budget regression(s):\n- ${failures.join("\n- ")}\nRun node test/calibrate-budgets.mjs only when deliberately ratcheting ceilings; any worsening requires an explicit recorded trade-off.`);
console.log("ok stage16: budget gauges are within recorded machine-relative ceilings");
