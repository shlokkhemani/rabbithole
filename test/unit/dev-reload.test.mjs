/** @protects dev reload capability contracts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModuleTreeLoader, createSourceReader, devEnabled } from "../../src/node/html/dev-reload.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rabbithole-dev-reload-"));
const filePath = path.join(workspace, "client.js");

/** mtime granularity is coarse on some filesystems; stamp writes explicitly. */
function write(target, text, secondsAhead) {
  fs.writeFileSync(target, text, "utf8");
  const when = new Date(Date.now() + secondsAhead * 1000);
  fs.utimesSync(target, when, when);
}

// Production: the first read is frozen for the life of the process.
delete process.env.RABBITHOLE_DEV;
assert.equal(devEnabled(), false);
write(filePath, "first", 0);
const readFrozen = createSourceReader(filePath);
assert.equal(readFrozen(), "first");
write(filePath, "second", 10);
assert.equal(readFrozen(), "first", "production must not re-read a changed file");
console.log("ok dev reload: production freezes the first read");

// Dev: a changed file is served fresh on the next access.
process.env.RABBITHOLE_DEV = "1";
assert.equal(devEnabled(), true);
const readLive = createSourceReader(filePath);
assert.equal(readLive(), "second");
write(filePath, "third", 20);
assert.equal(readLive(), "third", "dev must serve the rebuilt bytes");
console.log("ok dev reload: dev serves changed files without a restart");

// A package-asset rebuild clears dist/ before rewriting it; a read landing in
// that window keeps the last good bytes instead of failing the render.
fs.rmSync(filePath);
assert.equal(readLive(), "third", "a missing file must fall back to the last good read");
write(filePath, "fourth", 30);
assert.equal(readLive(), "fourth", "the reader must recover once the rebuild lands");
const readMissing = createSourceReader(path.join(workspace, "absent.js"));
assert.throws(readMissing, /ENOENT/, "a file that was never read has no last good value");
console.log("ok dev reload: mid-rebuild reads keep the last good bytes");

// A cache-busting query on the entry alone would leave its dependency cached,
// so the loader must reflect an edit made to a module the entry imports.
const treeDir = path.join(workspace, "tree");
const stageDir = path.join(workspace, "stage");
fs.mkdirSync(path.join(treeDir, "nested"), { recursive: true });
write(path.join(treeDir, "nested", "dep.js"), 'export const DEP = "one";\n', 0);
write(path.join(treeDir, "entry.js"), 'import { DEP } from "./nested/dep.js";\nexport const VALUE = `entry:${DEP}`;\n', 0);
const loadTree = createModuleTreeLoader({ dir: treeDir, workDir: stageDir, entries: { entry: "entry.js" } });

assert.equal((await loadTree()).entry.VALUE, "entry:one");
write(path.join(treeDir, "nested", "dep.js"), 'export const DEP = "two";\n', 10);
assert.equal((await loadTree()).entry.VALUE, "entry:two", "editing a dependency must bust the whole graph");
console.log("ok dev reload: a dependency edit reloads the whole module graph");

// A half-written source file must not take the page down.
write(path.join(treeDir, "nested", "dep.js"), "export const DEP = ;\n", 20);
assert.equal((await loadTree()).entry.VALUE, "entry:two", "a broken tree must fall back to the last good graph");
write(path.join(treeDir, "nested", "dep.js"), 'export const DEP = "three";\n', 30);
assert.equal((await loadTree()).entry.VALUE, "entry:three", "the loader must recover after the source parses again");
console.log("ok dev reload: a broken source keeps the last good module graph");

delete process.env.RABBITHOLE_DEV;
fs.rmSync(workspace, { recursive: true, force: true });
console.log("dev reload verification passed");
