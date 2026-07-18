import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { encodeBase64Utf8, renderMarkdownToHtml } from "../../src/core/markdown.js";
import { createMarkdownRenderer } from "../../src/core/markdown-renderer.js";
import { getBlockType, listBlockTypes, markdownContainsBlockType, normalizeBlockIds, registerBlockType } from "../../src/core/blocks.js";
import { buildCanvasHtml } from "../../src/node/html/canvas.js";
import { getDompurifyScript, getMermaidScript } from "../../src/node/html/built-assets.js";
import { buildCheckVisual, mountVisuals, registerBlockMount } from "../../src/ui/visuals.js";

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function decodeDataSrc(html) {
  const match = html.match(/data-src="([^"]+)"/);
  assert(match, "visual placeholder should carry data-src");
  return Buffer.from(match[1], "base64").toString("utf8");
}

async function runMarkdownFixtures() {
  const showBody = [
    '<style>.box{color:var(--accent)}</style>',
    '<div class="box">Hello visual</div>',
  ].join("\n");
  const showHtml = await renderMarkdownToHtml(["Before.", "", "```show", showBody, "```", "", "After."].join("\n"));
  assert(showHtml.includes('class="viz"'));
  assert(showHtml.includes('data-viz="show"'));
  assert.equal(decodeDataSrc(showHtml), showBody);
  assert(!showHtml.includes("&lt;style&gt;"), "recognized show fence should not render as escaped code");

  const identified = await renderMarkdownToHtml(["```show extra=yes id=b7ka2", showBody, "```"].join("\n"));
  assert(identified.includes('data-block-id="b7ka2"'));
  assert.equal(decodeDataSrc(identified), showBody, "block identity must not alter extracted source");

  const pendingShow = await renderMarkdownToHtml(["Intro.", "", "```show extra=yes id=b7ka2", "<div>half"].join("\n"));
  assert(pendingShow.includes('class="viz viz-pending"'));
  assert(pendingShow.includes('data-viz="show"'));
  assert(pendingShow.includes('data-block-id="b7ka2"'));
  assert(pendingShow.includes("Drawing…"));
  assert(!pendingShow.includes("```show"));
  assert(!pendingShow.includes("<div>half"));

  const pendingCheck = await renderMarkdownToHtml(['```check id=c8lb3', '{"question":"half"}'].join("\n"));
  assert(pendingCheck.includes('class="viz viz-pending"'));
  assert(pendingCheck.includes('data-viz="check"'));
  assert(pendingCheck.includes('data-block-id="c8lb3"'));
  assert(pendingCheck.includes("Drawing…"));
  assert(!pendingCheck.includes("question"));

  const mermaidSource = "flowchart LR\n  A --> B";
  const mermaidHtml = await renderMarkdownToHtml(["```mermaid", mermaidSource, "```"].join("\n"));
  assert(mermaidHtml.includes('data-viz="mermaid"'));
  assert.equal(decodeDataSrc(mermaidHtml), mermaidSource);
  assert(!mermaidHtml.includes('class="language-mermaid"'), "Mermaid should mount as a visual rather than highlighted code");

  const pendingMermaid = await renderMarkdownToHtml(["```mermaid", "flowchart LR"].join("\n"));
  assert(pendingMermaid.includes('class="viz viz-pending"'));
  assert(pendingMermaid.includes('data-viz="mermaid"'));

  const pendingMath = await renderMarkdownToHtml(["Math", "$$", "x + y"].join("\n"));
  assert(pendingMath.includes('class="math-pending"'));
  assert(!pendingMath.includes("x + y"));

  const rawHtml = await renderMarkdownToHtml('<section onclick="alert(1)">raw</section>');
  assert(rawHtml.includes("&lt;section onclick=&quot;alert(1)&quot;&gt;raw&lt;/section&gt;"));
  assert(!rawHtml.includes("<section"));

  console.log("ok markdown: visual placeholders carry durable ids through settled/pending rendering and source extraction");
}

function runBlockIdNormalization() {
  const source = [
    "Before  ", "", "` ```show `", "", "```javascript", "```show", "inside", "```", "", "```show", "one", "```",
    "", "~~~show note=yes id=d9mc4", "two", "~~~", "", "```mermaid", "flowchart LR", "```", "", "After",
  ].join("\n");
  const result = normalizeBlockIds(source, { idFactory: () => "b7ka2" });
  assert.equal(result.changed, true);
  assert(result.markdown.includes("```show id=b7ka2\none\n```"));
  assert(result.markdown.includes("~~~show id=d9mc4\ntwo\n~~~"));
  assert(result.markdown.includes("```mermaid id=b7ka2\nflowchart LR\n```"));
  assert(result.markdown.includes("```javascript\n```show\ninside\n```"));
  assert(result.markdown.includes("` ```show `"));
  assert.deepEqual(normalizeBlockIds(result.markdown, { idFactory: () => "c8lb3" }), { markdown: result.markdown, changed: false });
  assert.equal(markdownContainsBlockType(result.markdown, "mermaid"), true);
  assert.equal(markdownContainsBlockType("````markdown\n```mermaid\nflowchart LR\n```\n````", "mermaid"), false);
  assert.equal(markdownContainsBlockType("~~~mermaid\nflowchart LR\n~~~", "mermaid"), true);
  console.log("ok blocks: persist normalization is registered-only, byte-preserving, deterministic, and idempotent");
}

function runBlockRegistryContract() {
  assert.equal(getBlockType("SHOW")?.version, 1);
  assert(listBlockTypes().some(({ type }) => type === "show"));
  assert.throws(() => registerBlockType({
    type: "show", version: 1, parse: (source) => source, toPlainText: () => "", security: "sanitize-html",
  }), /already registered/);
  assert.throws(() => registerBlockType({ type: "missing-parse", version: 1, toPlainText: () => "", security: "inert" }), /parse\(source\)/);
  assert.throws(() => registerBlockType({ type: "missing-text", version: 1, parse: (source) => source, security: "inert" }), /toPlainText\(model\)/);
  assert.throws(() => registerBlockType({ type: "bad-security", version: 1, parse: (source) => source, toPlainText: () => "", security: "trusted" }), /security must be/);
  assert.throws(() => registerBlockMount("not-registered", {}), /unknown block type/);
  console.log("ok blocks: descriptor validation, duplicate rejection, mount binding");
}

function runCheckDescriptorGoldens() {
  assert.deepEqual(listBlockTypes().filter(({ type }) => type === "show" || type === "mermaid" || type === "check").map(({ type, version, security }) => ({ type, version, security })), [
    { type: "show", version: 1, security: "sanitize-html" },
    { type: "mermaid", version: 1, security: "sanitize-html" },
    { type: "check", version: 1, security: "sanitize-html" },
  ]);
  const descriptor = getBlockType("check");
  const model = descriptor.parse('{"question":"Which is <larger>?","options":["1 & 1","2"],"answer":1,"explanation":"Because 2 > 1."}');
  assert.deepEqual(model, { question: "Which is <larger>?", options: ["1 & 1", "2"], answer: 1, explanation: "Because 2 > 1." });
  assert.equal(descriptor.toPlainText(model), "Which is <larger>?\n1 & 1\n2");
  const rejections = [
    ["{", /valid JSON/], ["[]", /JSON object/], ['{"options":["a","b"],"answer":0}', /question/],
    ['{"question":"Q","answer":0}', /options/], ['{"question":"Q","options":["a"],"answer":0}', /2-6/],
    ['{"question":"Q","options":["a",2],"answer":0}', /only strings/], ['{"question":"Q","options":["a","b"],"answer":1.5}', /integer/],
    ['{"question":"Q","options":["a","b"],"answer":2}', /existing option/], ['{"question":"Q","options":["a","b"],"answer":0,"explanation":2}', /explanation/],
  ];
  for (const [source, pattern] of rejections) assert.throws(() => descriptor.parse(source), pattern);
  const html = buildCheckVisual(model);
  assert.match(html, /^<section class="rh-check"><div class="rh-check-question">Which is &lt;larger&gt;\?<\/div>/);
  assert.equal(count(html, 'class="rh-check-option"'), 2);
  assert(html.includes("1 &amp; 1"));
  assert(html.includes('class="rh-check-explanation" hidden>Because 2 &gt; 1.</div>'));
  assert(html.includes('<button class="rh-check-reset" type="button">Try again</button>'));
  console.log("ok check: registration metadata, strict parse/rejections, prose projection, and escaped mount structure");
}

function runDerivedFenceRecognition() {
  registerBlockType({
    type: "customblock",
    version: 1,
    parse: (source) => source,
    toPlainText: () => "",
    security: "sanitize-html",
  });
  const renderer = createMarkdownRenderer({ encodeBase64: encodeBase64Utf8 });
  const pending = renderer.renderMarkdownToHtml("```customblock\npartial");
  assert(pending.includes('class="viz viz-pending"'));
  assert(pending.includes('data-viz="customblock"'));
  assert(!pending.includes("partial"));
  const unknown = renderer.renderMarkdownToHtml("```unknownblock\nplain code");
  assert(unknown.includes('<pre><code class="language-unknownblock">plain code'));
  assert(!unknown.includes("viz-pending"));
  console.log("ok blocks: fresh renderer derives pending recognition from registry");
}

class MiniClassList {
  constructor(el) {
    this.el = el;
  }
  _items() {
    return String(this.el.className || "").split(/\s+/).filter(Boolean);
  }
  contains(name) {
    return this._items().includes(name);
  }
  add(name) {
    const items = this._items();
    if (!items.includes(name)) items.push(name);
    this.el.className = items.join(" ");
  }
  remove(name) {
    this.el.className = this._items().filter((item) => item !== name).join(" ");
  }
}

class MiniText {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = text;
    this.parentNode = null;
  }
}

class MiniElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = String(tagName || "div").toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.className = "";
    this.classList = new MiniClassList(this);
    this.shadowRoot = null;
  }
  setAttribute(name, value) {
    const stringValue = String(value);
    this.attributes[name] = stringValue;
    if (name === "class") this.className = stringValue;
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());
      this.dataset[key] = stringValue;
    }
  }
  getAttribute(name) {
    if (name === "class") return this.className;
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) this.childNodes.splice(idx, 1);
    child.parentNode = null;
    return child;
  }
  replaceChild(next, old) {
    const idx = this.childNodes.indexOf(old);
    assert.notEqual(idx, -1, "replaceChild target should be present");
    if (next.parentNode) next.parentNode.removeChild(next);
    this.childNodes[idx] = next;
    next.parentNode = this;
    old.parentNode = null;
    return old;
  }
  attachShadow() {
    this.shadowRoot = new MiniElement("#shadow-root");
    this.shadowRoot.host = this;
    return this.shadowRoot;
  }
  querySelectorAll(selector) {
    const out = [];
    const classMatch = selector.match(/^\.([A-Za-z0-9_-]+)$/);
    if (!classMatch) return out;
    const className = classMatch[1];
    function visit(node) {
      if (!node || node.nodeType !== 1) return;
      if (node.classList.contains(className)) out.push(node);
      for (const child of node.childNodes) visit(child);
    }
    visit(this);
    return out;
  }
  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [new MiniText(String(value ?? ""))];
    this.childNodes[0].parentNode = this;
  }
  get textContent() {
    return this.childNodes.map((child) => child.textContent || "").join("");
  }
  set innerHTML(html) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    const source = String(html || "");
    const nodeRe = /<(style|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let last = 0;
    let match;
    while ((match = nodeRe.exec(source))) {
      if (match.index > last) this.appendChild(new MiniText(source.slice(last, match.index)));
      const el = new MiniElement(match[1]);
      const attrRe = /([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g;
      let attr;
      while ((attr = attrRe.exec(match[2]))) el.setAttribute(attr[1], attr[2]);
      if (match[3]) el.appendChild(new MiniText(match[3]));
      this.appendChild(el);
      last = nodeRe.lastIndex;
    }
    if (last < source.length) this.appendChild(new MiniText(source.slice(last)));
  }
  get innerHTML() {
    return this.childNodes.map((child) => child.textContent || "").join("");
  }
}

function createVisualHarness() {
  let lastConfig = null;
  let hook = null;
  function sanitizeLikeDompurify(source, config) {
    let clean = String(source || "");
    if (!config.FORCE_BODY) clean = clean.replace(/^\s*<style\b[\s\S]*?<\/style>/i, "");
    for (const tag of config.FORBID_TAGS || []) {
      clean = clean.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"), "");
    }
    clean = clean.replace(/\s+on[A-Za-z]+\s*=\s*"[^"]*"/g, "");
    clean = clean.replace(/\s+on[A-Za-z]+\s*=\s*'[^']*'/g, "");
    return clean;
  }
  const document = {
    createElement(tagName) {
      return new MiniElement(tagName);
    },
  };
  const window = {
    DOMPurify: {
      sanitize(source, config) {
        lastConfig = config;
        return sanitizeLikeDompurify(source, config);
      },
      addHook(name, fn) {
        if (name === "uponSanitizeAttribute") hook = fn;
      },
    },
  };
  const context = {
    window,
    document,
    Uint8Array,
    TextDecoder,
    atob(value) {
      return Buffer.from(String(value || ""), "base64").toString("binary");
    },
  };
  globalThis.window = context.window;
  globalThis.document = context.document;
  globalThis.Uint8Array = context.Uint8Array;
  globalThis.TextDecoder = context.TextDecoder;
  globalThis.atob = context.atob;
  return {
    document,
    mountVisuals,
    getLastConfig: () => lastConfig,
    getHook: () => hook,
  };
}

function findMounted(container) {
  const mounted = [];
  function visit(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.classList.contains("viz-mounted") || node.classList.contains("viz-fallback")) mounted.push(node);
    for (const child of node.childNodes) visit(child);
  }
  visit(container);
  assert.equal(mounted.length, 1, "expected one mounted visual");
  return mounted[0];
}

function findShadowContent(mounted) {
  assert(mounted.shadowRoot, "mounted visual should have a shadow root");
  const matches = mounted.shadowRoot.querySelectorAll(".rh-viz-content");
  assert.equal(matches.length, 1, "mounted visual should have one content root");
  return matches[0];
}

async function runClientMountSimulation() {
  const harness = createVisualHarness();
  const body = '<div class="box" onclick="bad()">Identity</div>';
  const firstHtml = await renderMarkdownToHtml(["Intro.", "", "```show id=b7ka2", body, "```"].join("\n"));
  const secondHtml = await renderMarkdownToHtml(["Intro updated.", "", "```show id=b7ka2", body, "```", "", "More prose."].join("\n"));
  const container = harness.document.createElement("div");

  container.innerHTML = firstHtml;
  harness.mountVisuals(container, "reader:n1");
  const first = findMounted(container);
  first.__marker = { preserved: true };

  container.innerHTML = secondHtml;
  harness.mountVisuals(container, "reader:n1");
  const second = findMounted(container);
  assert.strictEqual(second, first, "same content key on same surface should reuse the mounted element");
  assert.equal(second.__marker.preserved, true);

  const changedHtml = await renderMarkdownToHtml(["```show id=b7ka2", "<div>Updated source</div>", "```"].join("\n"));
  container.innerHTML = changedHtml;
  harness.mountVisuals(container, "reader:n1");
  const changed = findMounted(container);
  assert.notStrictEqual(changed, first, "a durable block id must not hide source edits");
  assert.equal(findShadowContent(changed).textContent, "Updated source");

  const duplicateSource = "<div>same</div>";
  const pairHtml = await renderMarkdownToHtml(["```show id=c8lb3", duplicateSource, "```", "", "```show id=d9mc4", duplicateSource, "```"].join("\n"));
  container.innerHTML = pairHtml;
  harness.mountVisuals(container, "reader:stable-pair");
  const pair = container.childNodes.filter((node) => node.classList?.contains("viz-mounted"));
  pair[0].__identity = "first";
  pair[1].__identity = "second";
  const insertedHtml = await renderMarkdownToHtml(["```show id=e0nd5", duplicateSource, "```", "", "```show id=c8lb3", duplicateSource, "```", "", "```show id=d9mc4", duplicateSource, "```"].join("\n"));
  container.innerHTML = insertedHtml;
  harness.mountVisuals(container, "reader:stable-pair");
  const inserted = container.childNodes.filter((node) => node.classList?.contains("viz-mounted"));
  assert.equal(inserted[1].__identity, "first");
  assert.equal(inserted[2].__identity, "second");

  const duplicateIdHtml = await renderMarkdownToHtml(["```show id=f1pe6", "<div>one</div>", "```", "", "```show id=f1pe6", "<div>two</div>", "```"].join("\n"));
  container.innerHTML = duplicateIdHtml;
  harness.mountVisuals(container, "reader:duplicate-id");
  const duplicateFirstRender = container.childNodes.filter((node) => node.classList?.contains("viz-mounted"));
  assert.equal(duplicateFirstRender.length, 2);
  assert.notStrictEqual(duplicateFirstRender[0], duplicateFirstRender[1]);
  assert.equal(findShadowContent(duplicateFirstRender[0]).innerHTML, "one");
  assert.equal(findShadowContent(duplicateFirstRender[1]).innerHTML, "two");
  container.innerHTML = duplicateIdHtml;
  harness.mountVisuals(container, "reader:duplicate-id");
  const duplicateSecondRender = container.childNodes.filter((node) => node.classList?.contains("viz-mounted"));
  assert.strictEqual(duplicateSecondRender[0], duplicateFirstRender[0]);
  assert.strictEqual(duplicateSecondRender[1], duplicateFirstRender[1]);
  assert.equal(findShadowContent(duplicateSecondRender[0]).innerHTML, "one");
  assert.equal(findShadowContent(duplicateSecondRender[1]).innerHTML, "two");

  const pendingHtml = await renderMarkdownToHtml(["Intro.", "", "```show", body].join("\n"));
  container.innerHTML = pendingHtml;
  harness.mountVisuals(container, "reader:n1");
  assert.equal(container.querySelectorAll(".viz-pending").length, 1, "pending placeholder should remain unmounted");

  container.innerHTML = secondHtml;
  harness.mountVisuals(container, "reader:n1");
  assert.notStrictEqual(findMounted(container), first, "cache should prune a visual absent from a swap");

  const config = harness.getLastConfig();
  assert.deepEqual(Array.from(config.FORBID_TAGS), ["script", "iframe", "object", "embed", "form"]);
  assert.deepEqual(Array.from(config.ADD_TAGS), ["style"]);
  assert.deepEqual(Array.from(config.ADD_ATTR), ["style"]);
  assert.equal(config.FORCE_BODY, true);
  assert.deepEqual(Array.from(config.FORBID_ATTR), ["srcdoc"]);
  assert(config.USE_PROFILES.html && config.USE_PROFILES.svg && config.USE_PROFILES.svgFilters);
  assert(config.ALLOWED_URI_REGEXP.test("https://example.com/image.png"));
  assert(config.ALLOWED_URI_REGEXP.test("/relative/image.png"));
  assert(config.ALLOWED_URI_REGEXP.test("data:image/png;base64,AAAA"));
  assert(!config.ALLOWED_URI_REGEXP.test("javascript:alert(1)"));

  const hookData = { attrName: "onclick", keepAttr: true };
  harness.getHook()(null, hookData);
  assert.equal(hookData.keepAttr, false, "on* attributes should be removed by the DOMPurify hook");

  const leadingStyleBody = '<style>.x{color:red}</style><div class="x">Styled</div>';
  const leadingStyleHtml = await renderMarkdownToHtml(["```show", leadingStyleBody, "```"].join("\n"));
  container.innerHTML = leadingStyleHtml;
  harness.mountVisuals(container, "reader:n3");
  const leadingStyleContent = findShadowContent(findMounted(container));
  assert.equal(leadingStyleContent.childNodes[0].tagName, "STYLE", "leading style tag should survive mounting");
  assert(leadingStyleContent.textContent.includes(".x{color:red}"), "leading style content should survive sanitization");

  const hostileBody = '<style>.x{color:red}</style><script>alert(1)</script><div class="x" onclick="bad()">Safe</div>';
  const hostileHtml = await renderMarkdownToHtml(["```show", hostileBody, "```"].join("\n"));
  container.innerHTML = hostileHtml;
  harness.mountVisuals(container, "reader:n4");
  const hostileContent = findShadowContent(findMounted(container));
  const hostileMountedHtml = hostileContent.innerHTML;
  assert(hostileMountedHtml.includes(".x{color:red}"), "leading style should still survive hostile input");
  assert(!hostileMountedHtml.includes("<script"), "script tags should still be stripped");
  assert(!hostileMountedHtml.includes("onclick"), "event handler attributes should still be stripped");

  console.log("ok client: id-keyed mounts survive prose edits and duplicate insertion; duplicate ids fall back safely");
}

function runFrameworkSanitization() {
  const harness = createVisualHarness();
  let wiredRoot = null;
  registerBlockMount("customblock", {
    renderHtml() { return '<script>hostile()</script><div onclick="bad()">Safe</div>'; },
    wire(root) { wiredRoot = root; },
  });
  const container = harness.document.createElement("div");
  const placeholder = harness.document.createElement("div");
  placeholder.className = "viz";
  placeholder.setAttribute("data-viz", "customblock");
  placeholder.setAttribute("data-src", encodeBase64Utf8("model"));
  container.appendChild(placeholder);
  mountVisuals(container, "reader:framework-sanitize");
  const root = findShadowContent(findMounted(container));
  assert.strictEqual(wiredRoot, root, "wire should receive the sanitized content root after insertion");
  assert(!root.textContent.includes("hostile"), "framework should strip script output from mount adapters");
  assert.equal(root.childNodes[0].getAttribute("onclick"), null, "framework should strip event handlers from mount adapter output");
  console.log("ok blocks: framework sanitizes adapter HTML before wire");
}

async function assertPageAssembly() {
  const html = buildCanvasHtml({ title: "Content Blocks", root_id: "root", nodes: [] });
  const purify = getDompurifyScript();
  const mermaid = getMermaidScript();
  assert.equal(count(html, purify), 1, "DOMPurify should be inlined exactly once");
  assert.equal(count(html, mermaid), 1, "the inert Mermaid runtime should be embedded exactly once");
  assert(html.includes('<script type="application/vnd.rabbithole+mermaid" id="rabbithole-mermaid-runtime">'));
  assert.equal(count(html, "<script>"), 1, "page should keep one inline script for the node --check gate");
  assert(html.indexOf(purify) < html.indexOf('\n(function(){\n\t  "use strict";'), "DOMPurify should load before the client runtime");

  const scriptMatch = html.match(/<script>\n([\s\S]*)\n<\/script>/);
  assert(scriptMatch, "assembled HTML should contain an inline script");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-content-blocks-"));
  const scriptPath = path.join(dir, "assembled-client.js");
  await fs.writeFile(scriptPath, scriptMatch[1], "utf8");
  const check = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr || check.stdout);

  console.log("ok page assembly: DOMPurify inline once and assembled script parses");
}

runBlockIdNormalization();
runBlockRegistryContract();
runCheckDescriptorGoldens();
runDerivedFenceRecognition();
await runMarkdownFixtures();
await runClientMountSimulation();
runFrameworkSanitization();
await assertPageAssembly();
console.log("content blocks verification passed");
