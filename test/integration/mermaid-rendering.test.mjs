import assert from "node:assert/strict";
import { buildSnapshotHtml } from "../../src/core/snapshot-html.js";
import { createNoraSnapshotProjection } from "../../src/core/snapshot-projection.js";
import { baseHydration, bootNoraWebview } from "../support/webview-harness.mjs";
import { readWebviewAsset } from "../support/nora-webview-assets.mjs";

const app = await bootNoraWebview();
const { browser, page } = app;

try {
  const snapshot = await buildMermaidSnapshot();
  await verifyNoraWebview();
  await verifyOfflineSnapshot(snapshot);
  verifyConditionalSnapshotAssembly();
  console.log("ok Mermaid: Nora webview fullscreen controls, strict rendering, theme refresh, and offline snapshots");
} finally {
  await app.close();
}

async function verifyNoraWebview() {
  const requests = [];
  page.on("request", (request) => {
    requests.push(request.url());
  });
  await app.hydrate(baseHydration({
    title: "Mermaid rendering",
    view_state: { mode: "reader", node_id: "root", scroll: 0 },
    nodes: mermaidHydrationNodes(),
  }));
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
  assert.equal(requests.filter((url) => /\/mermaid\.js(?:\?|$)/.test(url)).length, 1, "all live diagrams should share one Nora webview lazy runtime load");

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
  assert(safe.fallbackText.includes("this is not valid mermaid"));

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
      svgWidth: svgRect.width,
      hostContain: getComputedStyle(mount).contain,
    };
  });
  assert.equal(inlineLayout.intersects, false, `inline expand control must not cover the rendered SVG (${JSON.stringify(inlineLayout)})`);
  assert(inlineLayout.svgWidth <= inlineLayout.clientWidth + 1, `fitted Mermaid SVG should not require frame scrolling (${JSON.stringify(inlineLayout)})`);
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
  const surfacePoint = {
    x: surfaceBox.x + surfaceBox.width / 2,
    y: surfaceBox.y + Math.min(80, surfaceBox.height / 3),
  };
  await page.mouse.click(surfacePoint.x, surfacePoint.y);
  await page.waitForSelector(".rh-lightbox .rh-lightbox-diagram");
  await page.mouse.click(5, 5);
  await page.waitForSelector(".rh-lightbox", { state: "detached" });

  await page.mouse.move(surfacePoint.x, surfacePoint.y);
  await page.mouse.down();
  await page.mouse.move(surfacePoint.x + 10, surfacePoint.y);
  await page.mouse.up();
  await page.waitForTimeout(50);
  assert.equal(await page.locator(".rh-lightbox").count(), 0, "dragging across a Mermaid diagram must not open fullscreen");

  assert.equal(requests.filter((url) => /\/mermaid\.js(?:\?|$)/.test(url)).length, 1, "Nora snapshot export is extension-owned and must not make a second webview runtime request");
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
    frozenClientSource: "window.NoraFrozenClient={startPortableSnapshot:function(){}};",
  };
  const without = buildSnapshotHtml({ ...common, snapshotProjection: noraProjectionWith("Plain prose") });
  assert(!without.includes("nora-mermaid-runtime"), "ordinary snapshots must not embed Mermaid");
  assert.throws(
    () => buildSnapshotHtml({ ...common, snapshotProjection: noraProjectionWith("```mermaid\nflowchart LR\nA-->B\n```") }),
    /Mermaid runtime is unavailable/,
  );
  const nestedExample = buildSnapshotHtml({
    ...common,
    snapshotProjection: noraProjectionWith("````markdown\n```mermaid\nA-->B\n```\n````"),
  });
  assert(!nestedExample.includes("nora-mermaid-runtime"), "Mermaid examples inside outer code fences must not opt into the runtime");
}

async function buildMermaidSnapshot() {
  const projection = createNoraSnapshotProjection(noraDocumentFromNodes(mermaidHydrationNodes()), { mode: "reader", node_id: "root", scroll: 0 }, {});
  const stylesheetText = [
    await readWebviewAsset("canvas.css"),
    await readWebviewAsset("katex.css"),
  ].join("\n");
  return buildSnapshotHtml({
    title: "Mermaid rendering",
    stylesheetText,
    dompurifySource: await readWebviewAsset("dompurify.js"),
    mermaidSource: await readWebviewAsset("mermaid.js"),
    frozenClientSource: await readWebviewAsset("frozen-client.js"),
    snapshotProjection: projection,
  });
}

function noraProjectionWith(markdown) {
  return createNoraSnapshotProjection(noraDocumentFromNodes([node("root", null, "Root", markdown, 0)]), { mode: "reader", node_id: "root", scroll: 0 }, {});
}

function mermaidHydrationNodes() {
  return [
    node("root", null, "Diagrams", [
      "# Diagrams",
      "",
      "```mermaid",
      "graph TD; A-->B;",
      "```",
      "",
      "```mermaid",
      "graph LR; C-->D;",
      "```",
      "",
      "```mermaid",
      "this is not valid mermaid <img src=x onerror=window.__mermaidProbePwned=1>",
      "```",
    ].join("\n"), 440),
  ];
}

function noraDocumentFromNodes(nodes) {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    documentId: "mermaid-rendering",
    title: "Mermaid rendering",
    rootNodeId: "root",
    createdAt: now,
    updatedAt: now,
    viewState: { mode: "reader", node_id: "root", scroll: 0 },
    selection: null,
    selectedProfileId: null,
    nodes: nodes.map((entry) => ({
      id: entry.id,
      parentId: entry.parent_id,
      title: entry.title,
      markdown: entry.markdown,
      baseUrl: null,
      baseUrlSource: null,
      origin: null,
      position: entry.position,
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
    })),
    edges: nodes
      .filter((entry) => entry.parent_id)
      .map((entry) => ({
        id: `edge:${entry.parent_id}:${entry.id}`,
        fromNodeId: entry.parent_id,
        toNodeId: entry.id,
        kind: "branch",
        createdAt: now,
        extensions: {},
      })),
    sources: [],
    evidence: [],
    attachments: [],
    runs: [],
    checks: [],
    extensions: {},
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
