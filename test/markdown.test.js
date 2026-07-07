import assert from "node:assert/strict";
import { test } from "node:test";

import { renderMarkdownToHtml } from "../src/core/markdown.js";

test("explicit baseUrl resolves root-relative, sibling, and parent-relative markdown URLs", async () => {
  const html = await renderMarkdownToHtml(
    [
      "![root asset](/assets/a.png)",
      "![sibling image](./img.png)",
      "[parent page](../page)",
    ].join("\n\n"),
    { baseUrl: "https://example.com/docs/articles/current" },
  );

  assert.match(html, /<img src="https:\/\/example\.com\/assets\/a\.png" alt="root asset">/);
  assert.match(html, /<img src="https:\/\/example\.com\/docs\/articles\/img\.png" alt="sibling image">/);
  assert.match(html, /<a href="https:\/\/example\.com\/docs\/page"[^>]*>parent page<\/a>/);
});

test("canonical and url prologue entries infer the base for root-relative images", async (t) => {
  const cases = [
    {
      name: "canonical frontmatter",
      markdown: "---\ncanonical: https://example.com/articles/post\n---\n\n![diagram](/assets/diagram.png)",
    },
    {
      name: "url provenance line",
      markdown: "url: https://docs.example.org/guide/start\n\n![logo](/images/logo.png)",
    },
  ];

  for (const { name, markdown } of cases) {
    await t.test(name, async () => {
      const html = await renderMarkdownToHtml(markdown);

      const expectedHost = name === "canonical frontmatter" ? "example.com" : "docs.example.org";
      const expectedPath = name === "canonical frontmatter" ? "/assets/diagram.png" : "/images/logo.png";
      assert.match(html, new RegExp(`<img src="https://${expectedHost}${expectedPath}" alt="(?:diagram|logo)">`));
    });
  }
});

test("hash links remain local instead of resolving against the baseUrl", async () => {
  const html = await renderMarkdownToHtml("[jump](#details)", {
    baseUrl: "https://example.com/docs/page",
  });

  assert.match(html, /<a href="#details"[^>]*>jump<\/a>/);
  assert.doesNotMatch(html, /href="https:\/\/example\.com\/docs\/page#details"/);
  assert.doesNotMatch(html, /target="_blank"/);
});

test("javascript links and images are stripped while their text remains inert", async () => {
  const html = await renderMarkdownToHtml(
    [
      "[bad link](java\tscript:alert(1))",
      "![bad image](javascript:alert(2))",
    ].join("\n\n"),
    { baseUrl: "https://example.com/docs/page" },
  );

  assert.doesNotMatch(html, /javascript/i);
  assert.doesNotMatch(html, /<a\b/i);
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /bad link/);
  assert.match(html, /bad image/);
});

test("base64 data PNG images remain allowed", async () => {
  const html = await renderMarkdownToHtml("![inline](data:image/png;base64,iVBORw0KGgo=)", {
    baseUrl: "https://example.com/docs/page",
  });

  assert.match(html, /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="inline">/);
});
