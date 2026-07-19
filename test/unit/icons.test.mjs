import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { BUNNY_MARK_SVG, faviconSvg, iconSvg } from "../../src/core/html/icons.js";

const send = iconSvg("send");
assert.match(send, /^<svg width="14" height="14" /);
assert.match(send, /focusable="false" aria-hidden="true"/);
assert.match(iconSvg("search", { size: 13 }), /^<svg width="13" height="13" /);
assert.notEqual(iconSvg("paste"), iconSvg("file"), "paste and file actions need distinct silhouettes");
assert.equal(BUNNY_MARK_SVG, iconSvg("bunny"));
assert.match(faviconSvg(), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
assert.throws(() => iconSvg("missing"), /Unknown Rabbithole icon/);
assert.throws(() => iconSvg("send", { size: 0 }), /positive number/);

const roots = ["src", "website/about"];
const violations = [];
for (const root of roots) {
  for (const file of await sourceFiles(root)) {
    if (file === "src/core/html/icons.js") continue;
    let source = await fs.readFile(file, "utf8");
    if (file === "src/core/html/shell.js") {
      source = source.replace('<svg id="edges"></svg>', "");
    }
    if (source.includes("<svg")) violations.push(file);
  }
}
assert.deepEqual(
  violations,
  [],
  `product-owned SVG geometry belongs in src/core/html/icons.js:\n${violations.join("\n")}`,
);

console.log("ok icons: canonical markup, validation, and repository boundary");

async function sourceFiles(root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const relative = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(relative));
    else if (/\.(?:js|mjs|html)$/.test(entry.name)) files.push(relative);
  }
  return files;
}
