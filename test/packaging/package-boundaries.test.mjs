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
const ROOT_TOKEN = path.resolve(ROOT).replaceAll(path.sep, "/");

await ensureVsix();

const entries = await readVsix(VSIX);
const paths = entries.map((entry) => entry.path).sort();
const forbiddenEntries = paths.filter((entry) =>
  /^extension\/(?:bin|dist|src|web|website|workers)\//.test(entry)
  || /^extension\/(?:build\.mjs|scripts\/|test\/|docs\/)/.test(entry)
  || /\.(?:node|so|dylib|dll|map)$/i.test(entry)
  || /(?:^|\/)(?:@napi-rs\/canvas|@mariozechner\/clipboard[^/]*)\//.test(entry)
  || /\.env(?:\.|$)/.test(entry)
  || /\.rabbithole$/i.test(entry)
);
assert.deepEqual(forbiddenEntries, [], `VSIX contains forbidden entries:\n${forbiddenEntries.join("\n")}`);

const outsideAllowlist = paths.filter((entry) => !isAllowedVsixEntry(entry));
assert.deepEqual(outsideAllowlist, [], `VSIX contains entries outside the package allowlist:\n${outsideAllowlist.join("\n")}`);

const runtimeText = entries
  .filter((entry) => isTextEntry(entry.path) && entry.path !== "extension/readme.md" && entry.path !== "extension/LICENSE.txt")
  .map((entry) => [entry.path, entry.content.toString("utf8")]);
const contentFailures = [];
for (const [entryPath, text] of runtimeText) {
  if (/rabbithole|\.rabbithole|open_rabbithole|answer_branch|list_rabbitholes|IndexedDB|RABBITHOLE_[A-Z0-9_]+/i.test(text)) {
    contentFailures.push(`${entryPath}: legacy host token`);
  }
  if (ROOT_TOKEN && text.replaceAll(path.sep, "/").includes(ROOT_TOKEN)) {
    contentFailures.push(`${entryPath}: local source path`);
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) || /\b(?:sk|ghp|xox[baprs])-[A-Za-z0-9_-]{20,}\b/.test(text)) {
    contentFailures.push(`${entryPath}: credential-shaped text`);
  }
}
assert.deepEqual(contentFailures, [], `VSIX content boundary failures:\n${contentFailures.join("\n")}`);

const generatedStatus = await execFileAsync("git", ["status", "--short", "--", "out", "artifacts", "dist", "web/dist"], {
  cwd: ROOT,
  encoding: "utf8",
});
assert.equal(generatedStatus.stdout.trim(), "", "generated build/package outputs must stay ignored and untracked");

console.log(`ok package boundaries: scanned ${paths.length} VSIX entries against runtime allowlist and leak checks`);

async function ensureVsix() {
  if (await exists(VSIX)) return;
  await execFileAsync("npm", ["run", "package:vsix"], { cwd: ROOT, maxBuffer: 60 * 1024 * 1024 });
}

function isAllowedVsixEntry(entry) {
  return entry === "[Content_Types].xml"
    || entry === "extension.vsixmanifest"
    || entry === "extension/package.json"
    || entry === "extension/LICENSE.txt"
    || entry === "extension/readme.md"
    || /^extension\/out\/extension\.cjs(?:\.LEGAL\.txt)?$/.test(entry)
    || entry === "extension/out/extension.metafile.json"
    || /^extension\/out\/(?:LICENSE\.photon-node\.md|photon_rs_bg\.wasm)$/.test(entry)
    || /^extension\/out\/webview\/(?:nora-entry|frozen-client)\.js(?:\.LEGAL\.txt)?$/.test(entry)
    || /^extension\/out\/webview\/(?:canvas|katex)\.css$/.test(entry)
    || /^extension\/out\/webview\/(?:dompurify|mermaid)\.js$/.test(entry)
    || /^extension\/out\/webview\/pdf(?:\.worker)?\.mjs$/.test(entry)
    || /^extension\/out\/webview\/cmaps\/[A-Za-z0-9_.-]+\.bcmap$/.test(entry)
    || /^extension\/out\/webview\/standard_fonts\/[A-Za-z0-9_.-]+$/.test(entry);
}

function isTextEntry(entry) {
  return /\.(?:cjs|js|json|css|md|txt|mjs)$/i.test(entry);
}

async function exists(filePath) {
  return !!await fs.stat(filePath).catch(() => null);
}

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
          stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
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
