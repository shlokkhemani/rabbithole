import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { buildSnapshotHtml } from "../../src/core/snapshot-html.js";
import { buildCanvasHtml } from "../../src/node/html/canvas.js";
import { createSession, closeAllSessions } from "../../src/node/sessions.js";
import { ensureWebDist } from "../support/build.mjs";
import { serveStatic } from "../support/static-server.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const WEB_DIST = path.join(ROOT, "web/dist");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-mermaid-"));
process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = path.join(tmp, "store");
const fixturePath = path.join(tmp, "mermaid.rabbithole");
await fs.writeFile(fixturePath, JSON.stringify(portableFixture()), "utf8");

ensureWebDist();
const server = await serveStatic(WEB_DIST, { spaFallback: true });
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

try {
  const snapshot = await verifyWebApp();
  await verifyOfflineSnapshot(snapshot);
  await verifySelfContainedMcpPage();
  verifyConditionalSnapshotAssembly();
  console.log("ok Mermaid: fullscreen controls, strict rendering, theme refresh, and offline snapshots");
} finally {
  await browser.close();
  await closeAllSessions("mermaid_test_complete");
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
}

async function verifySelfContainedMcpPage() {
  const session = await createSession({
    holeId: "mermaid-mcp-live",
    title: "Mermaid MCP live",
    rootId: "root",
    nodes: [node("root", null, "Root", "```mermaid\nstateDiagram-v2\n  [*] --> Exploring\n  Exploring --> Understanding\n```", 0)],
    assetNames: new Set(),
    isResume: false,
    renderPage: (hydration) => buildCanvasHtml(hydration),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  await page.on("request", (request) => requests.push(request.url()));
  await page.goto(session.url, { waitUntil: "load" });
  await page.waitForFunction(() => !!document.querySelector(".viz-mermaid")?.shadowRoot?.querySelector("svg"));
  assert.equal(requests.filter((url) => /\/mermaid\.js(?:\?|$)/.test(url)).length, 0, "MCP canvas must not fetch an external Mermaid asset");
  assert.equal(await page.locator('#rabbithole-mermaid-runtime[type="application/vnd.rabbithole+mermaid"]').count(), 1);
  const exported = await fetch(`${session.url}/export`);
  assert.equal(exported.status, 200);
  const html = await exported.text();
  assert(html.includes('id="rabbithole-mermaid-runtime"'), "MCP export should carry its Mermaid runtime offline");
  await context.close();
}

async function verifyWebApp() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  await page.route("**/*", async (route) => {
    requests.push(route.request().url());
    await route.continue();
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  assert.equal(requests.filter((url) => /\/mermaid\.js(?:\?|$)/.test(url)).length, 0, "blank web app must not load Mermaid");

  await page.setInputFiles("#file-md", fixturePath);
  try {
    await page.waitForFunction(() => {
      const mounts = [...document.querySelectorAll(".viz-mermaid")];
      const rendered = mounts.filter((mount) => mount.shadowRoot?.querySelector(".rh-mermaid svg")).length;
      const fallback = mounts.filter((mount) => mount.shadowRoot?.querySelector(".viz-fallback code")?.textContent.includes("this is not valid mermaid")).length;
      return rendered >= 2 && fallback >= 1;
    });
  } catch (error) {
    const state = await page.evaluate(() => [...document.querySelectorAll(".viz-mermaid")].map((mount) => ({
      svg: !!mount.shadowRoot?.querySelector("svg"),
      fallback: mount.shadowRoot?.querySelector(".viz-fallback code")?.textContent || "",
      text: mount.shadowRoot?.textContent || "",
    })));
    throw new Error(`Mermaid mounts did not settle: ${JSON.stringify(state)}`, { cause: error });
  }
  assert.equal(requests.filter((url) => /\/mermaid\.js(?:\?|$)/.test(url)).length, 1, "all live diagrams should share one lazy runtime load");

  const safe = await page.evaluate(() => {
    const mounts = [...document.querySelectorAll(".viz-mermaid")];
    const elements = mounts.flatMap((mount) => [...(mount.shadowRoot?.querySelectorAll("*") || [])]);
    return {
      pwned: window.__mermaidProbePwned || 0,
      scripts: elements.filter((element) => /^(?:SCRIPT|IFRAME|OBJECT|EMBED|FORM)$/.test(element.tagName)).length,
      handlers: elements.flatMap((element) => [...element.attributes]).filter((attribute) => /^on/i.test(attribute.name)).length,
      javascriptUrls: elements.flatMap((element) => [...element.attributes]).filter((attribute) => /^(?:href|src|xlink:href)$/i.test(attribute.name) && /^\s*javascript:/i.test(attribute.value)).length,
      rendered: mounts.filter((mount) => mount.shadowRoot?.querySelector("svg")).length,
      fallbackText: mounts.map((mount) => mount.shadowRoot?.querySelector(".viz-fallback code")?.textContent || "").find(Boolean) || "",
    };
  });
  assert.deepEqual({ pwned: safe.pwned, scripts: safe.scripts, handlers: safe.handlers, javascriptUrls: safe.javascriptUrls }, { pwned: 0, scripts: 0, handlers: 0, javascriptUrls: 0 });
  assert(safe.rendered >= 2);
  assert.equal(safe.fallbackText, "this is not valid mermaid");

  const affordances = await page.evaluate(() => [...document.querySelectorAll(".viz-mermaid")].map((mount) => ({
    rendered: !!mount.shadowRoot?.querySelector(".rh-mermaid svg"),
    fallback: !!mount.shadowRoot?.querySelector(".viz-fallback"),
    expand: !!mount.shadowRoot?.querySelector('button.rh-mermaid-expand[aria-label="Open diagram fullscreen"][title="Open fullscreen"]'),
  })));
  assert(affordances.filter((item) => item.rendered && item.expand).length >= 2, "successful Mermaid renders should expose expand controls");
  assert(affordances.filter((item) => item.fallback).every((item) => !item.expand), "Mermaid fallbacks must not expose expand controls");

  const inlineLayout = await page.evaluate(() => {
    const mount = [...document.querySelectorAll(".viz-mermaid")].find((item) => item.shadowRoot?.querySelector(".rh-mermaid svg"));
    const frame = mount.shadowRoot.querySelector(".rh-viz-frame");
    const svgRect = mount.shadowRoot.querySelector(".rh-mermaid svg").getBoundingClientRect();
    const buttonRect = mount.shadowRoot.querySelector(".rh-mermaid-expand").getBoundingClientRect();
    return {
      intersects: buttonRect.left < svgRect.right && buttonRect.right > svgRect.left
        && buttonRect.top < svgRect.bottom && buttonRect.bottom > svgRect.top,
      scrollWidth: frame.scrollWidth,
      clientWidth: frame.clientWidth,
      hostContain: getComputedStyle(mount).contain,
    };
  });
  assert.equal(inlineLayout.intersects, false, `inline expand control must not cover the rendered SVG (${JSON.stringify(inlineLayout)})`);
  assert(inlineLayout.scrollWidth <= inlineLayout.clientWidth + 1, `fitted Mermaid SVG should not require frame scrolling (${JSON.stringify(inlineLayout)})`);
  assert(!inlineLayout.hostContain.includes("paint"), "Mermaid host paint containment must not clip the elevated expand control");

  const expand = page.locator(".rh-mermaid-expand:visible").first();
  await expand.focus();
  await expand.press("Enter");
  await page.waitForSelector(".rh-lightbox .rh-lightbox-diagram");
  await page.waitForTimeout(200);
  const fullscreen = await page.locator(".rh-lightbox").evaluate((overlay) => {
    const svg = overlay.querySelector(".rh-lightbox-diagram");
    const close = overlay.querySelector(".rh-lightbox-close");
    const plate = overlay.querySelector(".rh-lightbox-plate");
    const rect = svg.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    const plateRect = plate.getBoundingClientRect();
    const plateStyle = getComputedStyle(plate);
    const insetWidth = parseFloat(plateStyle.paddingLeft) + parseFloat(plateStyle.paddingRight)
      + parseFloat(plateStyle.borderLeftWidth) + parseFloat(plateStyle.borderRightWidth);
    const insetHeight = parseFloat(plateStyle.paddingTop) + parseFloat(plateStyle.paddingBottom)
      + parseFloat(plateStyle.borderTopWidth) + parseFloat(plateStyle.borderBottomWidth);
    const viewBox = svg.viewBox.baseVal;
    return {
      tag: svg.tagName,
      width: rect.width,
      height: rect.height,
      plateWidth: plateRect.width,
      plateHeight: plateRect.height,
      plateContentAspect: (plateRect.width - insetWidth) / (plateRect.height - insetHeight),
      viewBoxAspect: viewBox.width / viewBox.height,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      closeGap: closeRect.left - rect.right,
      widthAttr: svg.getAttribute("width"),
      heightAttr: svg.getAttribute("height"),
      preserveAspectRatio: svg.getAttribute("preserveAspectRatio"),
      label: overlay.querySelector(".rh-lightbox-dialog").getAttribute("aria-label"),
    };
  });
  assert.equal(fullscreen.tag.toLowerCase(), "svg");
  assert(
    Math.abs(fullscreen.plateContentAspect - fullscreen.viewBoxAspect) / fullscreen.viewBoxAspect < 0.01,
    `fullscreen plate content should match the Mermaid viewBox aspect (${JSON.stringify(fullscreen)})`,
  );
  assert(
    fullscreen.plateWidth >= Math.min(fullscreen.viewportWidth * 0.96, fullscreen.viewportWidth - 112) - 1
      || fullscreen.plateHeight >= Math.min(fullscreen.viewportHeight * 0.92, fullscreen.viewportHeight - 32) - 1,
    `fullscreen Mermaid should scale up to the largest aspect-fitted viewport budget (${JSON.stringify(fullscreen)})`,
  );
  assert(fullscreen.closeGap >= 0, "fullscreen close control should not overlap diagram content");
  assert.equal(fullscreen.widthAttr, null);
  assert.equal(fullscreen.heightAttr, null);
  assert.equal(fullscreen.preserveAspectRatio, "xMidYMid meet");
  assert.equal(fullscreen.label, "Mermaid diagram");

  await page.locator(".rh-lightbox-diagram").dblclick();
  assert.equal(await page.locator(".rh-lightbox-diagram").evaluate((svg) => svg.style.getPropertyValue("--rh-zoom")), "2");
  const zoomedLayout = await page.locator(".rh-lightbox").evaluate((overlay) => {
    const svg = overlay.querySelector(".rh-lightbox-diagram");
    const plate = overlay.querySelector(".rh-lightbox-plate");
    const close = overlay.querySelector(".rh-lightbox-close");
    const svgRect = svg.getBoundingClientRect();
    const plateRect = plate.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    const sample = { x: plateRect.left - 2, y: plateRect.top + plateRect.height / 2 };
    const diagramHitOutsidePlate = document.elementsFromPoint(sample.x, sample.y).some((element) => element === svg || svg.contains(element));
    const closeHit = document.elementFromPoint(closeRect.left + closeRect.width / 2, closeRect.top + closeRect.height / 2);
    return {
      overflow: getComputedStyle(plate).overflow,
      svgExceedsPlate: svgRect.left < plateRect.left && svgRect.right > plateRect.right,
      diagramHitOutsidePlate,
      closeHit: close === closeHit || close.contains(closeHit),
      closeZ: parseInt(getComputedStyle(close).zIndex, 10),
      plateZ: parseInt(getComputedStyle(plate).zIndex, 10),
      closeBackground: getComputedStyle(close).backgroundColor,
      closeShadow: getComputedStyle(close).boxShadow,
    };
  });
  assert.equal(zoomedLayout.overflow, "hidden", "diagram plate should clip zoomed content");
  assert.equal(zoomedLayout.svgExceedsPlate, true, "2x diagram geometry should exercise the plate clipping boundary");
  assert.equal(zoomedLayout.diagramHitOutsidePlate, false, "zoomed diagram must not paint or hit-test outside the plate");
  assert(zoomedLayout.closeZ > zoomedLayout.plateZ, `close control must stack above the plate (${JSON.stringify(zoomedLayout)})`);
  assert.equal(zoomedLayout.closeHit, true, `close control must remain hit-testable at 2x zoom (${JSON.stringify(zoomedLayout)})`);
  assert(!zoomedLayout.closeBackground.endsWith(", 0)"), "close control should have an opaque theme surface");
  assert.notEqual(zoomedLayout.closeShadow, "none", "close control should retain elevation over diagram content");
  const beforeTheme = await firstMermaidSvg(page);
  const beforeFullscreen = await page.locator(".rh-lightbox-diagram").evaluate((svg) => svg.outerHTML);
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });
  await page.waitForFunction((before) => {
    const mount = document.querySelector(".viz-mermaid");
    return !!mount?.shadowRoot?.querySelector("svg") && mount.shadowRoot.querySelector("svg").outerHTML !== before;
  }, beforeTheme);
  await page.waitForFunction((before) => document.querySelector(".rh-lightbox-diagram")?.outerHTML !== before, beforeFullscreen);
  assert.equal(await page.locator(".rh-lightbox-diagram").evaluate((svg) => svg.style.getPropertyValue("--rh-zoom")), "2", "theme refresh should preserve fullscreen zoom");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".rh-lightbox", { state: "detached" });
  assert.equal(await page.evaluate(() => {
    const mount = document.activeElement;
    return mount?.shadowRoot?.activeElement?.classList.contains("rh-mermaid-expand") || false;
  }), true, "Mermaid Escape should restore focus to the expand control");

  await expand.press("Enter");
  await page.waitForSelector(".rh-lightbox");
  await page.click('.rh-lightbox-close[aria-label="Close"]');
  await page.waitForSelector(".rh-lightbox", { state: "detached" });
  assert.equal(await page.evaluate(() => {
    const mount = document.activeElement;
    return mount?.shadowRoot?.activeElement?.classList.contains("rh-mermaid-expand") || false;
  }), true, "Mermaid close button should restore focus to the expand control");

  const surfaceBox = await page.locator(".rh-mermaid svg:visible").first().boundingBox();
  assert(surfaceBox, "rendered Mermaid should have a clickable surface");
  await page.mouse.click(surfaceBox.x + surfaceBox.width / 2, surfaceBox.y + surfaceBox.height / 2);
  await page.waitForSelector(".rh-lightbox .rh-lightbox-diagram");
  await page.mouse.click(5, 5);
  await page.waitForSelector(".rh-lightbox", { state: "detached" });

  await page.mouse.move(surfaceBox.x + surfaceBox.width / 2, surfaceBox.y + surfaceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(surfaceBox.x + surfaceBox.width / 2 + 10, surfaceBox.y + surfaceBox.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(50);
  assert.equal(await page.locator(".rh-lightbox").count(), 0, "dragging across a Mermaid diagram must not open fullscreen");

  const snapshot = await page.evaluate(() => window.__rabbitholeTest.exportSnapshot());
  assert(snapshot.includes('type="application/vnd.rabbithole+mermaid"'), "Mermaid snapshots should carry an inert offline runtime");
  assert(snapshot.includes('globalThis["mermaid"]'), "Mermaid snapshots should contain the pinned runtime source");
  assert.equal(requests.filter((url) => /\/mermaid\.js(?:\?|$)/.test(url)).length, 2, "snapshot export should fetch the runtime source once after the live script load");
  await context.close();
  return snapshot;
}

async function firstMermaidSvg(page) {
  return page.evaluate(() => document.querySelector(".viz-mermaid")?.shadowRoot?.querySelector("svg")?.outerHTML || "");
}

async function verifyOfflineSnapshot(snapshot) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  await page.route("**/*", async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  await page.setContent(snapshot, { waitUntil: "load" });
  await page.waitForFunction(() => {
    const mounts = [...document.querySelectorAll(".viz-mermaid")];
    return mounts.filter((mount) => mount.shadowRoot?.querySelector("svg")).length >= 2
      && mounts.filter((mount) => mount.shadowRoot?.querySelector(".viz-fallback")).length >= 1;
  });
  assert.deepEqual(requests, [], "offline Mermaid snapshots must make zero network requests");
  assert.equal(await page.evaluate(() => window.__mermaidProbePwned || 0), 0);
  const expand = page.locator(".rh-mermaid-expand:visible").first();
  await expand.focus();
  await expand.press("Enter");
  await page.waitForSelector(".rh-lightbox .rh-lightbox-diagram");
  await page.click('.rh-lightbox-close[aria-label="Close"]');
  await page.waitForSelector(".rh-lightbox", { state: "detached" });
  await context.close();
}

function verifyConditionalSnapshotAssembly() {
  const common = {
    title: "No diagrams",
    stylesheetText: "body{}",
    dompurifySource: "window.DOMPurify={sanitize:function(value){return value},addHook:function(){}};",
    frozenClientSource: "window.RabbitholeFrozenClient={startPortableSnapshot:function(){}};",
  };
  const without = buildSnapshotHtml({ ...common, snapshotProjection: projectionWith("Plain prose") });
  assert(!without.includes("rabbithole-mermaid-runtime"), "ordinary snapshots must not embed Mermaid");
  assert.throws(
    () => buildSnapshotHtml({ ...common, snapshotProjection: projectionWith("```mermaid\nflowchart LR\nA-->B\n```") }),
    /Mermaid runtime is unavailable/,
  );
  const nestedExample = buildSnapshotHtml({
    ...common,
    snapshotProjection: projectionWith("````markdown\n```mermaid\nA-->B\n```\n````"),
  });
  assert(!nestedExample.includes("rabbithole-mermaid-runtime"), "Mermaid examples inside outer code fences must not opt into the runtime");
}

function projectionWith(markdown) {
  return {
    format: "rabbithole",
    format_version: 1,
    hole: {
      schema_version: 2,
      hole_id: "conditional-snapshot",
      title: "Conditional snapshot",
      root_id: "root",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      view_state: null,
      nodes: [node("root", null, "Root", markdown, 0)],
    },
    assets: {},
  };
}

function portableFixture() {
  const hostileLabel = '<img src=x onerror="window.__mermaidProbePwned=1">';
  return {
    format: "rabbithole",
    format_version: 1,
    hole: {
      schema_version: 2,
      hole_id: "mermaid-rendering",
      title: "Mermaid rendering",
      root_id: "root",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      view_state: null,
      nodes: [
        node("root", null, "Flowchart", [
          "# Flowchart",
          "",
          "```mermaid",
          "flowchart LR",
          `  A[\"${hostileLabel}\"] --> B[Safe]`,
          '  click A "javascript:window.__mermaidProbePwned=2"',
          "```",
        ].join("\n"), 0),
        node("sequence", "root", "Sequence", [
          "# Sequence",
          "",
          "```mermaid",
          "sequenceDiagram",
          "  participant Human",
          "  participant Rabbithole",
          "  Human->>Rabbithole: Ask",
          "  Rabbithole-->>Human: Branch",
          "```",
        ].join("\n"), 440),
        node("invalid", "root", "Invalid", "```mermaid\nthis is not valid mermaid\n```", 880),
      ],
    },
    assets: {},
  };
}

function node(id, parentId, title, markdown, x) {
  return {
    id,
    parent_id: parentId,
    title,
    markdown,
    base_url: null,
    base_url_source: null,
    origin: null,
    position: { x, y: 0 },
    size: null,
    font_scale: 1,
    collapsed: false,
    status: "answered",
    read: true,
    created_at: "2026-01-01T00:00:00.000Z",
    extensions: {},
  };
}
