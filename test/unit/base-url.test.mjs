import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderMarkdownToHtml } from "../../src/core/markdown.js";
import {
  deriveNodeBaseUrl,
  inferBaseUrlFromFrontmatter,
  normalizeBaseUrl,
} from "../../src/core/base-url.js";
import { RabbitHoleSession } from "../../src/node/transport/session.js";
import { toolDefinitions } from "../../src/node/tools/manifest.js";

process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-base-url-"));

function assertIncludes(haystack, needle, message) {
  assert(haystack.includes(needle), message || `expected to include ${needle}`);
}

async function runMarkdownResolutionFixtures() {
  const html = await renderMarkdownToHtml(
    [
      "[dot](./guide.md)",
      "[up](../README.md)",
      "[root](/docs/root.md)",
      "[bare](foo.png)",
      "![dot](./img.png)",
      "![up](../assets/x.svg)",
      "![root](/assets/root.png)",
      "![bare](foo.png)",
    ].join("\n"),
    { baseUrl: "https://example.com/docs/page.md" }
  );
  assertIncludes(html, 'href="https://example.com/docs/guide.md"', "./ links should resolve beside the page");
  assertIncludes(html, 'href="https://example.com/README.md"', "../ links should resolve through URL semantics");
  assertIncludes(html, 'href="https://example.com/docs/root.md"', "/ links should resolve from origin");
  assertIncludes(html, 'href="https://example.com/docs/foo.png"', "bare links should resolve beside the page");
  assertIncludes(html, 'src="https://example.com/docs/img.png"', "./ images should resolve before sanitization");
  assertIncludes(html, 'src="https://example.com/assets/x.svg"', "../ images should resolve before sanitization");
  assertIncludes(html, 'src="https://example.com/assets/root.png"', "/ images should resolve before sanitization");
  assertIncludes(html, 'src="https://example.com/docs/foo.png"', "bare images should resolve before sanitization");

  const hash = await renderMarkdownToHtml("[jump](#topic)", { baseUrl: "https://example.com/docs/page.md" });
  assertIncludes(hash, 'href="#topic"', "hash-only anchors should stay local");
  assert(!hash.includes("https://example.com/docs/page.md#topic"), "hash-only anchors should not resolve against base");

  const empty = await renderMarkdownToHtml("[empty]()", { baseUrl: "https://example.com/docs/page.md" });
  assertIncludes(empty, 'href="https://example.com/docs/page.md"', "empty relative links should resolve to the base URL");

  const unsafe = await renderMarkdownToHtml("[bad](javascript:alert(1))", {
    baseUrl: "https://example.com/docs/page.md",
  });
  assert(!unsafe.includes("<a "), "javascript: links should still be stripped by the sanitizer");
  assertIncludes(unsafe, "bad", "stripping an unsafe href should preserve link text");

  const protocolRelative = await renderMarkdownToHtml("![cdn](//cdn.example/x.png)", {
    baseUrl: "https://example.com/docs/page.md",
  });
  assertIncludes(protocolRelative, 'src="https://cdn.example/x.png"', "protocol-relative images should resolve");

  const pageBase = await renderMarkdownToHtml("![x](img.png)", {
    baseUrl: "https://example.com/docs/page",
  });
  const directoryBase = await renderMarkdownToHtml("![x](img.png)", {
    baseUrl: "https://example.com/docs/page/",
  });
  assertIncludes(pageBase, 'src="https://example.com/docs/img.png"', "page base should use its containing directory");
  assertIncludes(directoryBase, 'src="https://example.com/docs/page/img.png"', "trailing-slash base should be a directory");

  console.log("ok base urls: explicit markdown resolution and sanitizer gates");
}

async function runGithubImageRewriteFixture() {
  const html = await renderMarkdownToHtml(
    [
      "![rel](./img.png)",
      "![abs](https://github.com/acme/project/blob/main/assets/logo.png?raw=true)",
      "[link](https://github.com/acme/project/blob/main/assets/logo.png?raw=true)",
    ].join("\n"),
    { baseUrl: "https://github.com/acme/project/blob/main/docs/page.md" }
  );
  assertIncludes(html, 'src="https://raw.githubusercontent.com/acme/project/main/docs/img.png"');
  assertIncludes(html, 'src="https://raw.githubusercontent.com/acme/project/main/assets/logo.png"');
  assertIncludes(html, 'href="https://github.com/acme/project/blob/main/assets/logo.png?raw=true"');
  assert(!html.includes('src="https://github.com/acme/project/blob/'), "GitHub image URLs should be rewritten to raw");

  console.log("ok base urls: GitHub image raw rewrite leaves links human-clickable");
}

function runFrontmatterAndPrecedenceFixtures() {
  const frontmatter = [
    "---",
    "source: https://source.example/doc.md",
    "canonical_url: https://canonical-url.example/doc.md",
    "canonical: https://canonical.example/doc.md",
    "base_url: https://base.example/docs/page.md",
    "---",
    "Body",
  ].join("\n");
  assert.equal(
    inferBaseUrlFromFrontmatter(frontmatter),
    "https://base.example/docs/page.md",
    "frontmatter keys should use the documented priority order"
  );

  const bodyOnly = ["Intro", "", "source: https://body.example/not-frontmatter.md"].join("\n");
  assert.equal(inferBaseUrlFromFrontmatter(bodyOnly), null, "body prose source: lines should be ignored");
  assert.equal(
    inferBaseUrlFromFrontmatter("\ufeff---\nurl: https://bom.example/doc.md\n---"),
    "https://bom.example/doc.md",
    "UTF-8 BOM before leading frontmatter should be tolerated"
  );
  assert.equal(
    inferBaseUrlFromFrontmatter('---\nurl: "https://x.test/a\\"b"\n---'),
    "https://x.test/a%22b",
    "JSON-quoted frontmatter values should unescape before URL normalization"
  );
  assert.equal(
    inferBaseUrlFromFrontmatter("---\nurl: <https://x.test/post name(1)>\n---"),
    "https://x.test/post%20name(1)",
    "angle-wrapped frontmatter URL scalars should be accepted"
  );
  assert.equal(
    inferBaseUrlFromFrontmatter(
      ["---", "base_url: https://evil@good.example/x", "canonical: https://canonical.example/doc.md", "---"].join("\n")
    ),
    "https://canonical.example/doc.md",
    "frontmatter URL values with credentials should be skipped"
  );
  assert.deepEqual(
    deriveNodeBaseUrl({
      markdown: "---\nbase_url: https://evil@good.example/x\n---\nBody",
      inheritedBaseUrl: "https://parent.example/root.md",
    }),
    { base_url: "https://parent.example/root.md", base_url_source: "inherited" },
    "credentialed frontmatter base URLs should fall through to inherited bases"
  );

  assert.deepEqual(
    deriveNodeBaseUrl({
      markdown: frontmatter,
      explicitBaseUrl: "https://explicit.example/root.md",
      inheritedBaseUrl: "https://parent.example/root.md",
    }),
    { base_url: "https://explicit.example/root.md", base_url_source: "explicit" },
    "explicit base_url should beat frontmatter and inherited bases"
  );
  assert.deepEqual(
    deriveNodeBaseUrl({ markdown: frontmatter, inheritedBaseUrl: "https://parent.example/root.md" }),
    { base_url: "https://base.example/docs/page.md", base_url_source: "frontmatter" },
    "frontmatter should beat inherited bases"
  );
  assert.deepEqual(
    deriveNodeBaseUrl({ markdown: "No frontmatter", inheritedBaseUrl: "https://parent.example/root.md" }),
    { base_url: "https://parent.example/root.md", base_url_source: "inherited" },
    "inherited base should be the fallback"
  );

  console.log("ok base urls: frontmatter inference and precedence");
}

async function runSessionLifecycleFixture() {
  const root = {
    id: "root",
    parent_id: null,
    title: "Root",
    markdown: "Root",
    base_url: "https://example.com/docs/root.md",
    base_url_source: "explicit",
    origin: null,
    position: { x: 0, y: 0 },
    size: null,
    font_scale: 1,
    collapsed: false,
    status: "answered",
    read: true,
    created_at: new Date().toISOString(),
  };
  const session = new RabbitHoleSession({
    holeId: "base-url-session",
    title: "Base URL Session",
    rootId: "root",
    nodes: [root],
    isResume: false,
    renderPage: () => "",
  });

  try {
    const partialAsk = session.handleBranchRequest({
      parent_id: "root",
      request_id: "req-partial",
      node_id: "child-partial",
      question: "Explain",
    });
    session.queue.length = 0;
    let partialNode = session.nodes.get(partialAsk.node_id);
    assert.equal(partialNode.base_url, root.base_url);
    assert.equal(partialNode.base_url_source, "inherited");
    await session.answerBranch({
      requestId: partialAsk.request_id,
      content: "![partial](img.png)",
      partial: true,
    });
    partialNode = session.nodes.get(partialAsk.node_id);
    const partialHtml = await renderMarkdownToHtml(partialNode.markdown, { baseUrl: partialNode.base_url });
    assertIncludes(
      partialHtml,
      'src="https://example.com/docs/img.png"',
      "streaming partial markdown should render with the inherited base"
    );
    const progress = session.outboundEvents.at(-1).data;
    assert.equal(progress.type, "node_progress");
    assert.equal(progress.markdown, "![partial](img.png)");
    assert.equal(Object.hasOwn(progress, "contentHtml"), false);

    const upgradeAsk = session.handleBranchRequest({
      parent_id: "root",
      request_id: "req-upgrade",
      node_id: "child-upgrade",
      question: "Open fetched child",
    });
    session.queue.length = 0;
    let upgradeNode = session.nodes.get(upgradeAsk.node_id);
    session.pushEvent({ status: "session_closed", session_id: session.id });
    const next = await session.answerBranch({
      requestId: upgradeAsk.request_id,
      title: "Fetched Child",
      content: ["---", "source: https://other.example/articles/page.md", "---", "![own](img.png)"].join("\n"),
    });
    upgradeNode = session.nodes.get(upgradeAsk.node_id);
    assert.equal(next.status, "session_closed");
    assert.equal(upgradeNode.base_url, "https://other.example/articles/page.md");
    assert.equal(upgradeNode.base_url_source, "frontmatter");
    const upgradeHtml = await renderMarkdownToHtml(upgradeNode.markdown, { baseUrl: upgradeNode.base_url });
    assertIncludes(
      upgradeHtml,
      'src="https://other.example/articles/img.png"',
      "finalized inherited nodes should upgrade to their own frontmatter base"
    );
  } finally {
    session.close("base_url_test_complete");
    await session.savingChain;
  }

  console.log("ok base urls: child inheritance, streaming fallback, frontmatter upgrade");
}

function runToolValidationFixture() {
  const open = toolDefinitions.find((tool) => tool.name === "open_rabbithole");
  const answer = toolDefinitions.find((tool) => tool.name === "answer_branch");
  assert(open);
  assert(answer);
  assert.throws(
    () => open.validateInput({ title: "Doc", content: "Body", base_url: "ftp://example.com/doc.md" }),
    /base_url must be an absolute http: or https: URL/
  );
  assert.throws(
    () => answer.validateInput({ session_id: "s", request_id: "r", content: "Body", base_url: "/relative.md" }),
    /base_url must be an absolute http: or https: URL/
  );
  assert.throws(
    () => normalizeBaseUrl("https://evil@good.example/x"),
    /base_url must not include credentials/
  );
  assert.throws(
    () => open.validateInput({ title: "Doc", content: "Body", base_url: "https://:secret@good.example/x" }),
    /base_url must not include credentials/
  );

  console.log("ok base urls: tool validation rejects invalid base_url");
}

await runMarkdownResolutionFixtures();
await runGithubImageRewriteFixture();
runFrontmatterAndPrecedenceFixtures();
await runSessionLifecycleFixture();
runToolValidationFixture();
console.log("base URL verification passed");
