import assert from "node:assert/strict";
import * as esbuild from "esbuild";

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

console.log("ok UI bundle boundaries: frozen client excludes live transport, snapshot export, and web host modules");
