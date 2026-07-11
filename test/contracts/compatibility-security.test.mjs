import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { getGenerationSetupStatus, setupFingerprint } from "../../src/web/settings/setup-readiness.js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const WEB_DIST = path.join(ROOT, "web/dist");
const SECRET = `sk-or-v1-${"stage15-secret-".repeat(5)}`;
const ASSET = "pixel.gif";
const ASSET_BASE64 = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const HOSTILE = [
  "# Hostile import",
  "",
  "<script>window.__stage15Pwned=(window.__stage15Pwned||0)+1</script>",
  '<iframe srcdoc="<script>parent.__stage15Pwned=2<\\/script>"></iframe>',
  '<img src=x onerror="window.__stage15Pwned=3">',
  '[bad](javascript:window.__stage15Pwned=4)',
  "",
  "```show",
  '<div id="safe-show" onclick="window.__stage15Pwned=5"><a id="bad-link" href="javascript:window.__stage15Pwned=6">safe label</a></div>',
  '<svg id="hostile-svg" xmlns="http://www.w3.org/2000/svg" onload="window.__stage15Pwned=7"><a href="javascript:window.__stage15Pwned=8"><text>svg-safe</text></a><animate onbegin="window.__stage15Pwned=9" attributeName="x"/></svg>',
  '<script>window.__stage15Pwned=10</script><iframe src="https://attacker.invalid/"></iframe>',
  "```",
  "",
  "Invalid math $\\notacommand{<img src=x onerror=window.__stage15Pwned=11>}$.",
  "",
  "Valid inline $x^2+1$ and display:",
  "$$\\frac{a}{b}$$",
  "",
  `![offline asset](asset:${ASSET})`,
].join("\n");

verifySetupReadinessFingerprint();
await ensureBuild();
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-stage15-"));
const hostilePath = path.join(tmp, "hostile.rabbithole");
await fs.writeFile(hostilePath, JSON.stringify(portableFixture()), "utf8");
const server = await serveStatic(WEB_DIST);
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

try {
  const snapshot = await verifyLiveAndBuildSnapshot();
  await verifyFrozen(snapshot);
  await verifyPreferenceFixtures();
  console.log("ok stage15: security probes and preference/credential migration fixtures");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
}

function verifySetupReadinessFingerprint() {
  const completed = {
    preset: "custom",
    base_url: "http://localhost:11434/v1",
    answer_model: "llama3.2",
    author_model: "llama3.2",
    session_only: true,
  };
  completed.generation_setup = setupFingerprint(completed);
  assert.equal(getGenerationSetupStatus(completed).ready, true, "matching setup fingerprint should be ready");
  for (const [field, patch] of [
    ["provider", { preset: "openrouter" }],
    ["endpoint", { base_url: "http://localhost:12345/v1" }],
    ["model", { answer_model: "qwen3:8b" }],
  ]) {
    const status = getGenerationSetupStatus({ ...completed, ...patch });
    assert.deepEqual({ ready: status.ready, reason: status.reason }, { ready: false, reason: "setup_incomplete" }, `${field} changes should invalidate completed setup`);
  }
}

async function verifyLiveAndBuildSnapshot() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const external = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(baseUrl)) return route.continue();
    external.push(url);
    return route.abort();
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.setInputFiles("#file-md", hostilePath);
  await page.waitForSelector(".doc-content #safe-show", { state: "attached" });
  await page.waitForFunction(() => document.querySelector(".doc-content img[alt='offline asset']")?.complete);
  await assertSafeRender(page, "live");
  assert.deepEqual(external, [], "live hostile content must not initiate external requests");
  const importedAssetType = await page.evaluate((name) => window.__rabbitholeTest.inspectAssetType(name), ASSET);
  assert.equal(importedAssetType, "image/gif", "portable import derives asset MIME metadata from its validated filename");

  await page.evaluate((secret) => {
    localStorage.setItem("rh-web-api-key", secret);
    localStorage.setItem("rh-web-api-keys", JSON.stringify({ openrouter: secret }));
    localStorage.setItem("rh-web-settings", JSON.stringify({ preset: "openrouter", session_only: false }));
  }, SECRET);
  const snapshot = await page.evaluate(() => window.__rabbitholeTest.exportSnapshot());
  const snapshotPayload = JSON.parse(snapshot.match(/<script type="application\/vnd\.rabbithole\+json" id="rabbithole-portable">([\s\S]*?)<\/script>/)[1]);
  assert(snapshotPayload.hole.nodes.every((node) => !Object.hasOwn(node, "extensions")), "snapshot strips a populated learner extension bag");
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
  await page.setContent(snapshot, { waitUntil: "load" });
  await page.waitForSelector(".doc-content #safe-show", { state: "attached" });
  await page.waitForTimeout(250);
  assert.equal(await page.locator("#toolbar button").count(), 12, "frozen snapshots should render the canvas toolbar buttons");
  assert.equal(await page.locator("#reader-top button").count(), 7, "frozen snapshots should render the reader toolbar buttons");
  assert.equal(await page.locator("#r-done").isVisible(), false, "frozen snapshots should suppress Done");
  assert.equal(await page.locator("#act-reader").isVisible(), false, "frozen snapshots should suppress reader activity");
  assert.equal(await page.locator("#act-canvas").isVisible(), false, "frozen snapshots should suppress canvas activity");
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
      pwned: window.__stage15Pwned || 0,
      liveScripts: doc?.querySelectorAll("script,iframe").length || 0,
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

async function verifyPreferenceFixtures() {
  const fixtures = [
    {
      name: "current provider-key map",
      seed: { settings: { preset: "openrouter", base_url: "https://openrouter.ai/api/v1", answer_model: "test/model", author_model: "test/author", session_only: false }, key: SECRET, keys: { openrouter: SECRET }, theme: "dark", last: "missing-hole" },
      selected: "openrouter",
      expectedSettings: { preset: "openrouter", base_url: "https://openrouter.ai/api/v1", answer_model: "test/model", author_model: "test/author", session_only: false }, expectedKeys: { openrouter: SECRET },
    },
    {
      name: "single-key era",
      seed: { settings: { preset: "openrouter", base_url: "https://openrouter.ai/api/v1", answer_model: "legacy/model", author_model: "legacy/author", session_only: false }, key: SECRET, theme: "dark", last: "legacy-hole" },
      selected: "openrouter",
      expectedSettings: { preset: "openrouter", base_url: "https://openrouter.ai/api/v1", answer_model: "legacy/model", author_model: "legacy/author", session_only: false }, expectedKeys: { openrouter: SECRET },
    },
    {
      name: "pre-popover custom/local settings",
      seed: { settings: { preset: "custom", base_url: "http://127.0.0.1:11434/v1", answer_model: "qwen2.5", author_model: "qwen2.5", fetch_proxy_url: "https://relay.invalid/?url=", session_only: true }, key: SECRET, theme: "light", last: "local-hole" },
      selected: "custom",
      expectedSettings: { preset: "custom", base_url: "http://127.0.0.1:11434/v1", answer_model: "qwen2.5", author_model: "qwen2.5", fetch_proxy_url: "https://relay.invalid/?url=", session_only: true }, expectedKeys: { openrouter: SECRET },
    },
    {
      name: "removed Anthropic-direct provider",
      seed: { settings: { preset: "anthropic", base_url: "https://api.anthropic.com/v1", answer_model: "claude-sonnet-5", author_model: "claude-sonnet-5", session_only: false }, key: SECRET, theme: "dark", last: "anthropic-hole" },
      selected: "openrouter",
      expectedSettings: { preset: "openrouter", base_url: "https://openrouter.ai/api/v1", answer_model: "anthropic/claude-sonnet-5", author_model: "anthropic/claude-sonnet-5", session_only: false }, expectedKeys: { openrouter: SECRET },
    },
    {
      name: "removed OpenAI provider",
      seed: { settings: { preset: "openai", base_url: "https://api.openai.com/v1", answer_model: "gpt-5", author_model: "gpt-5", session_only: false }, key: SECRET, theme: "light", last: "openai-hole" },
      selected: "openrouter",
      expectedSettings: { preset: "openrouter", base_url: "https://openrouter.ai/api/v1", answer_model: "anthropic/claude-sonnet-5", author_model: "anthropic/claude-sonnet-5", session_only: false }, expectedKeys: { openrouter: SECRET },
    },
    {
      name: "malformed settings JSON",
      seed: { rawSettings: "{not-json", theme: "dark", last: "malformed-settings-hole" }, selected: "openrouter",
      expectedSettings: { preset: "openrouter", base_url: "https://openrouter.ai/api/v1", author_model: "anthropic/claude-sonnet-5", answer_model: "anthropic/claude-sonnet-5", session_only: false }, expectedKeys: null,
    },
    {
      name: "array credential map",
      seed: { settings: { preset: "openrouter", base_url: "https://openrouter.ai/api/v1", author_model: "anthropic/claude-sonnet-5", answer_model: "anthropic/claude-sonnet-5", session_only: false }, rawKeys: "[]", theme: "light", last: "malformed-keys-hole" }, selected: "openrouter",
      expectedSettings: { preset: "openrouter", base_url: "https://openrouter.ai/api/v1", author_model: "anthropic/claude-sonnet-5", answer_model: "anthropic/claude-sonnet-5", session_only: false }, expectedKeys: null,
    },
  ];
  for (const fixture of fixtures) {
    const context = await browser.newContext();
    await context.addInitScript(({ seed }) => {
      localStorage.clear();
      localStorage.setItem("rh-web-settings", seed.rawSettings || JSON.stringify(seed.settings));
      if (seed.key) localStorage.setItem("rh-web-api-key", seed.key);
      if (seed.keys) localStorage.setItem("rh-web-api-keys", JSON.stringify(seed.keys));
      if (seed.rawKeys) localStorage.setItem("rh-web-api-keys", seed.rawKeys);
      if (seed.theme) localStorage.setItem("rh-theme", seed.theme);
      if (seed.last) localStorage.setItem("rh-last-hole", seed.last);
    }, { seed: fixture.seed });
    const page = await context.newPage();
    await page.route("**/*", (route) => route.request().url().startsWith(baseUrl) ? route.continue() : route.abort());
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.keyboard.press("Escape");
    await page.click("#t-settings");
    await page.waitForSelector(".provider-choice");
    await assertPreferenceState(page, fixture);
    await settleKeyCommit(page);
    const once = await storageState(page);
    await page.reload({ waitUntil: "networkidle" });
    await page.keyboard.press("Escape");
    await page.click("#t-settings");
    await assertPreferenceState(page, fixture);
    await settleKeyCommit(page);
    assert.deepEqual(await storageState(page), once, `${fixture.name}: migration/load must be idempotent`);
    const projections = await page.evaluate(async () => {
      await window.__rabbitholeTest.createDocument("# Credential-free export");
      return {
        portable: await window.__rabbitholeTest.exportPortable(),
        snapshot: await window.__rabbitholeTest.exportSnapshot(),
        persisted: await window.__rabbitholeTest.readStoredHole(),
      };
    });
    for (const [projection, value] of Object.entries(projections)) {
      const serialized = typeof value === "string" ? value : JSON.stringify(value);
      assert(!serialized.includes(SECRET), `${fixture.name}: secret must be absent from ${projection} projection (value=${serialized})`);
      assert(!serialized.includes("rh-web-settings"), `${fixture.name}: rh-web-settings storage key must be absent from ${projection} projection (value=${serialized})`);
    }
    await context.close();
  }
}

async function settleKeyCommit(page) {
  // Opening settings asynchronously commits the prefilled key
  // (commitSettingsKey): storage writes land immediately before the status
  // line is set in the same continuation, so a settled, non-busy status means
  // localStorage is final. Providers without a key section render no status
  // element and never commit. Without this wait, the idempotence comparison
  // can capture one load mid-commit and flake under CPU contention.
  await page.waitForFunction(() => {
    const status = document.querySelector("#api-key-status");
    if (!status) return true;
    const text = (status.textContent || "").trim();
    return text.length > 0 && !status.classList.contains("busy");
  });
}

async function assertPreferenceState(page, fixture) {
  assert.equal(await page.getAttribute(`[data-provider="${fixture.selected}"]`, "aria-pressed"), "true", `${fixture.name}: provider behavior survives`);
  const state = await storageState(page);
  assert.equal(await page.getAttribute("html", "data-theme"), fixture.seed.theme, `${fixture.name}: theme survives`);
  assert.equal(state["rh-last-hole"], fixture.seed.last, `${fixture.name}: last-hole preference survives`);
  const expectedSettings = { ...fixture.expectedSettings };
  if (fixture.expectedSettings.preset === "custom" || fixture.expectedKeys?.openrouter) {
    expectedSettings.generation_setup = {
      version: 1,
      preset: fixture.expectedSettings.preset,
      base_url: fixture.expectedSettings.base_url.replace(/\/+$/, ""),
      model: fixture.expectedSettings.answer_model,
    };
  }
  assert.deepEqual(JSON.parse(state["rh-web-settings"]), expectedSettings, `${fixture.name}: settings are canonical`);
  assert.deepEqual(state["rh-web-api-keys"] === null ? null : JSON.parse(state["rh-web-api-keys"]), fixture.expectedKeys, `${fixture.name}: credential map is canonical`);
  assert.equal(state["rh-web-api-key"], null, `${fixture.name}: legacy key slot is removed`);
  if (fixture.expectedSettings.session_only === false && fixture.expectedKeys?.openrouter) {
    assert.equal(await page.inputValue("#api-key"), SECRET, `${fixture.name}: remembered key remains usable`);
  } else if (fixture.expectedSettings.preset === "custom") {
    assert.equal(await page.locator("#api-key").count(), 0, `${fixture.name}: keyless local provider remains keyless`);
  }
}

async function storageState(page) {
  return page.evaluate(() => Object.fromEntries(["rh-web-settings", "rh-web-api-key", "rh-web-api-keys", "rh-theme", "rh-last-hole"].map((key) => [key, localStorage.getItem(key)])));
}

function portableFixture() {
  return {
    format: "rabbithole", format_version: 1,
    hole: {
      schema_version: 2, hole_id: "stage15-hostile", title: "Stage 15 hostile", root_id: "root",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", view_state: null,
      nodes: [{ id: "root", parent_id: null, title: "Hostile", markdown: HOSTILE, base_url: null, base_url_source: null, origin: null, position: { x: 0, y: 0 }, size: null, font_scale: 1, collapsed: false, status: "answered", read: true, created_at: "2026-01-01T00:00:00.000Z", extensions: { learn: { c8lb3: { attempts: 2, last: { option: 1, correct: true }, revealed: true } } } }],
    },
    assets: { [ASSET]: ASSET_BASE64 },
  };
}

async function ensureBuild() {
  const build = spawnSync(process.execPath, ["build.mjs"], { cwd: ROOT, encoding: "utf8" });
  if (build.status !== 0) throw new Error(build.stderr || build.stdout || "build failed");
}

async function serveStatic(rootDir) {
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const file = path.resolve(rootDir, relative);
      if (!file.startsWith(path.resolve(rootDir) + path.sep) && file !== path.join(path.resolve(rootDir), "index.html")) throw new Error("outside root");
      const body = await fs.readFile(file);
      const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
      res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404); res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}
