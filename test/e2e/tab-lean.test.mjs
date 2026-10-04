/** @protects a deep trail's ancestor slivers name themselves under the pointer: the pointed tab leans open to a titled tab while its neighbours give up the room, so nothing else on the stage moves. */
// Failure modes, written before the lean was built; assertion messages carry
// the labels.
//   L1 pointing at a sliver leaves it a sliver: its name is never shown
//   L2 the lean widens the edge: the open panes shift (or re-wrap) under it
//   L3 the neighbours collapse to nothing or pile onto each other
//   L4 moving along the edge leaves the last tab open, or two tabs open at once
//   L5 leaving the edge leaves the tabs anywhere but where they rested
//   L6 mid-motion the open panes jitter, even for a frame
//   L7 clicking a leaning tab no longer opens its document, or the trail
//      settles with a tab still leaning
//   L8 a tab reached from the keyboard stays a nameless sliver
// Ends by writing test-artifacts/tab-lean/trace.json and a screenshot per stage.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { routeProvider, seedConfiguredOpenRouter } from "../support/provider-mock.mjs";
import { selectVisibleText } from "../support/visible-selection.mjs";
import { bootWebApp, ROOT } from "../support/web-app-harness.mjs";

const ARTIFACTS = path.join(ROOT, "test-artifacts", "tab-lean");
const trace = { stages: [] };
const words = (seed, count) => Array.from({ length: count }, (_, i) => `${seed}${i}`).join(" ");
const ROOT_DOC = `# The root of it all\n\nWhere the trail begins. ${words("root", 80)}\n\n${words("rootb", 200)}`;
const TITLES = ["First answer", "Second answer", "Third answer", "Fourth answer", "Fifth answer", "Sixth answer"];
const answer = (title, seed) => [`# ${title}\n\n`, `${title} opens here. ${words(seed, 60)}\n\n`, `${words(seed + "b", 200)}\n`];

await fs.rm(ARTIFACTS, { recursive: true, force: true });
const app = await bootWebApp();
try {
  const context = await app.browser.newContext({ viewport: { width: 1440, height: 900 } });
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await routeProvider(page, { streams: TITLES.map((title, i) => answer(title, "a" + i)) });
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.evaluate((markdown) => window.__rabbitholeTest.createDocument(markdown), ROOT_DOC);
  await page.waitForSelector(".card.root .doc-content", { state: "visible" });
  await page.evaluate(() => document.querySelector(".card.root [aria-label='Expand document']").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));

  // Six asks, each from the newest answer: two open, five ancestors as slivers.
  let source = await page.locator(".reader-pane").first().getAttribute("data-node-id");
  let from = "Where the trail begins";
  for (let i = 0; i < TITLES.length; i++) {
    await selectVisibleText(page, { text: from, rootSelector: `.reader-pane[data-node-id="${source}"] .doc-content` });
    await page.fill("#ask-text", `Question ${i + 1}?`);
    await page.keyboard.press("Meta+Enter");
    await page.waitForFunction((t) => [...document.querySelectorAll(".reader-pane .doc-content h1")].some((h) => h.textContent === t), TITLES[i]);
    await settle(page);
    source = await page.locator(".reader-pane:not(.pane-leaving)").last().getAttribute("data-node-id");
    from = `${TITLES[i]} opens here`;
  }
  await page.mouse.move(900, 450);
  const rest = await stage("deep trail at rest", page);
  const slivers = rest.tabs;
  assert(slivers.length >= 4, `a deep trail folds its ancestors into tabs: ${JSON.stringify(rest)}`);
  assert(slivers.every((t) => !t.titled), `the precondition: every tab is a sliver: ${JSON.stringify(slivers)}`);

  // ------------------------------------------------------------- point at one
  const target = 2;
  const motion = recordMotion(page);
  await pointAt(page, slivers[target]);
  const leaned = await stage("pointing at a sliver leans it open", page);
  const frames = await motion;
  const tab = leaned.tabs[target];
  assert(tab.titled && tab.titleOpacity > 0.99 && Math.abs(tab.w - 40) < 0.6, `L1 the pointed sliver opens to a titled tab: ${JSON.stringify(tab)}`);
  assert.equal(tab.title, "Show " + rest.tabs[target].name, "L1 the tab shows its own document's name");
  assertEdgeKept(rest, leaned, "L2");
  for (let i = 0; i < leaned.tabs.length; i++) {
    const t = leaned.tabs[i];
    if (i !== target) assert(t.w > 2 && !t.titled, `L3 every other tab stays a sliver with room of its own: ${JSON.stringify(leaned.tabs)}`);
    if (i) assert(t.x >= leaned.tabs[i - 1].x + leaned.tabs[i - 1].w - 0.5, `L3 tabs sit side by side, in order: ${JSON.stringify(leaned.tabs)}`);
  }
  assert(frames.length >= 4, `the lean is animated, not a jump: ${frames.length} frames`);
  assert(frames.every((f) => f === frames[0]), `L6 the open panes hold still on every frame of the lean: ${JSON.stringify([...new Set(frames)])}`);

  // ----------------------------------------------------------- move along it
  await pointAt(page, leaned.tabs[target + 1]);
  const handed = await stage("moving along the edge hands the lean over", page);
  const titledNow = handed.tabs.filter((t) => t.titled);
  assert.equal(titledNow.length, 1, `L4 one tab leans at a time: ${JSON.stringify(handed.tabs)}`);
  assert.equal(handed.tabs.indexOf(titledNow[0]), target + 1, `L4 the lean follows the pointer: ${JSON.stringify(handed.tabs)}`);
  assertEdgeKept(rest, handed, "L2");

  // ----------------------------------------------------------- leave the edge
  await page.mouse.move(900, 450);
  const back = await stage("leaving the edge lets go", page);
  assert.deepEqual(back.tabs.map((t) => [t.x, t.w]), rest.tabs.map((t) => [t.x, t.w]), `L5 every tab returns to its resting place: ${JSON.stringify(back.tabs)}`);
  assertEdgeKept(rest, back, "L5");

  // ------------------------------------------------------------ keyboard
  await page.keyboard.press("Shift"); // the last input is a key: focus shows
  await page.locator(".reader-pane .pane-spine").nth(1).evaluate((el) => el.focus());
  const keyed = await stage("a tab focused from the keyboard leans open", page);
  assert(keyed.tabs[1].titled && Math.abs(keyed.tabs[1].w - 40) < 0.6, `L8 a keyboard-focused tab leans open: ${JSON.stringify(keyed.tabs)}`);
  assertEdgeKept(rest, keyed, "L8");
  await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
  const unkeyed = await stage("blurring lets it go", page);
  assert.deepEqual(unkeyed.tabs.map((t) => [t.x, t.w]), rest.tabs.map((t) => [t.x, t.w]), `L8 leaving the tab lets it go: ${JSON.stringify(unkeyed.tabs)}`);

  // ------------------------------------------------------- click a leaned tab
  await pointAt(page, back.tabs[target]);
  await stage("pointing again", page);
  const leanedAgain = await geometry(page);
  await page.mouse.click(leanedAgain.tabs[target].x + 20, 450);
  await page.mouse.move(900, 450);
  const opened = await stage("clicking the leaning tab opens its document", page);
  const name = rest.tabs[target].name;
  assert(opened.open.some((p) => p.name === name), `L7 the clicked tab's document opens: ${JSON.stringify(opened.open)}`);
  const widths = new Set(opened.tabs.map((t) => t.w));
  assert(widths.size <= 1, `L7 the trail settles with no tab leaning: ${JSON.stringify(opened.tabs)}`);

  assert.deepEqual(errors, [], "no page errors");
  await context.close();
} finally {
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await fs.writeFile(path.join(ARTIFACTS, "trace.json"), `${JSON.stringify(trace, null, 2)}\n`);
  await app.close();
}
console.log("ok e2e tab lean: a sliver names itself under the pointer and nothing else moves");

// ---------------------------------------------------------------------------
async function geometry(page) {
  return page.evaluate(() => {
    const stageEl = document.getElementById("reader-main");
    const s = stageEl.getBoundingClientRect();
    const round = (v) => Math.round(v * 100) / 100;
    const panes = [...stageEl.querySelectorAll(".reader-pane:not(.pane-leaving)")].map((el) => {
      const r = el.getBoundingClientRect();
      const spine = el.querySelector(".pane-spine");
      const title = spine.querySelector(".pane-spine-title");
      return {
        name: el.getAttribute("aria-label"),
        title: spine.getAttribute("aria-label"),
        folded: el.classList.contains("pane-folded"),
        x: round(r.left - s.left),
        w: round(spine.getBoundingClientRect().width),
        colX: round(el.querySelector(".reader-col").getBoundingClientRect().left - s.left),
        titled: !spine.classList.contains("pane-spine-sliver"),
        titleOpacity: Number(getComputedStyle(title).opacity),
      };
    });
    const firstOpen = panes.findIndex((p) => !p.folded);
    return { tabs: panes.slice(0, firstOpen), open: panes.filter((p) => !p.folded) };
  });
}

async function stage(name, page) {
  await settle(page);
  // Let the title's fade finish as well as the motion.
  await page.waitForTimeout(200);
  const g = await geometry(page);
  const file = `${String(trace.stages.length + 1).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-")}.png`;
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, file), clip: { x: 0, y: 0, width: 360, height: 900 } });
  trace.stages.push({ name, screenshot: file, tabs: g.tabs.map(({ name, title, ...rest }) => rest), open: g.open.map((p) => ({ x: p.x, colX: p.colX })) });
  return g;
}

function assertEdgeKept(before, after, label) {
  assert.deepEqual(
    after.open.map((p) => [p.x, p.colX]),
    before.open.map((p) => [p.x, p.colX]),
    `${label} the open panes and their text stay exactly where they were: ${JSON.stringify(after.open)}`,
  );
  const edge = (g) => g.tabs.reduce((sum, t) => sum + t.w, 0);
  assert(Math.abs(edge(after) - edge(before)) < 0.1, `${label} the edge keeps its width: ${edge(before)} → ${edge(after)}`);
}

// The pointer rests on a tab's visible strip, mid-height.
async function pointAt(page, tab) {
  await page.mouse.move(tab.x + Math.max(1, tab.w / 2), 450, { steps: 2 });
}

// Every frame's transform of the open panes, for the next 600ms.
function recordMotion(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const seen = [];
        const start = performance.now();
        const tick = () => {
          const open = [...document.querySelectorAll(".reader-pane:not(.pane-leaving):not(.pane-folded)")];
          seen.push(open.map((p) => p.style.transform + p.style.width).join("|"));
          if (performance.now() - start < 600) requestAnimationFrame(tick);
          else resolve(seen);
        };
        requestAnimationFrame(tick);
      }),
  );
}

// Wait until no pane or tab has moved for 250ms.
async function settle(page) {
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__leanSince = performance.now();
    w.__leanLast = null;
  });
  await page.waitForFunction(
    () => {
      const now = [...document.querySelectorAll(".reader-pane")].map((p) => p.style.transform + p.style.width + p.querySelector(".pane-spine").style.width).join("|");
      const w = /** @type {any} */ (window);
      if (w.__leanLast !== now) {
        w.__leanLast = now;
        w.__leanSince = performance.now();
      }
      return performance.now() - w.__leanSince >= 250;
    },
    null,
    { polling: "raf", timeout: 5000 },
  );
}
