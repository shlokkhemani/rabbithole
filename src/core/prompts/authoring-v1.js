export const AUTHORING_VOCABULARY_V1 = [
  "Authoring vocabulary:",
  "- Base notation: GFM markdown, $...$/$$...$$ and \\(...\\)/\\[...\\] math, and highlighted language-tagged code fences.",
  "- If the answer is content fetched from a URL or repo, pass its document URL as base_url so relative images and links resolve.",
  "- If the answer uses a local image, pass assets: [{ name, file_path }] and reference it as ![alt](asset:name.png); use this for screenshots, generated diagrams, and other non-web images.",
  "- Use ```show when a concept is spatial or structural: architecture, memory layout, relationships.",
  "- show dialect: HTML/CSS/inline-SVG only; no scripts. Scripts and unsafe attributes are stripped.",
  "- show craft: prefer HTML/CSS layout with flexbox/grid over absolute SVG coordinates.",
  "- Design visuals for about 380px card width; make them fluid and keep labels short.",
  "- Use theme tokens, never hardcoded colors, so visuals match light and dark themes:",
  "  --fg, --fg-bold, --fg-dim, --fg-faint, --node-bg, --bar-bg, --border, --border-focus, --accent, --accent-contrast, --code-bg, --hl, --hl-strong, --warn, --font-ui, --font-doc, --font-mono.",
  "- Example show:",
  "```show",
  "<style>.flow{display:grid;gap:8px}.box{border:1px solid var(--border);padding:8px;border-radius:6px}</style>",
  "<div class='flow'><div class='box'>Parse</div><div class='box' style='background:var(--hl)'>Render</div></div>",
  "```",
  "- Streaming choreography: send prose in 1-3 sentence chunks as usual.",
  "- Emit each visual fence contiguously, ideally in one chunk; readers see a placeholder until the fence closes.",
  "- Interleave prose -> visual -> prose when useful. Use a visual only when it genuinely carries the explanation.",
].join("\n");

export const AUTHORING_VOCABULARY = AUTHORING_VOCABULARY_V1;
