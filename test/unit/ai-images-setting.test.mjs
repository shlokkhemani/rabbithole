/** @protects AI images preference interpretation and runtime copy builders. */
import assert from "node:assert/strict";
import { AI_IMAGES_PREF_KEY as NODE_AI_IMAGES_PREF_KEY, imagesEnabled } from "../../src/node/mcp/images-setting.js";
import { buildServerInstructions, SERVER_INSTRUCTIONS } from "../../src/node/mcp/instructions.js";
import { answerBranchDescription, toolDefinitions } from "../../src/node/mcp/tools.js";
import { AI_IMAGES_PREF_KEY as UI_AI_IMAGES_PREF_KEY } from "../../src/ui/preferences.js";

assert.equal(NODE_AI_IMAGES_PREF_KEY, UI_AI_IMAGES_PREF_KEY, "Node and browser image preference keys must stay aligned");
assert.equal(imagesEnabled({ [NODE_AI_IMAGES_PREF_KEY]: "on" }), true);
assert.equal(imagesEnabled({ [NODE_AI_IMAGES_PREF_KEY]: "off" }), false);
assert.equal(imagesEnabled({}), false);

const fullAnswerBranch = answerBranchDescription({ imagesEnabled: true });
const offAnswerBranch = answerBranchDescription({ imagesEnabled: false });
assert.equal(fullAnswerBranch, toolDefinitions.find((tool) => tool.name === "answer_branch").description);
assert.equal(offAnswerBranch.includes("generate_image"), false);
assert(offAnswerBranch.length < fullAnswerBranch.length);

const fullInstructions = buildServerInstructions({ imagesEnabled: true });
const offInstructions = buildServerInstructions({ imagesEnabled: false });
assert.equal(fullInstructions, SERVER_INSTRUCTIONS);
assert.equal(offInstructions.includes("generate_image"), false);

console.log("AI images setting builders ok");
