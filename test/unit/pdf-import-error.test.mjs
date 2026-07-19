import assert from "node:assert/strict";
import { describePdfImportFailure } from "../../src/web/ingest/pdf.js";

const moduleFailure = describePdfImportFailure(new TypeError(
  "Failed to fetch dynamically imported module: http://127.0.0.1:50455/chunks/pdf-deadbeef.js",
));
assert.equal(
  moduleFailure,
  "PDF import couldn't start because part of Rabbithole failed to load. Reload Rabbithole and try again — your PDF is not the problem.",
);
assert.equal(moduleFailure.includes("deadbeef"), false, "an infrastructure failure must not expose internal chunk URLs");
assert.equal(moduleFailure.includes("Try a different PDF"), false, "an infrastructure failure must not blame the selected PDF");

const invalidPdf = describePdfImportFailure(new Error("selected file could not be opened by pdf.js"));
assert.equal(invalidPdf, "PDF import failed. selected file could not be opened by pdf.js Try a different PDF.");

console.log("ok PDF import errors: infrastructure failures never blame the selected file");
