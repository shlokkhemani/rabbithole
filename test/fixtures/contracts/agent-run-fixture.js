/** @typedef {import("../../../src/core/contracts/agent-run.js").AgentRunSummary} AgentRunSummary */

/** @type {AgentRunSummary} */
export const agentRunSummaryFixture = {
  id: "run-interrupted",
  parentRunId: null,
  targetNodeId: "answer-interrupted",
  status: "interrupted",
  prompt: "Explain the retained renderer contracts.",
  profileId: "corp-litellm",
  provider: "openai-compatible",
  model: "research-large",
  endpoint: "https://llm.example.test/v1",
  startedAt: "2026-07-28T10:02:00.000Z",
  endedAt: null,
  error: { reason: "extension-host-restarted" },
  transcriptPath: "runs/run-interrupted.jsonl",
  extensions: { fixture: true },
};
