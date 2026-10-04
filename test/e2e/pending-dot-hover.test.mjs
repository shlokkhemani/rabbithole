/** @protects a pending answer's dot keeps turning whatever the pointer does: hovering its text or the dot itself lights the pair without stopping the turn. */
// Failure modes, written before the fix; assertion messages carry the labels.
//   D1 hovering the asked text freezes the turning dot (the hover's growth and
//      the turn fought over one property: the growth's transition won)
//   D2 hovering the dot itself freezes it the same way
//   D3 the pair stops lighting: hovering the text no longer grows its dot
//   D4 leaving the text leaves the dot grown, or stopped
// Ends by writing test-artifacts/pending-dot-hover/trace.json.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { routeProvider, seedConfiguredOpenRouter } from "../support/provider-mock.mjs";
import { selectVisibleText } from "../support/visible-selection.mjs";
import { bootWebApp, ROOT } from "../support/web-app-harness.mjs";

const ARTIFACTS = path.join(ROOT, "test-artifacts", "pending-dot-hover");
const trace = [];
const words = (seed, n) => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(" ");
const ROOT_DOC = `# Root document\n\nThe asked sentence sits here. ${words("r", 60)}\n\n${words("s", 200)}`;

await fs.rm(ARTIFACTS, { recursive: true, force: true });
const app = await bootWebApp();
try {
  const context = await app.browser.newContext({ viewport: { width: 1440, height: 900 } });
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The answer never arrives while the test runs: its dot stays pending.
  await routeProvider(page, { providerDelayMs: 120000 });
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.evaluate((markdown) => window.__rabbitholeTest.createDocument(markdown), ROOT_DOC);
  await page.waitForSelector(".card.root .doc-content", { state: "visible" });
  await page.evaluate(() => document.querySelector(".card.root [aria-label='Expand document']").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  const rootId = await page.locator(".reader-pane").first().getAttribute("data-node-id");
  await selectVisibleText(page, { text: "The asked sentence sits here", rootSelector: `.reader-pane[data-node-id="${rootId}"] .doc-content` });
  await page.fill("#ask-text", "Why?");
  await page.keyboard.press("Meta+Enter");
  const dot = page.locator(".branch-dot-pending:visible").first();
  await dot.waitFor();
  const childId = await dot.getAttribute("data-note");
  const mark = page.locator(`.reader-pane[data-node-id="${rootId}"] mark[data-child="${childId}"]`).first();
  // Let the answer's pane finish sliding in before pointing at anything.
  await page.waitForTimeout(1200);

  const away = await sample(page, dot);
  await mark.hover();
  const onText = await sample(page, dot);
  await dot.hover();
  const onDot = await sample(page, dot);
  await page.mouse.move(5, 450);
  const left = await sample(page, dot);
  trace.push({ away, onText, onDot, left });

  assert(away.turned > 5, `the pending dot turns on its own: ${JSON.stringify(away)}`);
  assert(onText.turned > 5, `D1 hovering the asked text leaves the dot turning: ${JSON.stringify(onText)}`);
  assert(onDot.turned > 5, `D2 hovering the dot leaves it turning: ${JSON.stringify(onDot)}`);
  assert(onText.scale > 1.2, `D3 hovering the asked text lights its dot: ${JSON.stringify(onText)}`);
  assert(left.turned > 5 && Math.abs(left.scale - 1) < 0.01, `D4 leaving the text returns the dot, still turning: ${JSON.stringify(left)}`);
  assert.deepEqual(errors, [], "no page errors");
} finally {
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await fs.writeFile(path.join(ARTIFACTS, "trace.json"), `${JSON.stringify(trace, null, 2)}\n`);
  await app.close();
}
console.log("ok e2e pending dot hover: a pending dot keeps turning under the pointer");

// How far the dot turns over 240ms once any hover transition has run, and its
// size then. Angle and size are read from the drawn circle, whichever CSS
// property carries them.
async function sample(page, dot) {
  await page.waitForTimeout(300);
  return dot.evaluate(async (el) => {
    const read = () => {
      const style = getComputedStyle(el, "::after");
      const m = new DOMMatrix(style.transform === "none" ? undefined : style.transform);
      const rotate = style.rotate === "none" ? 0 : parseFloat(style.rotate) || 0;
      const scaleProp = style.scale === "none" ? 1 : parseFloat(style.scale) || 1;
      return { angle: (Math.atan2(m.b, m.a) * 180) / Math.PI + rotate, scale: Math.hypot(m.a, m.b) * scaleProp };
    };
    const a = read();
    await new Promise((resolve) => setTimeout(resolve, 240));
    const b = read();
    const turned = (((b.angle - a.angle) % 360) + 360) % 360;
    return { turned: Math.round(turned), scale: Math.round(b.scale * 100) / 100 };
  });
}
