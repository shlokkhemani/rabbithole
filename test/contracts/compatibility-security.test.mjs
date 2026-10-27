/** @protects compatibility security capability contracts. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { getGenerationSetupStatus, setupFingerprint } from "../../src/web/settings/setup-readiness.js";
import { ensureWebDist } from "../support/build.mjs";
import { serveStatic } from "../support/static-server.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const WEB_DIST = path.join(ROOT, "web/dist");
const SECRET = `sk-or-v1-${"security-probe-secret-".repeat(5)}`;
const ASSET = "pixel.gif";
const ASSET_BASE64 = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const HOSTILE = [
  "# Hostile import",
  "",
  "<script>window.__securityProbePwned=(window.__securityProbePwned||0)+1</script>",
  '<iframe srcdoc="<script>parent.__securityProbePwned=2<\\/script>"></iframe>',
  '<img src=x onerror="window.__securityProbePwned=3">',
  '[bad](javascript:window.__securityProbePwned=4)',
  "",
  "```show",
  '<div id="safe-show" onclick="window.__securityProbePwned=5"><a id="bad-link" href="javascript:window.__securityProbePwned=6">safe label</a></div>',
  '<svg id="hostile-svg" xmlns="http://www.w3.org/2000/svg" onload="window.__securityProbePwned=7"><a href="javascript:window.__securityProbePwned=8"><text>svg-safe</text></a><animate onbegin="window.__securityProbePwned=9" attributeName="x"/></svg>',
  '<script>window.__securityProbePwned=10</script><iframe src="https://attacker.invalid/"></iframe>',
  "```",
  "",
  "Invalid math $\\notacommand{<img src=x onerror=window.__securityProbePwned=11>}$.",
  "K<sup>+</sup> and E<sub>K</sub>; hostile scripts: <sup onmouseover=\"window.__securityProbePwned=12\">2</sup> <sub style=\"background:url(https://attacker.invalid/)\">K</sub>.",
  "",
  "Valid inline $x^2+1$ and display:",
  "$$\\frac{a}{b}$$",
  "",
  `![offline asset](asset:${ASSET})`,
].join("\n");

verifySetupReadinessFingerprint();
ensureWebDist();
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-compatibility-security-"));
const hostilePath = path.join(tmp, "hostile.rabbithole");
await fs.writeFile(hostilePath, JSON.stringify(portableFixture()), "utf8");
const server = await serveStatic(WEB_DIST, { spaFallback: true });
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

try {
  const snapshot = await verifyLiveAndBuildSnapshot();
  await verifyFrozen(snapshot);
  console.log("ok security: hostile content, offline snapshots, and credential isolation");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
}

function verifySetupReadinessFingerprint() {
  const completed = {
    preset: "local",
    base_url: "http://localhost:11434/v1",
    model: "llama3.2",
    session_only: true,
  };
  completed.generation_setup = setupFingerprint(completed);
  assert.equal(getGenerationSetupStatus(completed).ready, true, "matching setup fingerprint should be ready");
  /** @type {Array<[string, Record<string, string>]>} */
  const setupChanges = [
    ["provider", { preset: "openrouter" }],
    ["endpoint", { base_url: "http://localhost:12345/v1" }],
    ["model", { model: "qwen3:8b" }],
  ];
  for (const [field, patch] of setupChanges) {
    const status = getGenerationSetupStatus({ ...completed, ...patch });
    assert.deepEqual({ ready: status.ready, reason: status.reason }, { ready: false, reason: "setup_incomplete" }, `${field} changes should invalidate completed setup`);
  }
}

async function verifyLiveAndBuildSnapshot() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const routedRequests = [];
  const external = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    routedRequests.push(url);
    if (url.startsWith(baseUrl)) return route.continue();
    external.push(url);
    return route.abort();
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.setInputFiles("#file-md", hostilePath);
  await page.waitForSelector(".doc-content #safe-show", { state: "attached" });
  await page.waitForFunction(() => document.querySelector(".doc-content img[alt='offline asset']")?.complete);
  await assertSafeRender(page, "live");
  assert(routedRequests.some((url) => url.startsWith(baseUrl)), "live request capture must observe the app");
  assert.deepEqual(external, [], "live hostile content must not initiate external requests");
  const importedAssetType = await page.evaluate((name) => window.__rabbitholeTest.inspectAssetType(name), ASSET);
  assert.equal(importedAssetType, "image/gif", "portable import derives asset MIME metadata from its validated filename");

  await page.evaluate((secret) => {
    localStorage.setItem("rh-web-api-keys", JSON.stringify({ openrouter: secret }));
    localStorage.setItem("rh-web-settings", JSON.stringify({ preset: "openrouter", session_only: false }));
  }, SECRET);
  const snapshot = await page.evaluate(() => window.__rabbitholeTest.exportSnapshot());
  const snapshotPayload = JSON.parse(snapshot.match(/<script type="application\/vnd\.rabbithole\+json" id="rabbithole-portable">([\s\S]*?)<\/script>/)[1]);
  assert(snapshotPayload.hole.nodes.every((node) => Object.keys(node.extensions).length === 0), "snapshot clears learner extension state while staying canonical");
  assert(!snapshot.includes(SECRET), "credentials must not occur in frozen HTML");
  assert(!snapshot.includes("rh-web-settings"), "preferences must not occur in frozen HTML");
  await context.close();
  return snapshot;
}

async function verifyFrozen(snapshot) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  await page.route("**/*", async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  const captureProbe = "https://rabbithole-capture-probe.invalid/";
  await page.evaluate((url) => fetch(url).catch(() => null), captureProbe);
  assert(requests.includes(captureProbe), "frozen request capture must observe the probe");
  requests.length = 0;
  await page.setContent(snapshot, { waitUntil: "load" });
  await page.waitForSelector(".doc-content #safe-show", { state: "attached" });
  await page.waitForTimeout(250);
  assert.equal(await page.locator("#taskbar button").count(), 11, "frozen snapshots should render the shared taskbar buttons");
  assert.equal(await page.locator("#tb-done").isVisible(), false, "frozen snapshots should suppress Done");
  assert.equal(await page.locator("#t-new, #t-rail").count(), 0, "only the web app can create or browse holes, so its chrome must not ship in the shared shell");
  const frozenAssets = await page.evaluate(() => [...document.querySelectorAll(".doc-content img[alt='offline asset']")].map((img) => ({ src: img.getAttribute("src"), complete: img.complete, width: img.naturalWidth })));
  assert(frozenAssets.some((img) => img.complete && img.width > 0), `frozen: embedded asset must render (${JSON.stringify(frozenAssets)})`);
  await assertSafeRender(page, "frozen");
  assert.deepEqual(requests, [], "self-contained frozen document must attempt zero network requests");
  await context.close();
}

async function assertSafeRender(page, label) {
  const result = await page.evaluate(() => {
    const doc = document.querySelector(".doc-content");
    const show = doc?.querySelector(".viz-show")?.shadowRoot;
    const all = show ? [...show.querySelectorAll("*")] : [];
    const math = [...(doc?.querySelectorAll(".katex") || [])];
    return {
      pwned: window.__securityProbePwned || 0,
      liveScripts: doc?.querySelectorAll("script,iframe").length || 0,
      scriptTags: [...(doc?.querySelectorAll("sup, sub") || [])].map((el) => ({ tag: el.tagName, attributes: el.attributes.length })),
      showScripts: show?.querySelectorAll("script,iframe,object,embed,form").length || 0,
      handlers: all.flatMap((el) => [...el.attributes]).filter((a) => /^on/i.test(a.name)).length,
      jsUrls: all.flatMap((el) => [...el.attributes]).filter((a) => /^(?:href|src|xlink:href)$/i.test(a.name) && /^\s*javascript:/i.test(a.value)).length,
      svg: !!show?.querySelector("svg#hostile-svg text"),
      safeShow: !!show?.querySelector("#safe-show"),
      mathSource: doc?.querySelectorAll("code.math-source").length || 0,
      katexCount: math.length,
      mathml: math.filter((el) => el.querySelector("math[xmlns='http://www.w3.org/1998/Math/MathML'], math")).length,
      semantics: math.filter((el) => el.querySelector("semantics annotation[encoding='application/x-tex']")).length,
      fractions: math.filter((el) => el.querySelector("mfrac, .mfrac")).length,
      asset: [...(doc?.querySelectorAll("img[alt='offline asset']") || [])].map((img) => img.getAttribute("src") || "").find(Boolean) || "",
    };
  });
  assert.equal(result.pwned, 0, `${label}: hostile code must never execute`);
  assert.equal(result.liveScripts, 0, `${label}: markdown HTML must be escaped, not activated`);
  assert(result.scriptTags.some((el) => el.tag === "SUP") && result.scriptTags.some((el) => el.tag === "SUB"), `${label}: safe script tags render`);
  assert(result.scriptTags.every((el) => el.attributes === 0), `${label}: script tag attributes never reach the DOM`);
  assert.equal(result.showScripts, 0, `${label}: forbidden show elements must be removed`);
  assert.equal(result.handlers, 0, `${label}: event-handler attributes must be removed`);
  assert.equal(result.jsUrls, 0, `${label}: javascript URLs must be removed`);
  assert(result.safeShow && result.svg, `${label}: safe HTML and SVG structure should survive sanitization`);
  assert(result.mathSource >= 1, `${label}: invalid KaTeX must degrade to inline source`);
  assert(result.katexCount >= 2, `${label}: both valid math expressions must render`);
  assert(result.mathml >= 2 && result.semantics >= 2, `${label}: KaTeX MathML semantics must survive`);
  assert(result.fractions >= 1, `${label}: fraction structure must survive sanitization`);
  const assetPattern = label === "frozen" ? /^data:image\/gif;base64,/ : /^blob:/;
  assert.match(result.asset, assetPattern, `${label}: asset must resolve through its offline-capable render path`);
}

function portableFixture() {
  return {
    format: "rabbithole", format_version: 1,
    hole: {
      schema_version: 2, hole_id: "security-hostile", title: "Security hostile fixture", root_id: "root",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", view_state: null,
      nodes: [{ id: "root", parent_id: null, title: "Hostile", markdown: HOSTILE, base_url: null, base_url_source: null, origin: null, position: { x: 0, y: 0 }, size: null, font_scale: 1, collapsed: false, status: "answered", read: true, created_at: "2026-01-01T00:00:00.000Z", extensions: { learn: { c8lb3: { attempts: 2, last: { option: 1, correct: true }, revealed: true } } } }],
    },
    assets: { [ASSET]: ASSET_BASE64 },
  };
}
