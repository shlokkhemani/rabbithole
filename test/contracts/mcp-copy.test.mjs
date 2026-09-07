/** @protects MCP instruction and tool-description context budgets. */
import assert from "node:assert/strict";
import { SERVER_INSTRUCTIONS } from "../../src/node/mcp/instructions.js";
import { toolDefinitions } from "../../src/node/mcp/tools.js";

assert.ok(SERVER_INSTRUCTIONS.length < 2000,
  `server instructions must stay under 2,000 characters, got ${SERVER_INSTRUCTIONS.length}`);

const toolDescriptionLength = toolDefinitions.reduce(
  (total, tool) => total + String(tool.description || "").length,
  0,
);
// generate_image added roughly 900 characters of operational guidance in 2026-09.
assert.ok(toolDescriptionLength < 6000,
  `tool descriptions must stay under 6,000 characters, got ${toolDescriptionLength}`);

console.log(`ok MCP copy budgets: instructions=${SERVER_INSTRUCTIONS.length}, tool descriptions=${toolDescriptionLength}`);
