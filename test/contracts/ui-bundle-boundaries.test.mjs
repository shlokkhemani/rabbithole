import assert from "node:assert/strict";
import fs from "node:fs/promises";
import * as esbuild from "esbuild";

const result = await esbuild.build({
  entryPoints: ["src/ui/frozen-entry.js"],
  bundle: true,
  write: false,
  metafile: true,
  format: "iife",
  platform: "browser",
  target: "es2018",
  logLevel: "silent",
});

const inputs = Object.keys(result.metafile.inputs);
const forbidden = inputs.filter((input) =>
  input === "src/ui/transport-status.js"
  || input === "src/ui/snapshot.js"
  || input === "src/ui/pdf-view.js"
  || input.startsWith("src/web/")
);

assert.deepEqual(
  forbidden,
  [],
  `frozen UI must not include live host modules:\n${forbidden.join("\n")}`,
);

const liveResult = await esbuild.build({
  entryPoints: ["src/ui/entry.js"],
  bundle: true,
  write: false,
  metafile: true,
  format: "iife",
  platform: "browser",
  target: "es2018",
  logLevel: "silent",
});
const liveInputs = Object.keys(liveResult.metafile.inputs);
assert.equal(
  liveInputs.some((input) => input.includes("@mermaid-js/")),
  false,
  "live UI must lazy-load Mermaid instead of bundling its parser into every canvas",
);
const mermaidBundle = await fs.readFile("dist/mermaid.js", "utf8");
assert(mermaidBundle.includes('globalThis["mermaid"]'), "build should emit the standalone Mermaid browser runtime");

console.log("ok UI bundle boundaries: frozen client excludes live host modules and Mermaid stays in its lazy runtime");
