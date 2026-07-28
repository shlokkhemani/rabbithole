import assert from "node:assert/strict";
import { renderMarkdownToHtml } from "../../src/core/markdown.js";
import {
  createTestNoraWebviewHtml,
  readWebviewAsset,
} from "../support/nora-webview-assets.mjs";

const KATEX_CSS_SENTINEL = ".katex .katex-version::after";

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function assertNoRawHtmlLeak(html) {
  assert(!html.includes("<script>"), "raw script tag should not pass through markdown");
  assert(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "raw HTML should be escaped");
}

async function runMarkdownFixtures() {
  const fixtures = [
    {
      name: "all four math delimiters",
      markdown: [
        "Inline dollar $a+b$ and paren \\(c+d\\).",
        "",
        "$$",
        "e=f",
        "$$",
        "",
        "\\[",
        "g=h",
        "\\]",
      ].join("\n"),
      assert(html) {
        assert.equal(count(html, 'class="katex"'), 4);
        assert.equal(count(html, 'class="katex-display"'), 2);
      },
    },
    {
      name: "inline dollar boundary rules reject prices and spacing",
      markdown: "Prices $5 and $10 stay literal. Spacing $ x$ and $x $ stays literal. $x$5 stays literal. Real $x$ works.",
      assert(html) {
        assert.equal(count(html, 'class="katex"'), 1);
        assert(html.includes("$5 and $10"));
        assert(html.includes("$ x$"));
        assert(html.includes("$x $"));
        assert(html.includes("$x$5"));
      },
    },
    {
      name: "code spans shield dollars",
      markdown: 'Code span `const price = "$5"` and math $x$.',
      assert(html) {
        assert.equal(count(html, 'class="katex"'), 1);
        assert(html.includes("<code>const price = &quot;$5&quot;</code>"));
      },
    },
    {
      name: "highlight known languages and keep unknown plain",
      markdown: [
        "```js",
        "const n = 1 < 2;",
        "```",
        "",
        "```python",
        "def add(a, b):",
        "    return a + b",
        "```",
        "",
        "```not-a-language",
        "<tag>",
        "```",
      ].join("\n"),
      assert(html) {
        assert(html.includes('class="language-js hljs"'));
        assert(html.includes('class="language-python hljs"'));
        assert(html.includes("hljs-keyword"));
        assert(html.includes('class="language-not-a-language"'));
        assert(html.includes("&lt;tag&gt;"));
        assert(!html.includes('class="language-not-a-language hljs"'));
      },
    },
    {
      name: "math inside lists and blockquotes",
      markdown: ["> Quote has $q$.", "", "- List has \\(l\\)."].join("\n"),
      assert(html) {
        assert(html.includes("<blockquote>"));
        assert(html.includes("<ul>"));
        assert.equal(count(html, 'class="katex"'), 2);
      },
    },
    {
      name: "bad TeX falls back to source code",
      markdown: "Bad math $\\badcommand{$ does not throw.",
      assert(html) {
        assert(html.includes('<code class="math-source">\\badcommand{</code>'));
        assert(!html.includes("katex-error"));
      },
    },
    {
      name: "unclosed display math is pending and source is held",
      markdown: ["Intro.", "$$", "a^2 + b^2"].join("\n"),
      assert(html) {
        assert(html.includes('class="math-pending"'));
        assert(html.includes("Intro."));
        assert(!html.includes("$$"));
        assert(!html.includes("a^2 + b^2"));
      },
    },
    {
      name: "raw HTML remains escaped",
      markdown: "<script>alert(1)</script>",
      assert: assertNoRawHtmlLeak,
    },
    {
      name: "single tildes remain literal approximation notation",
      markdown: "Rates price ~zero cuts (~77% probability); the structural bid is ~1,000t/yr.",
      assert(html) {
        assert.equal(count(html, "<del>"), 0);
        assert(html.includes("~zero cuts"));
        assert(html.includes("~77% probability"));
        assert(html.includes("~1,000t/yr"));
      },
    },
    {
      name: "only double tildes create strikethrough",
      markdown: [
        "Keep ~one~ and ~77%, delete ~~this **clearly**~~.",
        "",
        "Keep \\~escaped and `~code~`.",
      ].join("\n"),
      assert(html) {
        assert.equal(count(html, "<del>"), 1);
        assert(html.includes("<del>this <strong>clearly</strong></del>"));
        assert(html.includes("Keep ~one~ and ~77%"));
        assert(html.includes("Keep ~escaped and <code>~code~</code>"));
      },
    },
    {
      name: "distant approximation tildes cannot delete intervening prose",
      markdown: [
        "Fed funds futures now price ~zero cuts and probable hikes through 2026",
        "(a market showed ~77% probability). The structural official-sector bid",
        "(~1,000t/yr) is not carry-priced.",
      ].join(" "),
      assert(html) {
        assert.equal(count(html, "<del>"), 0);
        assert(html.includes("~zero cuts"));
        assert(html.includes("~77% probability"));
        assert(html.includes("(~1,000t/yr)"));
      },
    },
  ];

  for (const fixture of fixtures) {
    const html = await renderMarkdownToHtml(fixture.markdown);
    fixture.assert(html);
    console.log(`ok markdown: ${fixture.name}`);
  }
}

async function assertPageAssembly() {
  const html = await createTestNoraWebviewHtml();
  const katexCss = await readWebviewAsset("katex.css");
  const noraEntry = await readWebviewAsset("nora-entry.js");
  const frozenClient = await readWebviewAsset("frozen-client.js");

  assert.equal(count(katexCss, KATEX_CSS_SENTINEL), 1, "webview KaTeX CSS should include the version sentinel once");
  assert.equal(count(katexCss, "data:font/woff2;base64,"), 20, "webview KaTeX CSS should inline woff2 fonts");
  assert(!/fonts\/KaTeX_[^)]+\.(?:woff|ttf)/.test(katexCss), "webview KaTeX CSS should not reference external fonts");
  assert(html.includes('href="vscode-resource:/out/webview/canvas.css"'), "webview HTML should link the canvas stylesheet");
  assert(html.includes('href="vscode-resource:/out/webview/katex.css"'), "webview HTML should link the KaTeX stylesheet");
  assert(html.includes('src="vscode-resource:/out/webview/dompurify.js"'), "webview HTML should load DOMPurify through the CSP nonce");
  assert(html.includes('type="module" src="vscode-resource:/out/webview/nora-entry.js"'), "webview HTML should load the Nora entry module");
  assert(noraEntry.includes("rabbithole-shared-markdown-renderer-v1"), "Nora webview bundle should include the shared renderer");
  assert(frozenClient.includes("startPortableSnapshot"), "frozen snapshot client should expose snapshot hydration");
  assert(!noraEntry.includes("new EventSource"), "Nora webview bundle must not include the old SSE transport");
  assert(!noraEntry.includes("/sse"), "Nora webview bundle must not include the old SSE route");

  console.log(`ok page assembly: Nora webview HTML ${Buffer.byteLength(html, "utf8")} bytes, KaTeX CSS ${Buffer.byteLength(katexCss, "utf8")} bytes`);
}

await runMarkdownFixtures();
await assertPageAssembly();
console.log("markdown renderer verification passed");
