import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VSIX = path.join(ROOT, "artifacts", "nora.vsix");

await execFileAsync("npm", ["run", "package:vsix"], { cwd: ROOT, maxBuffer: 60 * 1024 * 1024 });
await fs.access(VSIX);

const entries = await readVsix(VSIX);
const paths = new Set(entries.map((entry) => entry.path));

for (const required of [
  "extension/package.json",
  "extension/LICENSE.txt",
  "extension/readme.md",
  "extension/out/extension.cjs",
  "extension/out/extension.cjs.LEGAL.txt",
  "extension/out/webview/nora-entry.js",
  "extension/out/webview/nora-entry.js.LEGAL.txt",
  "extension/out/webview/frozen-client.js",
  "extension/out/webview/frozen-client.js.LEGAL.txt",
  "extension/out/webview/canvas.css",
  "extension/out/webview/katex.css",
  "extension/out/webview/dompurify.js",
  "extension/out/webview/mermaid.js",
  "extension/out/webview/pdf.mjs",
  "extension/out/webview/pdf.worker.mjs",
]) {
  assert(paths.has(required), `VSIX missing ${required}`);
}

const manifest = JSON.parse(String(entries.find((entry) => entry.path === "extension/package.json")?.content || ""));
assert.equal(manifest.name, "nora");
assert.equal(manifest.displayName, "Nora");
assert.equal(manifest.publisher, "r13v");
assert.equal(manifest.main, "./out/extension.cjs");
assert.equal(manifest.engines.vscode, "^1.130.0");
assert.equal(manifest.browser, undefined);

const forbidden = [...paths].filter((entry) =>
  /^extension\/(?:bin|dist|src\/node|src\/web|web|website|workers)\//.test(entry)
  || /\.(?:node|so|dylib|dll)$/i.test(entry)
  || /(?:^|\/)(?:@napi-rs\/canvas|@mariozechner\/clipboard[^/]*)\//.test(entry)
  || /\.env(?:\.|$)/.test(entry)
  || /\.rabbithole$/.test(entry)
);
assert.deepEqual(forbidden, [], `VSIX contains forbidden entries:\n${forbidden.join("\n")}`);

console.log(`ok vsix contents: asserted ${paths.size} package entries`);

/** @param {string} filePath */
function readVsix(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (openError, zip) => {
      if (openError) {
        reject(openError);
        return;
      }
      const entries = [];
      zip.readEntry();
      zip.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            reject(streamError);
            return;
          }
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            entries.push({ path: entry.fileName, content: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(entries));
      zip.on("error", reject);
    });
  });
}
