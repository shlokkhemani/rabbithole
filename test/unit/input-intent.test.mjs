/** @protects keyboard input ownership capability contracts. */
import assert from "node:assert/strict";

import { isTypingTarget } from "../../src/ui/input-intent.js";

const eventFor = (target) => ({ target });

assert.equal(isTypingTarget(eventFor({ tagName: "TEXTAREA" })), true);
assert.equal(isTypingTarget(eventFor({ tagName: "INPUT", type: "text" })), true);
assert.equal(isTypingTarget(eventFor({ tagName: "SELECT" })), true);
assert.equal(isTypingTarget(eventFor({ tagName: "DIV", isContentEditable: true })), true);
assert.equal(isTypingTarget(eventFor({ tagName: "INPUT", type: "button" })), false);
assert.equal(isTypingTarget(eventFor({ tagName: "BUTTON" })), false);
assert.equal(isTypingTarget(eventFor({ tagName: "DIV", isContentEditable: false })), false);

assert.equal(
  isTypingTarget({
    target: { tagName: "DIV", isContentEditable: false },
    composedPath: () => [{ tagName: "SPAN", isContentEditable: true }],
  }),
  true,
  "the original composed-path target owns typing across a shadow boundary",
);

console.log("ok input intent: typing targets keep keyboard input ownership");
