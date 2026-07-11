import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { chromium } from "playwright";
import { createHoleState, holeStateToHole, holeStateToHydrationNodes, reduceHoleEvent } from "../../src/core/reducer.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cases = JSON.parse(await fs.readFile(path.join(ROOT, "test/fixtures/reducer-goldens/cases.json"), "utf8"));

const hydrationState = createHoleState({
  hole_id: "hydration-golden",
  title: "Hydration golden",
  root_id: "root",
  nodes: [
    { id: "root", origin: { private: "web-root" }, extra: "must-not-leak", extensions: { progress: ["雪", { score: 2 }] } },
    { id: "child", parent_id: "root", title: "Child", markdown: "Body", origin: { lens: "deeper" } },
  ],
});
const hydrationGolden = [
  { id: "root", parent_id: null, title: "", markdown: "", base_url: null, base_url_source: null, origin: { private: "web-root" }, position: { x: 0, y: 0 }, size: null, font_scale: 1, collapsed: false, status: "answered", read: false, extensions: { progress: ["雪", { score: 2 }] } },
  { id: "child", parent_id: "root", title: "Child", markdown: "Body", base_url: null, base_url_source: null, origin: { lens: "deeper" }, position: { x: 0, y: 0 }, size: null, font_scale: 1, collapsed: false, status: "answered", read: false, extensions: {} },
];
assert.deepEqual(holeStateToHydrationNodes(hydrationState), hydrationGolden, "MCP hydration uses the canonical exact-key node projection");
assert.deepEqual(
  holeStateToHydrationNodes(hydrationState, { suppressRootOrigin: true }),
  [{ ...hydrationGolden[0], origin: null }, hydrationGolden[1]],
  "web hydration preserves its intentional root-origin suppression"
);
console.log("ok stage14: canonical hydration-node projection preserves both host wire shapes");

function summarizeEffects(effects) {
  const out = { ...effects };
  if (out.createdNode) {
    out.createdNodeId = out.createdNode.id;
    delete out.createdNode;
  }
  if (out.answeredNode) {
    out.answeredNodeId = out.answeredNode.id;
    delete out.answeredNode;
  }
  return out;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  if (Object.isFrozen(value)) return value;
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      deepFreeze(key, seen);
      deepFreeze(entry, seen);
    }
    const rejectMutation = () => { throw new TypeError("Cannot mutate frozen Map"); };
    Object.defineProperties(value, {
      set: { value: rejectMutation },
      delete: { value: rejectMutation },
      clear: { value: rejectMutation },
    });
  } else {
    for (const entry of Object.values(value)) deepFreeze(entry, seen);
  }
  return Object.freeze(value);
}

function runCorpus(api, corpus) {
  return corpus.map((testCase) => {
    let state = api.createHoleState(testCase.initial);
    let effects = {};
    try {
      for (const step of testCase.events) {
        deepFreeze(state);
        deepFreeze(step.event);
        ({ state, effects } = api.reduceHoleEvent(state, step.event, step.options));
      }
      return { name: testCase.name, state: api.holeStateToHole(state), effects: summarizeEffects(effects) };
    } catch (error) {
      return { name: testCase.name, error: error.message };
    }
  });
}

function assertGoldens(results, environment) {
  assert.equal(results.length, cases.length);
  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    const actual = results[index];
    assert.equal(actual.name, testCase.name);
    if (testCase.expected_error) {
      assert.equal(actual.error, testCase.expected_error, `${environment}: ${testCase.name}`);
    } else {
      assert.deepEqual(actual.state, testCase.expected, `${environment}: ${testCase.name} state`);
      assert.deepEqual(actual.effects, testCase.expected_effects, `${environment}: ${testCase.name} effects`);
    }
  }
}

const nodeResults = runCorpus({ createHoleState, holeStateToHole, reduceHoleEvent }, cases);
assertGoldens(nodeResults, "node");

// Immutability is an engine contract: changed nodes are replaced while unchanged
// nodes may remain shared. Frozen input makes mutation fail immediately.
const priorState = createHoleState({ root_id: "root", nodes: [{ id: "root", markdown: "before" }] });
const priorNode = priorState.nodes.get("root");
deepFreeze(priorState);
const mutationResult = reduceHoleEvent(priorState, { type: "node_progress", node_id: "root", markdown: "after" });
assert.equal(priorNode.markdown, "before");
assert.equal(priorState.nodes.get("root").markdown, "before");
assert.notStrictEqual(mutationResult.state.nodes.get("root"), priorNode);
assert.equal(mutationResult.state.nodes.get("root").markdown, "after");

// The ephemeral ordering ledger obeys the same frozen-input/copy-on-write
// contract, and stale progress preserves the entire state identity.
const taggedState = createHoleState({ root_id: "root", nodes: [{ id: "root", markdown: "before" }] });
const acceptedTagged = reduceHoleEvent(taggedState, {
  type: "node_progress", node_id: "root", markdown: "newer", run: { id: "run", seq: 2 },
});
const priorRuns = acceptedTagged.state.progressRuns;
deepFreeze(acceptedTagged.state);
const staleTagged = reduceHoleEvent(acceptedTagged.state, {
  type: "node_progress", node_id: "root", markdown: "older", run: { id: "run", seq: 1 },
});
assert.notStrictEqual(priorRuns, taggedState.progressRuns);
assert.deepEqual(priorRuns.get("root"), { id: "run", seq: 2 });
assert.strictEqual(staleTagged.state, acceptedTagged.state);
assert.strictEqual(staleTagged.state.progressRuns, priorRuns);
assert.equal(Object.hasOwn(holeStateToHole(acceptedTagged.state), "progressRuns"), false);
assert.equal(JSON.stringify(holeStateToHole(acceptedTagged.state)).includes("progressRuns"), false);

const bundle = await esbuild.build({
  stdin: {
    contents: `import { createHoleState, holeStateToHole, reduceHoleEvent } from "./src/core/reducer.js";
globalThis.ReducerUnderTest = { createHoleState, holeStateToHole, reduceHoleEvent };`,
    resolveDir: ROOT,
    sourcefile: "reducer-browser-entry.js",
  },
  bundle: true,
  format: "iife",
  target: "es2018",
  write: false,
  logLevel: "silent",
});

const browser = await chromium.launch();
let browserResults;
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><meta charset=utf-8><title>Reducer conformance</title>");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  browserResults = await page.evaluate(({ corpus, runner, summarizer, freezer }) => {
    const run = (0, eval)(`(() => { const summarizeEffects = ${summarizer}; const deepFreeze = ${freezer}; return ${runner}; })()`);
    return run(globalThis.ReducerUnderTest, corpus);
  }, { corpus: cases, runner: runCorpus.toString(), summarizer: summarizeEffects.toString(), freezer: deepFreeze.toString() });
} finally {
  await browser.close();
}

assertGoldens(browserResults, "browser");
assert.deepEqual(browserResults, nodeResults, "Node and browser must produce identical reducer projections");

console.log(`ok stage14: ${cases.length} reducer goldens conform in node and browser; frozen-input immutability enforced`);
