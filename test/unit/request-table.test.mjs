/** @protects request table capability contracts. */
import assert from "node:assert/strict";
import { RequestTable } from "../../src/node/mcp/hole-session/request-table.js";

const requests = new RequestTable();
requests.ensure("taken-id");
const candidates = ["taken-id", "fresh-id"];
assert.equal(requests.mintId(() => candidates.shift() || "fallback-id"), "fresh-id", "request id minting retries table collisions");
const first = requests.pending("request-a", "node-a");
assert.equal(first, requests.get("request-a"), "one request id must always resolve to one coordination record");

requests.deliver("request-a", { status: "branch_request", request_id: "request-a" });
requests.delegate("request-a");
first.generation = { id: "run-a" };
first.watchdog = setTimeout(() => {}, 10_000);
assert.equal(first.inFlight.request_id, "request-a");
assert.equal(first.delegated, true);
assert.equal(first.nonBlocking, true);

requests.reclaim("request-a");
assert.equal(first.delegated, false);
assert.equal(first.nonBlocking, false);

requests.delegate("request-a");
const [cancelled] = requests.cancelSubtree(new Set(["node-a"]));
assert.equal(cancelled, first);
assert.equal(first.nodeId, null);
assert.equal(first.cancelledNonBlocking, true);
assert.equal(first.inFlight, null);
assert.equal(first.generation, null);

requests.clearWatchdogs();
assert.equal(first.watchdog, null);
requests.answer("request-a", "node-a");
assert.equal(first.completedNodeId, "node-a");
assert.equal(first.cancelledNonBlocking, true, "answer completion does not erase the cancellation tombstone before its caller observes it");

const conversion = requests.convert("request-b", { node_id: "pdf", markdown: "", pdf: {} });
assert.equal(conversion.conversion.node_id, "pdf");
requests.deleteConversionForNode("pdf");
assert.equal(conversion.conversion, null);

console.log("ok request table: one record owns delivery, delegation, answer, cancellation, conversion, and watchdog state");
