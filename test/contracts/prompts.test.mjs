import assert from "node:assert/strict";
import { buildAnswerMessages } from "../../src/core/prompts/answering-v1.js";
import { AUTHORING_VOCABULARY_V1 } from "../../src/core/prompts/authoring-v1.js";
import { buildTranscribeMessages, TRANSCRIBE_V1_RULES } from "../../src/core/prompts/transcribe-v1.js";

const context = { root_title: "Root", parent_title: "Parent", parent_markdown: "Body", ancestors: [], selected_text: "x", question: "Why?", lens: null };
const without = buildAnswerMessages(context);
const baseline = JSON.stringify(without);
assert.equal(typeof without[1].content, "string");
assert.equal(JSON.stringify(buildAnswerMessages({ ...context })), baseline, "no-attachment messages must remain byte-identical");

const dataUrl = "data:image/jpeg;base64,/9j/2Q==";
const withImage = buildAnswerMessages({ ...context, attachment: { kind: "image", data_url: dataUrl, page: 7 } });
assert.deepEqual(withImage[1].content.map((part) => part.type), ["text", "image_url"]);
assert.equal(withImage[1].content[1].image_url.url, dataUrl);
assert(withImage[1].content[0].text.startsWith("Selection region image: attached (page 7). Trust the image over extracted text for math, tables, and figures.\n"));
assert.equal(JSON.stringify(buildAnswerMessages(context)), baseline, "attachment assembly must not mutate its source context");

const inherited = buildAnswerMessages({ ...context, attachment: { kind: "image", data_url: dataUrl, page: 7, source: "parent_crop" } });
assert(inherited[1].content[0].text.startsWith("Parent clip image: attached (page 7). Trust the image over extracted text for math, tables, and figures.\n"));
assert.equal(inherited[1].content[1].image_url.url, dataUrl);

const transcription = buildTranscribeMessages({ pages: [{ n: 7, data_url: dataUrl }], tail: "x".repeat(700) });
assert.equal(transcription[0].content.at(-1).image_url.url, dataUrl);
assert.match(TRANSCRIBE_V1_RULES, /GitHub-flavored Markdown/); assert.match(TRANSCRIBE_V1_RULES, /LaTeX/); assert.match(TRANSCRIBE_V1_RULES, /GFM tables/);
assert.match(TRANSCRIBE_V1_RULES, /figure:page-NNN:x,y,w,h/); assert.match(TRANSCRIBE_V1_RULES, /running headers/); assert.match(TRANSCRIBE_V1_RULES, /no TITLE sentinel/i);
assert.equal(transcription[0].content[0].text.includes("x".repeat(500)), true); assert.equal(transcription[0].content[0].text.includes("x".repeat(501)), false);
assert.match(AUTHORING_VOCABULARY_V1, /```mermaid/);
assert.match(AUTHORING_VOCABULARY_V1, /flowcharts, sequence, class, state, and entity-relationship/);
assert.match(AUTHORING_VOCABULARY_V1, /mindmap, architecture, and Mermaid-side KaTeX syntax are not supported/);

console.log("ok prompts: PDF attachment parts, byte-identical text-only messages, and supported Mermaid authoring guidance");
