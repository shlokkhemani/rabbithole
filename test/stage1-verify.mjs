import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderMarkdownToHtml } from "../src/core/markdown.js";
import { buildCanvasHtml } from "../src/core/html/canvas.js";
import { getKatexCss } from "../src/core/html/vendor-css.js";
import { createSession, closeAllSessions } from "../src/core/sessions.js";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-stage1-"));

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
  ];

  for (const fixture of fixtures) {
    const html = await renderMarkdownToHtml(fixture.markdown);
    fixture.assert(html);
    console.log(`ok markdown: ${fixture.name}`);
  }
}

async function assertPageAssembly() {
  const rootMarkdown = [
    "Root with $x^2$.",
    "",
    "```js",
    "const x = 1;",
    "```",
  ].join("\n");
  const rootNode = {
    id: "root",
    parent_id: null,
    title: "Root",
    markdown: rootMarkdown,
    contentHtml: await renderMarkdownToHtml(rootMarkdown),
    origin: null,
    position: { x: 0, y: 0 },
    size: null,
    font_scale: 1,
    collapsed: false,
    status: "answered",
    read: true,
    created_at: new Date().toISOString(),
  };

  const session = await createSession({
    holeId: "stage1-test",
    title: "Stage 1 Test",
    rootId: "root",
    nodes: [rootNode],
    isResume: false,
    renderPage: (hydration) => buildCanvasHtml(hydration),
  });

  try {
    const live = await fetch(session.url);
    assert.equal(live.status, 200);
    const liveHtml = await live.text();
    const exported = await fetch(`${session.url}/export`);
    assert.equal(exported.status, 200);
    const exportHtml = await exported.text();

    for (const [label, html] of [
      ["live", liveHtml],
      ["export", exportHtml],
    ]) {
      assert.equal(count(html, KATEX_CSS_SENTINEL), 1, `${label} should include KaTeX CSS once`);
      assert.equal(count(html, "data:font/woff2;base64,"), 20, `${label} should inline KaTeX woff2 fonts`);
      assert(!/fonts\/KaTeX_[^)]+\.(?:woff|ttf)/.test(html), `${label} should not reference external KaTeX fonts`);
      assert(html.includes("language-js hljs"), `${label} should include highlighted code`);
    }

    const scriptMatch = liveHtml.match(/<script>\n([\s\S]*)\n<\/script>/);
    assert(scriptMatch, "assembled HTML should contain one inline script");
    const scriptPath = path.join(process.env.RABBITHOLE_DIR, "assembled-client.js");
    await fs.writeFile(scriptPath, scriptMatch[1], "utf8");
    const check = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr || check.stdout);

    const katexCssBytes = Buffer.byteLength(getKatexCss(), "utf8");
    const pageBytes = Buffer.byteLength(liveHtml, "utf8");
    console.log(`ok page assembly: KaTeX CSS ${katexCssBytes} bytes, live page ${pageBytes} bytes`);
  } finally {
    await closeAllSessions("stage1_test_complete");
  }
}

await runMarkdownFixtures();
await assertPageAssembly();
console.log("stage1 verification passed");
