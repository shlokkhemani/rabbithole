/** @protects MCP instruction and tool-description context budgets. */
import assert from "node:assert/strict";
import { SERVER_INSTRUCTIONS } from "../../src/node/mcp/instructions.js";
import { toolDefinitions } from "../../src/node/mcp/tools.js";
import { buildAnswerMessages } from "../../src/core/prompts/answering-v1.js";
import { buildExplainerMessages } from "../../src/core/prompts/explainer-v1.js";

assert.ok(SERVER_INSTRUCTIONS.length < 2000,
  `server instructions must stay under 2,000 characters, got ${SERVER_INSTRUCTIONS.length}`);

const toolDescriptionLength = toolDefinitions.reduce(
  (total, tool) => total + String(tool.description || "").length,
  0,
);
// generate_image and its workflow guidance in answer_branch added ~1,000 chars in 2026-09.
assert.ok(toolDescriptionLength < 6000,
  `tool descriptions must stay under 6,000 characters, got ${toolDescriptionLength}`);

const webPromptText = JSON.stringify([
  buildAnswerMessages({ question: "Explain this", parent_markdown: "# A document" }),
  buildExplainerMessages({ question: "Explain this" }),
]);
assert.equal(webPromptText.includes("generate_image"), false,
  "web BYOK prompts must not mention the MCP-only generate_image workflow");

console.log(`ok MCP copy budgets: instructions=${SERVER_INSTRUCTIONS.length}, tool descriptions=${toolDescriptionLength}`);
