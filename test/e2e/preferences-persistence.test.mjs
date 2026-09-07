/** @protects durable MCP reader preferences across origins and frozen isolation. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

process.env.RABBITHOLE_NO_BROWSER = "1";
const previousDir = process.env.RABBITHOLE_DIR;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-preferences-e2e-"));
process.env.RABBITHOLE_DIR = dir;
const { buildCanvasHtml } = await import("../../src/node/mcp/http/page.js");
const { RabbitholeSession } = await import("../../src/node/transport/session.js");
const browser = await chromium.launch({ headless: true });

function session(id) {
  return new RabbitholeSession({
    holeId: "preference-e2e-" + id,
    title: "Preference E2E " + id,
    rootId: "root",
    nodes: [{ id: "root", parent_id: null, title: "Root", markdown: "Preference body", status: "answered" }],
    assetNames: new Set(),
    isResume: false,
    renderPage: buildCanvasHtml,
  });
}

async function waitForPreferences(predicate) {
  const file = path.join(dir, "preferences.json");
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const values = JSON.parse(await fs.readFile(file, "utf8")).values;
      if (predicate(values)) return values;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("preferences.json did not reach the expected state");
}

const first = session("a");
const second = session("b");
let firstContext;
let secondContext;
let frozenContext;

try {
  await first.start();
  firstContext = await browser.newContext();
  await firstContext.addInitScript(() => {
    localStorage.setItem("rh-theme", "dark");
  });
  const pageA = await firstContext.newPage();
  await pageA.goto(first.url, { waitUntil: "domcontentloaded" });
  await pageA.locator('.card[data-id="root"] .doc-content').waitFor();
  assert.equal(await pageA.locator("html").getAttribute("data-theme"), "light",
    "an empty machine seed ignores origin-local values and starts from defaults");
  const peer = await firstContext.newPage();
  await peer.goto(first.url, { waitUntil: "domcontentloaded" });
  await peer.locator('.card[data-id="root"] .doc-content').waitFor();

  await pageA.locator("#t-settings").click();
  await pageA.locator('[data-theme-choice="dark"]').click();
  await peer.locator('html[data-theme="dark"]').waitFor();
  await pageA.locator('[data-reading-step="1"]').click();
  await pageA.getByRole("tab", { name: "Canvas" }).click();
  await pageA.locator("[data-tidy-enabled]").check();
  await pageA.getByRole("tab", { name: "Quick questions" }).click();
  await pageA.locator('[data-asking-surface][data-set="selection"] [data-preset-button="explain"]').click();
  await pageA.locator("#asking-selection-explain-label").fill("Across sessions");
  await pageA.locator("#asking-selection-explain-instruction").fill("Use the machine-backed preference.");
  await pageA.locator('[data-asking-surface][data-set="selection"] [data-preset-done]').click();
  await pageA.locator('[data-asking-surface][data-set="selection"] [data-preset-add]').click();
  await pageA.locator("#asking-selection-custom-label").fill("Persistent fourth");
  await pageA.locator("#asking-selection-custom-instruction").fill("Carry the fourth slot across origins.");
  await pageA.locator('[data-asking-surface][data-set="selection"] [data-preset-done]').click();
  await pageA.locator('[data-asking-surface][data-set="selection"] [data-reaction-button="up"]').click();
  await pageA.locator('[data-reaction-prompt="up"] [data-reaction-instruction]').fill(
    "Keep this exact machine-backed approach.",
  );

  const persisted = await waitForPreferences((values) => {
    if (values["rh-theme"] !== "dark" || values["rh-reading-scale"] !== "1.1" || values["rh-auto-tidy"] !== "on") return false;
    try {
      return JSON.parse(values["rh-ask-presets-v1"]).selection.custom?.label === "Persistent fourth"
        && JSON.parse(values["rh-reaction-prompts-v1"]).up?.instruction
          === "Keep this exact machine-backed approach.";
    } catch {
      return false;
    }
  });
  assert.equal(JSON.parse(persisted["rh-ask-presets-v1"]).selection.explain.instruction,
    "Use the machine-backed preference.");
  assert.equal(JSON.parse(persisted["rh-ask-presets-v1"]).selection.custom.instruction,
    "Carry the fourth slot across origins.");
  assert.equal(await pageA.evaluate(() => localStorage.getItem("rh-reading-scale")), null,
    "host-backed preferences never write to the random origin");

  await second.start();
  assert.notEqual(first.url, second.url);
  secondContext = await browser.newContext();
  const pageB = await secondContext.newPage();
  await pageB.goto(second.url, { waitUntil: "domcontentloaded" });
  await pageB.locator('.card[data-id="root"] .doc-content').waitFor();
  assert.equal(await pageB.locator("html").getAttribute("data-theme"), "dark");
  assert.equal(await pageB.locator('.card[data-id="root"] .doc-content').evaluate((node) => getComputedStyle(node).fontSize), "15px");
  await pageB.locator("#t-settings").click();
  await pageB.getByRole("tab", { name: "Canvas" }).click();
  assert.equal(await pageB.locator("[data-tidy-enabled]").isChecked(), true);
  await pageB.getByRole("tab", { name: "Quick questions" }).click();
  assert.equal(
    await pageB.locator('[data-asking-surface][data-set="selection"] [data-preset-button="explain"]').evaluate((button) =>
      button.firstChild?.nodeValue),
    "Across sessions ",
    "Quick-question customization follows the reader to the new random origin",
  );
  assert.equal(
    await pageB.locator('[data-asking-surface][data-set="selection"] [data-preset-button="custom"]').evaluate((button) =>
      button.firstChild?.nodeValue),
    "Persistent fourth ",
    "the optional slot follows the reader to the new random origin",
  );
  await pageB.locator('[data-asking-surface][data-set="selection"] [data-reaction-button="up"]').click();
  assert.equal(await pageB.locator('[data-reaction-prompt="up"] [data-reaction-instruction]').inputValue(),
    "Keep this exact machine-backed approach.",
    "reaction instructions use the same host-persisted preference backing");

  const frozenHtml = await (await fetch(second.url + "/export")).text();
  assert.equal(frozenHtml.includes("Across sessions"), false);
  assert.equal(frozenHtml.includes("Use the machine-backed preference."), false);
  assert.equal(frozenHtml.includes("Persistent fourth"), false);
  assert.equal(frozenHtml.includes("Keep this exact machine-backed approach."), false);
  frozenContext = await browser.newContext();
  const frozenPage = await frozenContext.newPage();
  await frozenPage.setContent(frozenHtml, { waitUntil: "load" });
  await frozenPage.locator("#t-settings").click();
  assert.deepEqual(await frozenPage.locator("[data-settings-section]").allInnerTexts(), ["Appearance", "Quick questions"]);
  await frozenPage.getByRole("tab", { name: "Quick questions" }).click();
  assert.equal(await frozenPage.locator('[data-asking-surface][data-set="selection"] [data-preset-button="explain"]').evaluate((button) =>
    button.firstChild?.nodeValue), "Explain ", "a frozen file uses its own default preference backing");
  assert.equal(await frozenPage.locator('[data-asking-surface][data-set="selection"] [data-preset-button="custom"]').count(), 0);
  await frozenPage.locator('[data-asking-surface][data-set="selection"] [data-reaction-button="up"]').click();
  assert.equal(await frozenPage.locator('[data-reaction-prompt="up"] [data-reaction-instruction]').inputValue(),
    "This landed well — use a similar approach.");
} finally {
  await Promise.allSettled([frozenContext?.close(), secondContext?.close(), firstContext?.close()]);
  await Promise.allSettled([first.close("preferences_e2e_complete"), second.close("preferences_e2e_complete")]);
  await browser.close();
  if (previousDir === undefined) delete process.env.RABBITHOLE_DIR;
  else process.env.RABBITHOLE_DIR = previousDir;
  await fs.rm(dir, { recursive: true, force: true });
}

console.log("durable MCP reader preferences browser journey ok");
