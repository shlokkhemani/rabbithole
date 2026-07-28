import assert from "node:assert/strict";
import test from "node:test";
import { boundMcpModelResult, boundModelText, logMcpOperation } from "../../src/extension/mcp/output.js";

test("MCP output keeps exact-limit text and records truncation for line and byte overflow", () => {
  const exact = boundModelText("a\nb", { maxBytes: 128, maxLines: 2 });
  assert.equal(exact.truncated, false);
  assert.equal(exact.text, "a\nb");

  const lines = boundModelText("one\ntwo\nthree\nfour", { maxBytes: 128, maxLines: 3 });
  assert.equal(lines.truncated, true);
  assert.equal(lines.lines, 3);
  assert(lines.text.includes("line limit 3"));
  assert(!lines.text.includes("four"));

  const bytes = boundModelText("x".repeat(200), { maxBytes: 128, maxLines: 20 });
  assert.equal(bytes.truncated, true);
  assert(bytes.bytes <= 128);
  assert(bytes.text.includes("byte limit 128"));
});

test("MCP result bounding serializes structured tool output without exceeding model limits", () => {
  const result = boundMcpModelResult({ content: [{ type: "text", text: "x".repeat(300000) }] });
  assert.equal(result.truncated, true);
  assert(result.bytes <= 256 * 1024);
  assert(result.lines <= 2000);
  assert(result.text.includes("Nora MCP result truncated"));
});

test("MCP diagnostics log only non-secret operation metadata", () => {
  const lines = [];
  const outputChannel = { appendLine: (line) => lines.push(line) };
  logMcpOperation(outputChannel, {
    serverName: "corp/server",
    operation: "call_tool",
    status: "error",
    durationMs: 12.4,
    error: new Error("https://mcp.example.test?token=secret arguments secret-value"),
  });

  assert.equal(lines.length, 1);
  assert(lines[0].includes("server=corp_server"));
  assert(lines[0].includes("operation=call_tool"));
  assert(lines[0].includes("status=error"));
  assert(lines[0].includes("error=Error"));
  assert(!lines[0].includes("mcp.example"));
  assert(!lines[0].includes("secret-value"));
  assert(!lines[0].includes("token"));
});
