import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { TextDecoder } from "node:util";
import { renderMarkdownToHtml } from "../src/core/markdown.js";
import { buildCanvasHtml } from "../src/core/html/canvas.js";
import { getDompurifyScript } from "../src/core/html/vendor-css.js";
import { CLIENT_VISUALS } from "../src/core/html/client/visuals.js";

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

  const pendingShow = await renderMarkdownToHtml(["Intro.", "", "```show", "<div>half"].join("\n"));
  assert(pendingShow.includes('class="viz viz-pending"'));
  assert(pendingShow.includes('data-viz="show"'));
  assert(pendingShow.includes("Drawing…"));
  assert(!pendingShow.includes("```show"));
  assert(!pendingShow.includes("<div>half"));

  const pendingMath = await renderMarkdownToHtml(["Math", "$$", "x + y"].join("\n"));
  assert(pendingMath.includes('class="math-pending"'));
  assert(!pendingMath.includes("x + y"));

  const rawHtml = await renderMarkdownToHtml('<section onclick="alert(1)">raw</section>');
  assert(rawHtml.includes("&lt;section onclick=&quot;alert(1)&quot;&gt;raw&lt;/section&gt;"));
  assert(!rawHtml.includes("<section"));

  console.log("ok markdown: visual placeholders, pending states, raw HTML escaping");
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
  vm.runInNewContext(`${CLIENT_VISUALS}\nthis.__mountVisuals = mountVisuals;`, context);
  return {
    document,
    mountVisuals: context.__mountVisuals,
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
  const firstHtml = await renderMarkdownToHtml(["Intro.", "", "```show", body, "```"].join("\n"));
  const secondHtml = await renderMarkdownToHtml(["Intro updated.", "", "```show", body, "```", "", "More prose."].join("\n"));
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

  console.log("ok client: mount cache reuses identity, prunes absent keys, sanitizer config, leading styles");
}

async function assertPageAssembly() {
  const html = buildCanvasHtml({ title: "Stage 2", root_id: "root", nodes: [], frozen: true });
  const purify = getDompurifyScript();
  assert.equal(count(html, purify), 1, "DOMPurify should be inlined exactly once");
  assert.equal(count(html, "<script>"), 1, "page should keep one inline script for the node --check gate");
  assert(html.indexOf(purify) < html.indexOf("(function(){"), "DOMPurify should load before the client runtime");

  const scriptMatch = html.match(/<script>\n([\s\S]*)\n<\/script>/);
  assert(scriptMatch, "assembled HTML should contain an inline script");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-stage2-"));
  const scriptPath = path.join(dir, "assembled-client.js");
  await fs.writeFile(scriptPath, scriptMatch[1], "utf8");
  const check = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr || check.stdout);

  console.log("ok page assembly: DOMPurify inline once and assembled script parses");
}

await runMarkdownFixtures();
await runClientMountSimulation();
await assertPageAssembly();
console.log("stage2 verification passed");
