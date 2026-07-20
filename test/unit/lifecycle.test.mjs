import assert from "node:assert/strict";
import { createCleanupScope } from "../../src/ui/lifecycle.js";

const scope = createCleanupScope();
const target = new EventTarget();
const order = [];
let calls = 0;

scope.addCleanup(() => order.push("first"));
scope.listen(target, "ping", () => { calls += 1; });
scope.addCleanup(() => order.push("last"));

target.dispatchEvent(new Event("ping"));
assert.equal(calls, 1);

scope.dispose();
scope.dispose();
target.dispatchEvent(new Event("ping"));

assert.equal(calls, 1, "disposed listeners must not fire");
assert.deepEqual(order, ["last", "first"], "cleanups must run once in reverse ownership order");
assert.equal(scope.disposed, true);

let lateCleanupCalls = 0;
scope.addCleanup(() => { lateCleanupCalls += 1; });
assert.equal(lateCleanupCalls, 1, "resources registered after disposal must be released immediately");

const delayed = createCleanupScope();
let timeoutFired = false;
let intervalFired = false;
delayed.timeout(() => { timeoutFired = true; }, 5);
delayed.interval(() => { intervalFired = true; }, 5);
delayed.dispose();
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(timeoutFired, false);
assert.equal(intervalFired, false);

console.log("ok lifecycle: owned resources dispose once in reverse order");
