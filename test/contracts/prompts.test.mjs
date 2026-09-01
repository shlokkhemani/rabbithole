/** @protects prompts capability contracts. */
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

const styled = buildAnswerMessages({ ...context, question: "Focus on the failure mode.", lens: "deeper", instruction: "Use a systems lens." });
assert.match(styled[1].content, /Preset instruction:\nUse a systems lens\.[\s\S]*Human question:\nFocus on the failure mode\./,
  "preset instruction and human question remain separate prompt slots");
const implicit = buildAnswerMessages({ ...context, question: "", instruction: "Explain plainly." });
assert.match(implicit[1].content, /Human question:\n\(the selected content\)/,
  "an empty preset question keeps the selected content as its implicit subject");

const pasted = buildAnswerMessages({ ...context, attachments: [
  { kind: "image", data_url: "data:image/png;base64,AAAA", source: "pasted_image" },
  { kind: "image", data_url: "data:image/jpeg;base64,BBBB", source: "pasted_image" },
] });
assert.deepEqual(pasted[1].content.map((part) => part.type), ["text", "image_url", "image_url"]);
assert(pasted[1].content[0].text.startsWith("Pasted images: attached. Use them as part of the human's question.\n"));
assert.equal(pasted[1].content[0].text.includes("page undefined"), false);
assert.deepEqual(pasted[1].content.slice(1).map((part) => part.image_url.url), [
  "data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB",
]);

const noteContext = {
  ...context,
  parent_id: "parent",
  notes: [
    { note_id: "standalone", on_node_id: null, on_selected_text: null, content: "Compare this globally." },
    { note_id: "anchored", on_node_id: "parent", on_selected_text: "the exact clause", content: "This caveat matters." },
    { note_id: "followup-note", on_node_id: "parent", on_selected_text: null, content: "This applies to the whole parent.", author: "agent" },
  ],
};
const noteMessages = buildAnswerMessages(noteContext);
assert.match(noteMessages[0].content, /Each note is attributed to the human or an agent/);
assert.match(noteMessages[1].content, /Human question:\nWhy\?\n\nNotes:\n- Human: Compare this globally\.\n- Human: Anchored to "the exact clause": This caveat matters\.\n- Agent: On "Parent": This applies to the whole parent\.\n\nParent document markdown:/);
assert.equal(noteMessages[1].content.includes('Anchored to "null"'), false, "anchor-less parented notes must never stringify a null anchor");

const tightContext = {
  ...context,
  parent_markdown: `PARENT_KING ${"p".repeat(20000)}`,
};
const tightWithoutNotes = buildAnswerMessages(tightContext, { tokenBudget: 2000 })[1].content;
const tightWithNotes = buildAnswerMessages({
  ...tightContext,
  notes: [{ content: `NOTE_START ${"n".repeat(1000)} NOTE_TAIL`, on_selected_text: "budget anchor" }],
}, { tokenBudget: 2000 })[1].content;
const parentSection = (value) => value.slice(value.indexOf("Parent document markdown:"));
assert.equal(parentSection(tightWithNotes), parentSection(tightWithoutNotes), "note pressure must not consume the parent-document budget");
assert.match(tightWithNotes, /Notes:/);
assert.match(tightWithNotes, /NOTE_START/);
assert.equal(tightWithNotes.includes("NOTE_TAIL"), false, "note excerpts trim before parent markdown under a tight budget");
assert.match(tightWithNotes, /PARENT_KING/);

const transcription = buildTranscribeMessages({ pages: [{ n: 7, data_url: dataUrl }], tail: "x".repeat(700) });
assert.equal(transcription[0].content.at(-1).image_url.url, dataUrl);
assert.match(TRANSCRIBE_V1_RULES, /GitHub-flavored Markdown/); assert.match(TRANSCRIBE_V1_RULES, /LaTeX/); assert.match(TRANSCRIBE_V1_RULES, /GFM tables/);
assert.match(TRANSCRIBE_V1_RULES, /figure:page-NNN:x,y,w,h/); assert.match(TRANSCRIBE_V1_RULES, /running headers/); assert.match(TRANSCRIBE_V1_RULES, /no TITLE sentinel/i);
assert.equal(transcription[0].content[0].text.includes("x".repeat(500)), true); assert.equal(transcription[0].content[0].text.includes("x".repeat(501)), false);
assert.match(AUTHORING_VOCABULARY_V1, /```mermaid/);
assert.match(AUTHORING_VOCABULARY_V1, /flowcharts, sequence, class, state, and entity-relationship/);
assert.match(AUTHORING_VOCABULARY_V1, /Markdown Strings/);
assert.match(AUTHORING_VOCABULARY_V1, /Do not put HTML tags such as <i>, <b>, or <br> in Mermaid labels/);
assert.match(AUTHORING_VOCABULARY_V1, /mindmap, architecture, and Mermaid-side KaTeX syntax are not supported/);
assert.match(AUTHORING_VOCABULARY_V1, /```show id=<slug>/);
assert.match(AUTHORING_VOCABULARY_V1, /```check with strict JSON/);

console.log("ok prompts: PDF attachments, note context and budget priority, byte-identical text-only messages, and Mermaid guidance");
