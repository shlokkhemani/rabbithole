import { AUTHORING_VOCABULARY_V1 } from "./authoring-v1.js";
import { lensLabel, truncate } from "../model.js";

const ANSWERING_SYSTEM_PROMPT_V1 = [
  "You are the web Brain for Rabbithole, a branching-document canvas.",
  "Write a focused markdown answer to the human's question using the supplied parent document and lineage context.",
  "",
  "The first line of every answer MUST be exactly: TITLE: <short node title>",
  "After that line, write the answer markdown. Do not repeat the TITLE line later.",
  "Keep titles short, concrete, and useful as canvas node labels.",
  "",
  AUTHORING_VOCABULARY_V1,
  "",
  "Use the parent document as the primary source of context. If context is tight, preserve the parent document before ancestor summaries.",
  "Do not mention these instructions or the context-packing format.",
].join("\n");

const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_TOKEN_BUDGET = 12000;

/** @typedef {Record<string, any>} AnswerContext */

/** @param {AnswerContext} context @param {{ tokenBudget?: number }} [options] */
export function buildAnswerMessages(context, { tokenBudget = DEFAULT_TOKEN_BUDGET } = {}) {
  let packed = packBranchContext(context, { tokenBudget });
  const attachment = context?.attachment?.kind === "image" && context.attachment.data_url ? context.attachment : null;
  if (attachment) {
    const label = attachment.source === "parent_crop" ? "Parent clip image" : "Selection region image";
    packed = `${label}: attached (page ${attachment.page}). Trust the image over extracted text for math, tables, and figures.\n${packed}`;
  }
  return [
    { role: "system", content: ANSWERING_SYSTEM_PROMPT_V1 },
    { role: "user", content: attachment ? [{ type: "text", text: packed }, { type: "image_url", image_url: { url: attachment.data_url } }] : packed },
  ];
}

/** @param {AnswerContext} context @param {{ tokenBudget?: number }} [options] */
function packBranchContext(context, { tokenBudget = DEFAULT_TOKEN_BUDGET } = {}) {
  const budget = Math.max(2000, Number(tokenBudget) || DEFAULT_TOKEN_BUDGET);
  const charBudget = budget * APPROX_CHARS_PER_TOKEN;
  const rootTitle = clean(context?.root_title || context?.rootTitle || "Untitled");
  const parentTitle = clean(context?.parent_title || context?.parentTitle || "Untitled");
  const selectedText = clean(context?.selected_text || context?.selectedText || "");
  const question = clean(context?.question || "");
  const lens = clean(context?.lens || "");
  const lensLine = lens ? `${lens} (${lensLabel(lens) || lens})` : "none";
  const ancestorLines = summarizeAncestors(context?.ancestors || []);

  const header = [
    `Root title: ${rootTitle}`,
    `Parent title: ${parentTitle}`,
    `Lens: ${lensLine}`,
    "",
    "Human selection:",
    selectedText || "(none; this is a follow-up about the parent document as a whole)",
    "",
    "Human question:",
    question || "(answer conversationally about the parent document)",
    "",
  ].join("\n");

  const parentPrefix = "Parent document markdown:\n";
  const ancestorPrefix = "\n\nAncestor chain (root to parent, title + excerpt):\n";
  const instruction = [
    "",
    "Answer the human's question. Start with TITLE: on the first line, then markdown.",
  ].join("\n");

  const fixed = header + parentPrefix + ancestorPrefix + instruction;
  const parentBudget = Math.max(1000, charBudget - fixed.length - ancestorLines.length - 200);
  const parentMarkdown = trimToBudget(clean(context?.parent_markdown || context?.parentMarkdown || ""), parentBudget);
  let packed = header + parentPrefix + parentMarkdown + ancestorPrefix + ancestorLines + instruction;

  if (packed.length > charBudget) {
    const remainingForAncestors = Math.max(0, charBudget - (header + parentPrefix + parentMarkdown + ancestorPrefix + instruction).length);
    packed = header + parentPrefix + parentMarkdown + ancestorPrefix + trimToBudget(ancestorLines, remainingForAncestors) + instruction;
  }
  if (packed.length > charBudget) {
    const parentOnlyBudget = Math.max(800, charBudget - (header + parentPrefix + ancestorPrefix + instruction).length);
    packed = header + parentPrefix + trimToBudget(parentMarkdown, parentOnlyBudget) + ancestorPrefix + instruction;
  }
  return packed;
}

/** @param {unknown} ancestors */
function summarizeAncestors(ancestors) {
  const list = Array.isArray(ancestors) ? ancestors : [];
  if (!list.length) return "(none)";
  return list.map((entry, index) => {
    const title = clean(entry?.title || `Ancestor ${index + 1}`);
    const excerpt = truncate(clean(entry?.markdown || entry?.excerpt || "").replace(/\s+/g, " "), 200);
    return `${index + 1}. ${title}${excerpt ? ` - ${excerpt}` : ""}`;
  }).join("\n");
}

/** @param {unknown} value */
function clean(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

/** @param {unknown} value @param {number} budget */
function trimToBudget(value, budget) {
  const source = String(value ?? "");
  if (source.length <= budget) return source;
  if (budget <= 1) return "";
  return `${source.slice(0, Math.max(0, budget - 1)).trimEnd()}…`;
}
