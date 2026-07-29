import assert from "node:assert/strict";
import { renderMarkdownToHtml } from "../../src/core/markdown.js";
import {
  deriveNodeBaseUrl,
  inferBaseUrlFromFrontmatter,
  normalizeBaseUrl,
} from "../../src/core/base-url.js";
import {
  createDocumentState,
  reduceDocumentEvent,
} from "../../src/core/document-state.js";

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

async function runDocumentLifecycleFixture() {
  let state = createBaseUrlDocumentState();

  state = reduceDocumentEvent(state, {
    type: "branch_request",
    parent_id: "root",
    request_id: "req-partial",
    node_id: "child-partial",
    question: "Explain",
  }).state;
  let partialNode = state.nodes.get("child-partial");
  assert(partialNode);
  assert.equal(partialNode.baseUrl, "https://example.com/docs/root.md");
  assert.equal(partialNode.baseUrlSource, "inherited");

  state = reduceDocumentEvent(state, {
    type: "node_progress",
    node_id: "child-partial",
    markdown: "![partial](img.png)",
  }).state;
  partialNode = state.nodes.get("child-partial");
  assert(partialNode);
  const partialHtml = await renderMarkdownToHtml(partialNode.markdown, { baseUrl: partialNode.baseUrl });
  assertIncludes(
    partialHtml,
    'src="https://example.com/docs/img.png"',
    "streaming partial markdown should render with the inherited base"
  );
  assert.equal(Object.hasOwn(partialNode, "contentHtml"), false, "Nora persisted nodes should not carry server-rendered HTML");

  state = reduceDocumentEvent(state, {
    type: "branch_request",
    parent_id: "root",
    request_id: "req-upgrade",
    node_id: "child-upgrade",
    question: "Open fetched child",
  }).state;
  state = reduceDocumentEvent(state, {
    type: "node_answered",
    node_id: "child-upgrade",
    parent_id: "root",
    title: "Fetched Child",
    markdown: ["---", "source: https://other.example/articles/page.md", "---", "![own](img.png)"].join("\n"),
  }).state;
  const upgradeNode = state.nodes.get("child-upgrade");
  assert(upgradeNode);
  assert.equal(upgradeNode.baseUrl, "https://other.example/articles/page.md");
  assert.equal(upgradeNode.baseUrlSource, "frontmatter");
  const upgradeHtml = await renderMarkdownToHtml(upgradeNode.markdown, { baseUrl: upgradeNode.baseUrl });
  assertIncludes(
    upgradeHtml,
    'src="https://other.example/articles/img.png"',
    "finalized inherited nodes should upgrade to their own frontmatter base"
  );

  console.log("ok base urls: Nora child inheritance, streaming fallback, frontmatter upgrade");
}

function runValidationFixture() {
  assert.throws(
    () => normalizeBaseUrl("ftp://example.com/doc.md"),
    /base_url must be an absolute http: or https: URL/
  );
  assert.throws(
    () => normalizeBaseUrl("/relative.md"),
    /base_url must be an absolute http: or https: URL/
  );
  assert.throws(
    () => normalizeBaseUrl("https://evil@good.example/x"),
    /base_url must not include credentials/
  );
  assert.throws(
    () => normalizeBaseUrl("https://:secret@good.example/x"),
    /base_url must not include credentials/
  );
  assert.throws(
    () => normalizeBaseUrl("https://good.example/x?token=secret"),
    /credential-bearing query parameter token/
  );
  assert.deepEqual(
    deriveNodeBaseUrl({
      markdown: "---\nbase_url: https://good.example/x?api_key=secret\n---\nBody",
      inheritedBaseUrl: "https://parent.example/root.md",
    }),
    { base_url: "https://parent.example/root.md", base_url_source: "inherited" },
    "credential-bearing frontmatter base URLs should fall through to inherited bases"
  );

  console.log("ok base urls: core validation rejects invalid base_url");
}

function createBaseUrlDocumentState() {
  const now = "2026-01-01T00:00:00.000Z";
  return createDocumentState({
    schemaVersion: 1,
    documentId: "base-url-document",
    title: "Base URL Document",
    rootNodeId: "root",
    createdAt: now,
    updatedAt: now,
    viewState: { mode: "reader", node_id: "root", scroll: 0 },
    selection: null,
    selectedProfileId: null,
    nodes: [{
      id: "root",
      parentId: null,
      title: "Root",
      markdown: "Root",
      baseUrl: "https://example.com/docs/root.md",
      baseUrlSource: "explicit",
      origin: null,
      position: { x: 0, y: 0 },
      size: null,
      fontScale: 1,
      collapsed: false,
      state: "complete",
      read: true,
      createdAt: now,
      updatedAt: now,
      sourceIds: [],
      evidenceIds: [],
      attachmentIds: [],
      runId: null,
      extensions: {},
    }],
    edges: [],
    sources: [],
    evidence: [],
    attachments: [],
    runs: [],
    checks: [],
    extensions: {},
  });
}

await runMarkdownResolutionFixtures();
await runGithubImageRewriteFixture();
runFrontmatterAndPrecedenceFixtures();
await runDocumentLifecycleFixture();
runValidationFixture();
console.log("base URL verification passed");
