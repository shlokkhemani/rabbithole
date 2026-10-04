import { createMarkdownRenderer } from "../../src/core/markdown-renderer.js";

// A large Rabbithole, the same every time: a long root document (headings,
// paragraphs, lists, code, inline and display math) and dozens of answered
// branches anchored into it, some with branches of their own. About 30k words.

const VOCAB = (
  "attention layer model memory trait story goal habit signal context person pattern theory evidence " +
  "measure variance culture adaptation narrative motive schema belief emotion reward network token " +
  "sequence position encoder decoder weight gradient update feature value query key projection head " +
  "stable change growth self other social cognitive behaviour trace world structure level account"
).split(" ");

function words(rng, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(VOCAB[Math.floor(rng() * VOCAB.length)]);
  return out.join(" ");
}

function sentence(rng, count) {
  const text = words(rng, count);
  return text[0].toUpperCase() + text.slice(1) + ".";
}

function paragraph(rng, count) {
  const parts = [];
  for (let left = count; left > 0; left -= 12) parts.push(sentence(rng, Math.min(12, left)));
  return parts.join(" ");
}

// mulberry32: a tiny deterministic generator.
function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const renderer = createMarkdownRenderer({ encodeBase64: (s) => Buffer.from(s).toString("base64") });

// The document's text as the page lays it out (its textContent), which is
// what an anchor's offsets count in.
function plainText(markdown) {
  return renderer
    .renderMarkdownToHtml(markdown)
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function node(fields) {
  return {
    base_url: null,
    base_url_source: null,
    origin: null,
    size: { w: 420, h: 460 },
    font_scale: 1,
    collapsed: false,
    status: "answered",
    read: true,
    created_at: "2026-09-01T00:00:00.000Z",
    extensions: {},
    ...fields,
  };
}

/** @param {{ sections?: number, branches?: number }} [options] */
export function largeHole({ sections = 58, branches = 32 } = {}) {
  const rng = seeded(7);
  const blocks = ["# A Long Reading", "", paragraph(rng, 60)];
  /** @type {string[]} */
  const anchorables = [];
  for (let s = 0; s < sections; s++) {
    blocks.push("", `## Section ${s + 1}: ${words(rng, 3)}`);
    for (let p = 0; p < 5; p++) {
      const text = paragraph(rng, 64);
      blocks.push("", p === 2 && s % 3 === 0 ? `${text} The scale is $\\sqrt{d_k}$ here.` : text);
      if (p === 1) anchorables.push(text);
    }
    if (s % 2 === 0) blocks.push("", ...[0, 1, 2, 3].map(() => `- ${sentence(rng, 10)}`));
    if (s % 6 === 0) blocks.push("", "```python", "def score(q, k):", "    return q @ k.T / d ** 0.5", "```");
    if (s % 10 === 5) blocks.push("", "$$", "\\mathrm{softmax}(QK^T / \\sqrt{d_k}) V", "$$");
  }
  const rootMarkdown = blocks.join("\n");
  const rootText = plainText(rootMarkdown);
  const root = node({
    id: "root",
    parent_id: null,
    title: "A Long Reading",
    markdown: rootMarkdown,
    position: { x: 0, y: 0 },
    size: { w: 720, h: 900 },
  });
  const nodes = [root];
  // Pinned, like a long document kept on screen while its branches are read.
  root.extensions = { canvas: { pin: { x: 120, y: 24, scale: 0.8, w: 720, h: 900 } } };
  let searchFrom = 0;
  for (let b = 0; b < branches; b++) {
    const source = anchorables[Math.floor((b * anchorables.length) / branches)];
    const quote = source.split(".")[0];
    const start = rootText.indexOf(quote, searchFrom);
    if (start < 0) throw new Error("large hole: anchor text not found");
    searchFrom = start + quote.length;
    const id = "b" + String(b).padStart(2, "0");
    nodes.push(
      node({
        id,
        parent_id: "root",
        title: `Branch ${b + 1}`,
        markdown: `# Branch ${b + 1}\n\n${paragraph(rng, 90)}\n\n${paragraph(rng, 90)}\n\n- ${sentence(rng, 12)}\n- ${sentence(rng, 12)}\n\n${paragraph(rng, 60)}`,
        origin: {
          selected_text: quote,
          question: "what does this mean?",
          lens: null,
          anchor: { offset_start: start, offset_end: start + quote.length },
          branch_type: "selection",
        },
        position: { x: 800 + (b % 4) * 470, y: Math.floor(b / 4) * 520 },
      }),
    );
    if (b % 11 === 5) {
      // A margin note on the next sentence: a wash over the text, a dot beside it.
      const noted = source.split(". ")[1];
      const at = rootText.indexOf(noted, searchFrom);
      if (at < 0) throw new Error("large hole: note text not found");
      nodes.push(
        node({
          id: id + "n",
          parent_id: "root",
          title: "Note",
          markdown: "worth rereading",
          origin: {
            kind: "note",
            selected_text: noted,
            anchor: { offset_start: at, offset_end: at + noted.length },
            branch_type: "selection",
          },
          position: { x: 0, y: 0 },
          size: null,
          extensions: { note: { docked: true } },
        }),
      );
    }
    if (b % 8 === 3) {
      nodes.push(
        node({
          id: id + "x",
          parent_id: id,
          title: `Follow-up ${b + 1}`,
          markdown: `${paragraph(rng, 80)}\n\n${paragraph(rng, 80)}`,
          origin: { selected_text: "", question: "and then?", lens: null, anchor: null, branch_type: "followup" },
          position: { x: 800 + (b % 4) * 470, y: Math.floor(b / 4) * 520 + 480 },
        }),
      );
    }
  }
  return {
    schema_version: 2,
    hole_id: "large-hole",
    title: "A Long Reading",
    root_id: "root",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    view_state: null,
    nodes,
  };
}

/** @param {{ nodes: { markdown: string }[] }} hole */
export function wordCount(hole) {
  return hole.nodes.reduce((sum, n) => sum + n.markdown.split(/\s+/).filter(Boolean).length, 0);
}
