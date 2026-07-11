import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium, firefox, webkit } from "playwright";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const server = await serveRoot(ROOT);
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  for (const [name, browserType] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await browserType.launch();
    const context = await browser.newContext({ viewport: { width: 640, height: 480 } });
    const page = await context.newPage();
    await page.goto(baseUrl);
    await verifyLayerAndAnchor(page, name);
    await verifyPopoverAndDialog(page, name);
    await verifyNotice(page, name);
    await verifyFormPrimitivesAndButtons(page, name);
    await context.close();
    await browser.close();
    console.log(`UI primitives browser matrix ${name} passed`);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

async function reset(page, body = "") {
  await page.evaluate((html) => { document.body.innerHTML = html; document.head.innerHTML = ""; }, body);
}

async function verifyLayerAndAnchor(page, engine) {
  await reset(page, '<button id="before">Before</button><button id="trigger">Trigger</button><div id="one"><button>One</button></div><div id="two"><button>Two</button></div><button id="outside">Outside</button>');
  const result = await page.evaluate(async (base) => {
    const { registerLayer } = await import(base + "/src/ui/overlay/layer-stack.js");
    const trigger = document.getElementById("trigger"), one = document.getElementById("one"), two = document.getElementById("two");
    trigger.focus(); const closed = [];
    const unregisterOne = registerLayer({ element: one, trigger, onClose: (reason) => closed.push("one:" + reason) });
    const unregisterTwo = registerLayer({ element: two, trigger, onClose: (reason) => closed.push("two:" + reason) });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    unregisterTwo();
    document.getElementById("outside").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    unregisterOne();
    return { closed, active: document.activeElement.id };
  }, baseUrl);
  assert.deepEqual(result.closed, ["two:escape", "one:outside-pointer"], `${engine}: layers close top-first by Escape/outside pointer`);
  assert.equal(result.active, "trigger", `${engine}: layer teardown restores trigger focus`);

  await reset(page, '<style>#surface,#virtual{position:fixed;width:180px;height:90px;--surface-gap:12px;--surface-edge:16px}</style><button id="anchor" style="position:fixed;left:600px;top:450px;width:30px;height:20px">A</button><div id="surface"></div><div id="virtual"></div>');
  const geometry = await page.evaluate(async (base) => {
    const { anchorSurface } = await import(base + "/src/ui/overlay/anchor.js");
    const surface = document.getElementById("surface"), virtualSurface = document.getElementById("virtual");
    const elementHandle = anchorSurface(document.getElementById("anchor"), surface, { placement: "bottom-end" });
    const virtual = { contextElement: document.body, getBoundingClientRect: () => ({ left: 2, right: 2, top: 2, bottom: 2, width: 0, height: 0 }) };
    const virtualHandle = anchorSurface(virtual, virtualSurface, { placement: "top-start" });
    const value = [surface, virtualSurface].map((el) => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top), placement: el.dataset.placement }));
    elementHandle.dispose(); virtualHandle.dispose(); return value;
  }, baseUrl);
  assert.equal(geometry[0].placement, "top-end", `${engine}: element anchor flips`);
  assert(geometry[0].left >= 16 && geometry[0].top >= 16, `${engine}: element anchor clamps to token edge`);
  assert.equal(geometry[1].placement, "bottom-start", `${engine}: virtual anchor flips`);
  assert.equal(geometry[1].left, 16, `${engine}: virtual anchor clamps with token edge`);
  assert.equal(geometry[1].top, 16, `${engine}: virtual anchor uses token gap before clamping`);
}

async function verifyPopoverAndDialog(page, engine) {
  await reset(page, '<style>#pop{position:fixed;width:120px;height:60px;--surface-gap:8px;--surface-edge:8px}</style><button id="trigger" aria-expanded="false">Open</button><div id="pop"><button id="inside">Inside</button></div>');
  await page.evaluate(async (base) => {
    const { openPopover } = await import(base + "/src/ui/primitives/popover.js");
    window.closedReason = "";
    window.pop = openPopover({ trigger: document.getElementById("trigger"), surface: document.getElementById("pop"), initialFocus: document.getElementById("inside"), onClose: (reason) => { window.closedReason = reason; window.pop.close(); } });
  }, baseUrl);
  await page.waitForTimeout(20);
  assert.equal(await page.getAttribute("#trigger", "aria-expanded"), "true", `${engine}: popover exposes expanded trigger`);
  assert.equal(await page.evaluate(() => document.activeElement.id), "inside", `${engine}: popover applies initial focus`);
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => window.closedReason), "escape", `${engine}: popover delegates Escape to layer stack`);
  assert.equal(await page.evaluate(() => document.activeElement.id), "trigger", `${engine}: popover restores trigger focus`);

  await reset(page, '<button id="trigger">Open</button><div id="backdrop" hidden><section id="dialog" aria-labelledby="title"><h2 id="title">Title</h2><button id="first">First</button><button id="last">Last</button></section></div>');
  const missingLabel = await page.evaluate(async (base) => {
    const { openDialog } = await import(base + "/src/ui/primitives/dialog.js");
    try { openDialog({ dialog: document.createElement("div") }); } catch (error) { return error.message; }
    return "";
  }, baseUrl);
  assert.match(missingLabel, /requires label/, `${engine}: dialog enforces labeling`);
  await page.evaluate(async (base) => {
    const { openDialog } = await import(base + "/src/ui/primitives/dialog.js");
    document.getElementById("trigger").focus(); window.dialogReason = "";
    window.dialogHandle = openDialog({ dialog: document.getElementById("dialog"), backdrop: document.getElementById("backdrop"), trigger: document.getElementById("trigger"), initialFocus: "#first", closeOnBackdrop: true, onClose: (reason) => { window.dialogReason = reason; } });
  }, baseUrl);
  await page.waitForTimeout(20);
  assert.deepEqual(await page.locator("#dialog").evaluate((el) => [el.getAttribute("role"), el.getAttribute("aria-modal"), document.activeElement.id]), ["dialog", "true", "first"], `${engine}: dialog semantics and initial focus`);
  await page.locator("#last").focus(); await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "first", `${engine}: dialog contains Tab`);
  await page.mouse.click(2, 2);
  assert.equal(await page.evaluate(() => window.dialogReason), "backdrop", `${engine}: dialog maps outside pointer to backdrop close`);
  assert.equal(await page.evaluate(() => document.activeElement.id), "trigger", `${engine}: dialog restores trigger focus`);
}

async function verifyNotice(page, engine) {
  await reset(page, '<div id="notice"><span data-notice-title></span><span data-notice-message></span><button data-notice-action hidden></button><button data-notice-dismiss>Dismiss</button></div>');
  const wiring = await page.evaluate(async (base) => {
    const { wireNotice } = await import(base + "/src/ui/primitives/notice.js");
    const el = document.getElementById("notice"), notice = wireNotice(el, { variant: "toast" });
    notice.show({ title: "Saved", message: "Done", actionLabel: "Undo", duration: 1200 });
    el.querySelector("[data-notice-action]").focus(); window.notice = notice;
    return [el.getAttribute("role"), el.getAttribute("aria-live"), el.querySelector("[data-notice-title]").textContent, el.querySelector("[data-notice-action]").hidden];
  }, baseUrl);
  assert.deepEqual(wiring, ["status", "polite", "Saved", false], `${engine}: notice variant wiring`);
  await page.waitForTimeout(1600);
  const visibleWhileFocused = await page.evaluate(() => window.notice.isVisible());
  assert.equal(visibleWhileFocused, true, `${engine}: notice timer pauses while focus is inside (visible=${visibleWhileFocused})`);
  await page.hover("#notice");
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForTimeout(1600);
  const visibleWhileHovered = await page.evaluate(() => window.notice.isVisible());
  assert.equal(visibleWhileHovered, true, `${engine}: notice timer pauses on hover after focus leaves (visible=${visibleWhileHovered})`);
  await page.mouse.move(630, 470);
  await page.waitForFunction(() => !window.notice.isVisible(), { timeout: 4000 });
  const visibleAfterMouseleave = await page.evaluate(() => window.notice.isVisible());
  assert.equal(visibleAfterMouseleave, false, `${engine}: notice timer resumes after hover (visible=${visibleAfterMouseleave})`);
}

async function verifyFormPrimitivesAndButtons(page, engine) {
  await reset(page, '<div id="root"></div>');
  const buttonContracts = await page.evaluate(async (base) => {
    const { buttonMarkup, iconButtonMarkup } = await import(base + "/src/core/html/button-markup.js");
    let iconError = ""; try { iconButtonMarkup({ svgIconHtml: "<svg></svg>" }); } catch (error) { iconError = error.message; }
    document.getElementById("root").innerHTML = buttonMarkup({ label: "Save" }) + iconButtonMarkup({ ariaLabel: "Close", svgIconHtml: "<svg></svg>" });
    return { types: Array.from(document.querySelectorAll("button"), (el) => el.type), name: document.querySelectorAll("button")[1].getAttribute("aria-label"), iconError };
  }, baseUrl);
  assert.deepEqual(buttonContracts.types, ["button", "button"], `${engine}: Button markup fixes type semantics`);
  assert.equal(buttonContracts.name, "Close", `${engine}: IconButton exposes its name`);
  assert.match(buttonContracts.iconError, /requires aria-label/, `${engine}: IconButton rejects unnamed icons`);

  await page.evaluate(async (base) => {
    const [{ comboboxMarkup, wireCombobox }, { fieldMarkup, wireField }] = await Promise.all([
      import(base + "/src/ui/primitives/combobox.js"), import(base + "/src/ui/primitives/field.js")
    ]);
    const root = document.getElementById("root");
    root.innerHTML = '<span id="combo-label">Model</span>' + comboboxMarkup({ id: "combo", labelledBy: "combo-label", value: "", label: "Choose" }) +
      fieldMarkup({ id: "key", label: "Key", type: "password", toggleId: "toggle", toggleHtml: "Show", hint: "Private" });
    wireCombobox(root, { id: "combo", labelledBy: "combo-label", source: { load: () => [{ value: "m1", label: "Model One" }, { value: "m2", label: "Model Two" }], filter: (items, query) => items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())), renderOption: (item, meta) => `<div role="option" data-value="${item.value}" data-label="${item.label}" data-item-index="${meta.index}">${item.label}</div>`, loading: () => "Loading", empty: () => "Empty", error: (retry) => retry } });
    wireField(root, { id: "key", toggleId: "toggle", renderToggle: (visible) => visible ? "Hide" : "Show" });
  }, baseUrl);
  await page.locator("#combo").focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(20);
  assert.equal(await page.getAttribute("#combo-input", "aria-expanded"), "true", `${engine}: Combobox opens with owned input semantics`);
  await page.keyboard.type("two"); await page.keyboard.press("Enter");
  assert.equal(await page.locator("#combo-value").innerText(), "Model Two", `${engine}: Combobox filters and commits by keyboard`);
  assert.equal(await page.getAttribute("#key", "aria-describedby"), "key-hint", `${engine}: Field connects hint description`);
  await page.click("#toggle");
  assert.deepEqual(await page.locator("#toggle").evaluate((el) => [document.getElementById("key").type, el.getAttribute("aria-pressed")]), ["text", "true"], `${engine}: Field password toggle stays synchronized`);
}

async function serveRoot(rootDir) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end("<!doctype html><html><head></head><body></body></html>"); return; }
    const file = path.resolve(rootDir, decodeURIComponent(url.pathname.slice(1)));
    if (!file.startsWith(rootDir)) { res.writeHead(403).end("Forbidden"); return; }
    try { const bytes = await fs.readFile(file); res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/octet-stream", "Cache-Control": "no-store" }); res.end(bytes); }
    catch { res.writeHead(404).end("Not Found"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}
