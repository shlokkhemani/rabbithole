import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantCheckpointRecord,
  committedMessageRecords,
  replayRecordsToSessionManager,
  replayableMessagesFromRecords,
  runTerminalRecord,
  traceEntriesFromRecords,
  validateTranscriptRecord,
} from "../../src/extension/agent/transcript.js";

test("transcript records distinguish committed messages, tool calls, checkpoints, and terminal status", () => {
  const assistant = {
    role: "assistant",
    content: [
      { type: "text", text: "I will read." },
      { type: "toolCall", id: "call-1", name: "nora_read_file", arguments: { repositoryId: "repo", path: "a.js" } },
    ],
    api: "fake",
    provider: "fake",
    model: "fake-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "toolUse",
    diagnostics: [{ header: "adapter chatter" }],
    timestamp: 1,
  };
  const records = committedMessageRecords("run-a", assistant, { messageId: "msg-a", now: "2026-07-28T00:00:00.000Z" });
  assert.deepEqual(records.map((record) => record.kind), ["assistant_message", "tool_call"]);
  assert.equal(records[0].message.diagnostics, undefined, "adapter diagnostics are not persisted");
  assert.deepEqual(records[1].arguments, { repositoryId: "repo", path: "a.js" });
  for (const record of records) assert.equal(validateTranscriptRecord(record), true);
});

test("replay uses committed messages and folds only the last uncommitted checkpoint for interrupted runs", () => {
  const records = [
    ...committedMessageRecords("run-a", { role: "user", content: "Prompt", timestamp: 1 }, { messageId: "user-a" }),
    assistantCheckpointRecord("run-a", "assistant-a", partial("Draft"), { sequence: 1 }),
    runTerminalRecord("run-a", "cancelled"),
  ];
  const replayed = replayableMessagesFromRecords(records);
  assert.equal(replayed.length, 2);
  assert.equal(replayed[1].role, "assistant");
  assert.equal(replayed[1].content[0].text, "Draft");
  assert.equal(replayed[1].stopReason, "aborted");

  const committed = [
    ...committedMessageRecords("run-b", { role: "assistant", content: [{ type: "text", text: "Final" }], api: "fake", provider: "fake", model: "fake", usage: {}, stopReason: "stop", timestamp: 2 }, { messageId: "assistant-b" }),
    assistantCheckpointRecord("run-b", "assistant-b", partial("Draft"), { sequence: 1 }),
    runTerminalRecord("run-b", "complete"),
  ];
  assert.deepEqual(replayableMessagesFromRecords(committed).map((message) => message.role), ["assistant"]);
});

test("records replay through Pi SessionManager.appendMessage in model-facing order", () => {
  const appended = [];
  const records = [
    ...committedMessageRecords("run-a", { role: "user", content: "Prompt", timestamp: 1 }, { messageId: "u" }),
    ...committedMessageRecords("run-a", { role: "toolResult", toolCallId: "call-1", toolName: "nora_read_file", content: [{ type: "text", text: "bounded result" }], isError: false, timestamp: 2 }, { messageId: "t" }),
  ];
  replayRecordsToSessionManager(records, { appendMessage: (message) => appended.push(message) });
  assert.deepEqual(appended.map((message) => message.role), ["user", "toolResult"]);
  assert.deepEqual(traceEntriesFromRecords(records).map((entry) => entry.kind), ["user", "tool-result"]);
});

function partial(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "fake",
    provider: "fake",
    model: "fake",
    usage: {},
    stopReason: "aborted",
    timestamp: 2,
  };
}
