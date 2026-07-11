/** @typedef {import("../../../src/core/contracts/generation.js").Brain} Brain */
/** @typedef {import("../../../src/core/contracts/generation.js").GenerationEvent} GenerationEvent */
/** @typedef {import("../../../src/core/contracts/generation.js").GenerationRun} GenerationRunContract */

import { GenerationRun } from "../../../src/core/generation-run.js";

/** @type {GenerationEvent[]} */
export const generationEventFixtures = [
  { type: "text", delta: "A streamed paragraph." },
  { type: "title", title: "Typed generation" },
];

/** @type {Brain} */
export const brainFixture = {
  async *answerBranch(_context, _signal) {
    yield generationEventFixtures[0];
    yield generationEventFixtures[1];
  },
  async *authorExplainer(_context, _signal) {
    yield { type: "text", delta: "An explanation." };
  },
  async *authorDocument(_source, _signal) {
    yield { type: "text", delta: "An authored document." };
    yield { type: "title", title: "Authored" };
  },
};

/** @type {GenerationRunContract} */
export const generationRunFixture = new GenerationRun({
  id: "typed-run",
  initialMarkdown: "Existing ",
  fallbackTitle: "Fallback",
});
