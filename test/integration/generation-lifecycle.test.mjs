import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { GenerationRun } from "../../src/core/generation-run.js";
import { createHoleState, reduceHoleEvent } from "../../src/core/reducer.js";
import { ProviderError, normalizeProviderError } from "../../src/web/brain/errors.js";
import { adaptBranchGeneration, adaptTextGeneration } from "../../src/web/brain/generation-events.js";
import { OpenAICompatibleBrain, parseOpenAISseEvent, streamOpenAICompatible } from "../../src/web/brain/openai-compatible.js";
import { TitleSentinelParser } from "../../src/web/brain/title-sentinel.js";
import { GenerationIngress } from "../../src/node/transport/generation-ingress.js";
import { RabbitHoleSession } from "../../src/node/transport/session.js";
import { DirectRabbitholeHost, createHoleFromMarkdown, generationDocEvents } from "../../src/web/transport/direct-host.js";

async function collect(iterable) {
  const out = [];
  for await (const value of iterable) out.push(value);
  return out;
}

function chunksOf(source, cuts) {
  const encoder = new TextEncoder();
  const parts = [];
  let start = 0;
  for (const end of cuts) {
    parts.push(encoder.encode(source.slice(start, end)));
    start = end;
  }
  parts.push(encoder.encode(source.slice(start)));
  return parts;
}

function responseFromChunks(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200 });
}

const openAiWire = [
  'data: {"choices":[{"delta":{"content":"alpha"}}]}',
  'data: {"choices":[{"delta":{"content":" beta"}}]}',
  "data: [DONE]",
].join("\r\n\r\n") + "\r\n\r\n";
const originalFetch = globalThis.fetch;
try {
  for (let offset = 0; offset <= openAiWire.length; offset += 1) {
    globalThis.fetch = async () => responseFromChunks(chunksOf(openAiWire, [offset]));
    assert.deepEqual(await collect(streamOpenAICompatible({ url: "https://example.test/chat/completions", body: {} })), ["alpha", " beta"]);
  }
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(parseOpenAISseEvent('data: {"choices":[{"message":{"content":"one"}}]}\ndata: {"choices":[{"delta":{"content":" two"}}]}'), "one two");
assert.equal(parseOpenAISseEvent("data: [DONE]"), "");
console.log("ok generation lifecycle: OpenAI SSE arbitrary fragmentation, multi-event chunks, CRLF, and DONE");

function parseTitle(chunks, fallbackTitle = "Fallback") {
  const parser = new TitleSentinelParser({ fallbackTitle });
  let text = "";
  for (const chunk of chunks) text += parser.push(chunk);
  text += parser.finish();
  return { title: parser.title, text };
}
const sentinelStream = "TITLE: Fragmented title\n\n# Body\nExact bytes.";
for (let offset = 0; offset <= sentinelStream.length; offset += 1) {
  assert.deepEqual(parseTitle([sentinelStream.slice(0, offset), sentinelStream.slice(offset)]), {
    title: "Fragmented title", text: "# Body\nExact bytes.",
  }, `title sentinel split offset ${offset}`);
}
assert.deepEqual(parseTitle(["TITLE: Start\nbody"]), { title: "Start", text: "body" });
assert.deepEqual(parseTitle(["TITLE: End"]), { title: "End", text: "" });
assert.deepEqual(parseTitle(["plain body"]), { title: "Fallback", text: "plain body\n" });
assert.deepEqual(parseTitle(["TITLE:"]), { title: "Fallback", text: "TITLE:\n" });
assert.deepEqual(parseTitle(["TITLE: partial"]), { title: "partial", text: "" });
console.log("ok generation lifecycle: title sentinel full fragmentation sweep and terminal edge cases");

const existing = new ProviderError("rate", { status: 429, code: "rate_limit" });
assert.strictEqual(normalizeProviderError(existing), existing);
const aborted = normalizeProviderError({ name: "AbortError" });
assert.equal(aborted.name, "ProviderError");
assert.equal(aborted.status, null);
assert.equal(aborted.code, "abort");
assert.equal(aborted.retryable, true);
const network = normalizeProviderError(new TypeError("socket closed"));
assert.equal(network.message, "socket closed");
assert.equal(network.code, "network");
assert.equal(network.retryable, true);
console.log("ok generation lifecycle: provider error normalization shapes");

async function* fixtureChunks(parts) { yield* parts; }
const rawBranch = "TITLE: Adapter title\n\nParagraph one.\nParagraph two.";
const branchEvents = await collect(adaptBranchGeneration(fixtureChunks(["TITLE: Ad", "apter title\n\nPara", "graph one.\nParagraph two."])));
assert.deepEqual(branchEvents.filter((event) => event.type === "title"), [{ type: "title", title: "Adapter title" }]);
assert.equal(branchEvents.filter((event) => event.type === "text").map((event) => event.delta).join(""), rawBranch.slice(rawBranch.indexOf("\n\n") + 2));
const rawAuthor = "# Heading\r\n\r\nByte-exact body ☃";
for (const events of [
  await collect(adaptTextGeneration(fixtureChunks(["# Head", "ing\r\n", "\r\nByte-exact body ☃"]))),
  await collect(adaptTextGeneration(fixtureChunks([rawAuthor]))),
]) {
  assert.equal(events.some((event) => event.type === "title"), false);
  assert.equal(events.map((event) => event.delta).join(""), rawAuthor);
}
console.log("ok generation lifecycle: pure branch and author adapters preserve exact text bytes");

const openAiBrain = new OpenAICompatibleBrain({ baseUrl: "https://example.test", model: "fixture" });
try {
  globalThis.fetch = async (_url, options) => {
    const messages = JSON.parse(options.body).messages;
    const isBranch = messages[0].content.includes("TITLE: <short node title>");
    const text = isBranch ? "TITLE: Brain title\nBody" : rawAuthor;
    const wire = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
    return responseFromChunks(chunksOf(wire, [1, 7, 19]));
  };
  const branch = await collect(openAiBrain.answerBranch({ fallbackTitle: "Fallback" }, new AbortController().signal));
  assert.deepEqual(branch, [{ type: "title", title: "Brain title" }, { type: "text", delta: "Body" }]);
  for (const events of [
    await collect(openAiBrain.authorExplainer({ question: "why" }, new AbortController().signal)),
    await collect(openAiBrain.authorDocument({ markdown: "source" }, new AbortController().signal)),
  ]) {
    assert.equal(events.some((event) => event.type === "title"), false);
    assert.equal(events.map((event) => event.delta).join(""), rawAuthor);
  }
} finally {
  globalThis.fetch = originalFetch;
}

const run = new GenerationRun({ id: "run-a", initialMarkdown: "Start ", fallbackTitle: "Fallback" });
assert.deepEqual(run.accept({ type: "text", delta: "one" }, { nodeId: "node-a" }), {
  type: "node_progress", node_id: "node-a", markdown: "Start one", run: { id: "run-a", seq: 1 },
});
assert.deepEqual(run.accept({ type: "text", delta: " two" }, {
  nodeId: "node-a", progressFields: { base_url: "https://example.test" },
}), {
  type: "node_progress", base_url: "https://example.test", node_id: "node-a",
  markdown: "Start one two", run: { id: "run-a", seq: 2 },
});
assert.equal(run.accept({ type: "title", title: "Late title" }), null);
const finalContext = { nodeId: "node-a", answeredFields: { parent_id: "root", read: false } };
const finalEvent = {
  type: "node_answered", parent_id: "root", read: false, node_id: "node-a",
  title: "Late title", markdown: "Start one two",
};
assert.deepEqual(run.complete(finalContext), finalEvent);
assert.deepEqual(run.complete(finalContext), finalEvent);
assert.deepEqual(run.snapshot(), { id: "run-a", seq: 2, markdown: "Start one two", title: "Late title" });

const empty = new GenerationRun({ id: "empty", fallbackTitle: "Empty fallback" });
assert.deepEqual(empty.complete({ nodeId: "empty-node" }), {
  type: "node_answered", node_id: "empty-node", title: "Empty fallback", markdown: "",
});
assert.throws(() => empty.accept({ type: "usage", input_tokens: 1, output_tokens: 2 }), /Unsupported GenerationEvent/);
assert.throws(() => empty.accept({ type: "text", delta: "no node" }), /requires a non-empty nodeId/);
assert.equal(JSON.stringify(run.complete(finalContext)).includes("node_error"), false);
console.log("ok generation lifecycle: GenerationRun accumulation, ordering, late title, empty completion, idempotence, and rejection goldens");

const wiringEvents = [{ type: "title", title: "Wired title" }, { type: "text", delta: "one" }, { type: "text", delta: " two" }];
const wiredRun = new GenerationRun({ id: "wired-run", initialMarkdown: "Start ", fallbackTitle: "Fallback" });
const wired = await collect(generationDocEvents(fixtureChunks(wiringEvents), wiredRun, {
  nodeId: "wired-node",
  progressFields: { base_url: "https://example.test" },
  answeredFields: { parent_id: "root", read: false },
}));
const manualRun = new GenerationRun({ id: "wired-run", initialMarkdown: "Start ", fallbackTitle: "Fallback" });
const manual = wiringEvents.flatMap((event) => {
  const progress = manualRun.accept(event, { nodeId: "wired-node", progressFields: { base_url: "https://example.test" } });
  return progress ? [progress] : [];
});
manual.push(manualRun.complete({ nodeId: "wired-node", answeredFields: { parent_id: "root", read: false } }));
assert.deepEqual(wired, manual);
console.log("ok generation lifecycle: browser branch wiring matches hand-driven GenerationRun DocEvents");

const mcpIngress = new GenerationIngress({ id: "mcp-run", nodeId: "mcp-node", fallbackTitle: "Fallback" });
assert.deepEqual(mcpIngress.acceptChunk("one"), {
  type: "node_progress", node_id: "mcp-node", markdown: "one", run: { id: "mcp-run", seq: 1 },
});
assert.deepEqual(mcpIngress.acceptChunk(" two"), {
  type: "node_progress", node_id: "mcp-node", markdown: "one two", run: { id: "mcp-run", seq: 2 },
});
assert.deepEqual(mcpIngress.acceptChunk("one two three", { final: true, title: "Agent title" }), {
  type: "node_answered", node_id: "mcp-node", title: "Agent title", markdown: "one two three",
});
const tailIngress = new GenerationIngress({ id: "tail-run", nodeId: "tail-node" });
tailIngress.acceptChunk("one");
assert.equal(tailIngress.acceptChunk(" two", { final: true, title: "Tail" }).markdown, "one two");
let mcpMinted = 0;
const mcpSession = new RabbitHoleSession({
  nodes: [],
  mintGenerationRunId: () => `fresh-${++mcpMinted}`,
});
assert.notEqual(
  mcpSession.createGenerationIngress({ id: "node", title: "Fallback" }).run.id,
  mcpSession.createGenerationIngress({ id: "node", title: "Fallback" }).run.id,
);
console.log("ok generation lifecycle: MCP ingress normalizes tail/repeat chunks, tags progress, carries title, and isolates fresh runs");

let minted = 0;
const mintHost = new DirectRabbitholeHost({
  store: { saveHole: async () => {} },
  hole: { hole_id: "hole", root_id: "root", nodes: [{ id: "root", status: "answered", markdown: "" }] },
  mintGenerationRunId: () => `attempt-${++minted}`,
});
const lifecycleHost = new DirectRabbitholeHost({
  store: { saveHole: async () => {} },
  hole: { hole_id: "lifecycle-hole", root_id: "root", nodes: [{ id: "root", status: "answered", markdown: "" }] },
});
let subscriptionOpened = 0;
const deliveredEvents = [];
const subscription = lifecycleHost.adapter().connect({
  onOpen: () => { subscriptionOpened += 1; },
  onMessage: (event) => deliveredEvents.push(event),
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(subscriptionOpened, 1);
lifecycleHost.emit({ type: "first" });
assert.deepEqual(deliveredEvents, [{ type: "first" }]);
subscription.close();
subscription.close();
lifecycleHost.emit({ type: "late" });
assert.deepEqual(deliveredEvents, [{ type: "first" }], "closed browser subscriptions must not receive host events");

const disposalEvents = [];
lifecycleHost.adapter().connect({ onMessage: (event) => disposalEvents.push(event) });
await lifecycleHost.dispose();
await lifecycleHost.dispose();
lifecycleHost.emit({ type: "after-dispose" });
assert.deepEqual(disposalEvents, [], "disposed hosts must detach browser subscriptions");
assert.equal(lifecycleHost.subscriptions.size, 0);
console.log("ok generation lifecycle: direct-host subscriptions close and host disposal is idempotent");

const pendingNode = { id: "branch", status: "pending", markdown: "", title: "Fallback" };
const oldRun = mintHost.createGenerationRun(pendingNode);
const retryRun = mintHost.createGenerationRun(pendingNode);
assert.notEqual(oldRun.id, retryRun.id);
let guarded = createHoleState({ root_id: "branch", nodes: [pendingNode] });
guarded = reduceHoleEvent(guarded, oldRun.accept({ type: "text", delta: "old" }, { nodeId: "branch" })).state;
guarded = reduceHoleEvent(guarded, retryRun.accept({ type: "text", delta: "new" }, { nodeId: "branch" })).state;
guarded = reduceHoleEvent(guarded, oldRun.accept({ type: "text", delta: " late" }, { nodeId: "branch" })).state;
assert.equal(guarded.nodes.get("branch").markdown, "new");
console.log("ok generation lifecycle: retry mints a new run id and reducer rejects an aborted-run straggler");

const emptyWired = await collect(generationDocEvents(fixtureChunks([]), new GenerationRun({
  id: "empty-wired", fallbackTitle: "Branch fallback",
}), { nodeId: "empty-branch" }));
assert.deepEqual(emptyWired, [{
  type: "node_answered", node_id: "empty-branch", title: "Branch fallback", markdown: "",
}]);
console.log("ok generation lifecycle: browser branch wiring preserves empty-stream completion");

const rootBeforeComplete = (activeRun) => {
  if (!activeRun.snapshot().markdown.trim()) throw new Error("The provider returned an empty document.");
  activeRun.accept({ type: "title", title: "Root title" });
};
const rootWired = await collect(generationDocEvents(fixtureChunks([
  { type: "text", delta: "# Root title\n" }, { type: "text", delta: "Body" },
]), new GenerationRun({ id: "root-run", fallbackTitle: "Question" }), {
  nodeId: "root", answeredFields: { parent_id: null, read: true }, beforeComplete: rootBeforeComplete,
}));
assert.deepEqual(rootWired, [
  { type: "node_progress", node_id: "root", markdown: "# Root title\n", run: { id: "root-run", seq: 1 } },
  { type: "node_progress", node_id: "root", markdown: "# Root title\nBody", run: { id: "root-run", seq: 2 } },
  { type: "node_answered", parent_id: null, read: true, node_id: "root", title: "Root title", markdown: "# Root title\nBody" },
]);
for (const events of [[], [{ type: "text", delta: " \n" }]]) {
  await assert.rejects(() => collect(generationDocEvents(fixtureChunks(events), new GenerationRun({
    id: "empty-root", fallbackTitle: "Question",
  }), { nodeId: "root", beforeComplete: rootBeforeComplete })), /provider returned an empty document/);
}
console.log("ok generation lifecycle: browser root wiring uses GenerationRun and rejects empty or whitespace streams");

const authoringHole = createHoleFromMarkdown({ title: "Source", markdown: "Original source" });
authoringHole.nodes[0].status = "pending";
authoringHole.nodes[0].markdown = "";
const authoringSaves = [];
let continueAuthoring;
const authoringGate = new Promise((resolve) => { continueAuthoring = resolve; });
const authoringHost = new DirectRabbitholeHost({
  store: { saveHole: async (hole) => authoringSaves.push(structuredClone(hole)) },
  hole: authoringHole,
  brain: { async *authorDocument() { yield { type: "text", delta: "# Better\n" }; await authoringGate; yield { type: "text", delta: "Body" }; } },
  mintGenerationRunId: () => "author-run",
});
const progressLengths = [];
const authorDocumentPromise = authoringHost.authorDocument({ markdown: "Original source" }, {
  onProgress: (length) => progressLengths.push(length),
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(progressLengths, [9]);
assert.equal(authoringSaves.length, 0);
continueAuthoring();
const authoredHole = await authorDocumentPromise;
assert.deepEqual(progressLengths, [9, 13]);
assert.equal(authoredHole.title, "Better");
assert.equal(authoredHole.nodes[0].markdown, "# Better\nBody");
assert.equal(authoredHole.nodes[0].status, "answered");
assert.equal(authoringSaves.length, 1);
assert.equal(authoringSaves[0].nodes[0].markdown, "# Better\nBody");
assert.equal(authoringHost.abortByNode.size, 0);

const failedAuthoringSaves = [];
const failedAuthoringHost = new DirectRabbitholeHost({
  store: { saveHole: async (hole) => failedAuthoringSaves.push(structuredClone(hole)) },
  hole: structuredClone(authoringHole),
  brain: { async *authorDocument() { yield { type: "text", delta: "Partial" }; throw new Error("provider failed"); } },
});
await assert.rejects(() => failedAuthoringHost.authorDocument({ markdown: "Original source" }), /provider failed/);
await new Promise((resolve) => setTimeout(resolve, 450));
assert.equal(failedAuthoringSaves.length, 0);
assert.equal(failedAuthoringHost.saveTimer, 0);
console.log("ok generation lifecycle: document authoring saves only once on completion and saves nothing on failure");

const productionGenerationSources = await Promise.all([
  new URL("../../src/web/brain/generation-events.js", import.meta.url),
  new URL("../../src/web/transport/direct-host.js", import.meta.url),
  new URL("../../src/web/app.js", import.meta.url),
].map((url) => fs.readFile(url, "utf8")));
assert.equal(productionGenerationSources.join("\n").includes("textDeltaFromGenerationEvent"), false);
console.log("ok generation lifecycle: retired GenerationEvent text-delta seam is absent from production sources");

const appSource = await fs.readFile(new URL("../../src/web/app.js", import.meta.url), "utf8");
assert.match(appSource, /document\.addEventListener\("visibilitychange"[\s\S]*document\.visibilityState === "hidden"[\s\S]*currentHost\?\.flushSave\(\)/);
assert.match(appSource, /window\.addEventListener\("pagehide"[\s\S]*currentHost\?\.flushSave\(\)/);
console.log("ok generation lifecycle: hidden visibility and pagehide flush the existing host save pipeline");
