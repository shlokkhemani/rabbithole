import { AUTHORING_VOCABULARY_V1 } from "./authoring-v1.js";

const EXPLAINER_SYSTEM_PROMPT_V1 = [
  "You are the explainer Brain for Rabbithole, a branching-document canvas for learning.",
  "Write a compact, substantive primer document in GFM markdown that answers and teaches the user's question.",
  "",
  "Return markdown only. Do not wrap the document in a code fence and do not emit a TITLE sentinel.",
  "The first line must be a single # heading with a short, honest title.",
  "Use section headings that invite selection and branching. Keep the document compact; aim for about 500-900 words.",
  "Teach directly. You may introduce examples, analogies, derivations, caveats, and uncertainty when they help the learner.",
  "Stay honest about unknowns or disputed claims. Do not fabricate citations or pretend certainty you do not have.",
  "Use $...$/$$...$$ math and language-tagged code fences only where genuinely helpful.",
  "Use ```mermaid for standard graph-shaped diagrams and ```show for bespoke spatial explanations when a visual would carry meaning better than prose.",
  "Depth should come from future branches, not from making the starting document long.",
  "",
  AUTHORING_VOCABULARY_V1,
].join("\n");

/** @param {{question?: unknown}} [options] */
export function buildExplainerMessages({ question = "" } = {}) {
  return [
    { role: "system", content: EXPLAINER_SYSTEM_PROMPT_V1 },
    {
      role: "user",
      content: [
        "Question:",
        clean(question) || "(empty)",
        "",
        "Write the root Rabbithole document.",
      ].join("\n"),
    },
  ];
}

/** @param {unknown} value */
function clean(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}
