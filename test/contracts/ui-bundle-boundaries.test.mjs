import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { CANVAS_SHELL } from "../../src/core/html/shell.js";
import { CANVAS_STYLES } from "../../src/core/html/styles.js";

const result = await esbuild.build({
  entryPoints: ["src/ui/frozen-entry.js"],
  bundle: true,
  write: false,
  metafile: true,
  format: "iife",
  platform: "browser",
  target: "es2018",
  external: ["pdfjs-dist/build/pdf.mjs"],
  logLevel: "silent",
});

const inputs = Object.keys(result.metafile.inputs);
const forbidden = inputs.filter((input) =>
  input === "src/ui/transport-status.js"
  || input === "src/ui/snapshot.js"
  || input.startsWith("src/web/")
);

assert.deepEqual(
  forbidden,
  [],
  `frozen UI must not include live host modules (the source-backed PDF viewer is intentionally shared):\n${forbidden.join("\n")}`,
);

const frozenBundle = result.outputFiles[0].text;
const removedActivityUi = `${CANVAS_SHELL}\n${CANVAS_STYLES}\n${frozenBundle}`;
for (const pattern of [
  /id=["']since["']/,
  /while you were away/i,
  /si-new/,
  /pal-dot/,
  /node\.unread/,
  /isUnread/,
  /markRead/,
  /unreadNodes/,
]) {
  assert.doesNotMatch(removedActivityUi, pattern, `removed activity UI must stay absent: ${pattern}`);
}

console.log("ok UI bundle boundaries: frozen client excludes live host modules and removed activity messaging");
