import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createCodeTools, RepositoryToolService } from "../../src/extension/agent/code-tools.js";
import { createSkillReadTool } from "../../src/extension/agent/skill-tools.js";
import { createCanvasTools } from "../../src/extension/agent/canvas-tools.js";
import { runGit } from "../../src/extension/git/process.js";
import { withTempDir } from "../support/nora-archive-fixture.mjs";

test("repository tools list, find, grep, read, and capture immutable evidence", async () => {
  await withTempDir(async (dir) => {
    const repository = await createTrackedRepository(dir);
    const service = new RepositoryToolService({
      repositories: [repository],
      now: () => "2026-07-29T00:00:00.000Z",
    });

    assert.deepEqual(service.listRepositories().map((entry) => entry.id), ["repo-a"]);

    const listed = await service.listDirectory({ repositoryId: "repo-a", path: "." });
    assert.deepEqual(listed.entries.map((entry) => entry.path), ["src", "README.md"]);

    const found = await service.findFiles({ repositoryId: "repo-a", path: ".", query: "app" });
    assert.deepEqual(found.files, ["src/app.js"]);

    const searched = await service.searchText({ repositoryId: "repo-a", path: "src", query: "export const answer" });
    assert.deepEqual(searched.matches, [{ path: "src/app.js", line: 1, text: "export const answer = 42;" }]);
    assert.equal(searched.truncated, false);

    const read = await service.readFile({ repositoryId: "repo-a", path: "src/app.js", offset: 1, limit: 1 });
    assert.equal(read.text, "export const answer = 42;");
    assert.equal(read.truncated, true, "bounded reads tell Pi when more lines remain");

    const captured = await service.captureEvidence({
      repositoryId: "repo-a",
      path: "src/app.js",
      startLine: 1,
      endLine: 1,
    });
    assert.equal(captured.evidence.id, `code:repo-a:${repository.sha}:src/app.js:1-1`);
    assert.equal(captured.evidence.excerpt, "export const answer = 42;");
    assert.equal(captured.evidence.commit, repository.sha);
    assert.equal(captured.evidence.capturedAt, "2026-07-29T00:00:00.000Z");
  });
});

test("repository path resolution rejects absolute paths, traversal, symlink escapes, non-files, binary files, and oversized reads", async () => {
  await withTempDir(async (dir) => {
    const repository = await createTrackedRepository(dir);
    const outside = path.join(dir, "outside.txt");
    await fs.writeFile(outside, "secret\n");
    await fs.symlink(outside, path.join(repository.worktreePath, "src", "outside-link"));
    await fs.writeFile(path.join(repository.worktreePath, "src", "binary.dat"), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(repository.worktreePath, "src", "large.txt"), "0123456789abcdef\n");
    await git(repository.worktreePath, ["add", "src/outside-link", "src/binary.dat", "src/large.txt"]);
    const service = new RepositoryToolService({ repositories: [repository], maxReadBytes: 8 });

    await assert.rejects(() => service.readFile({ repositoryId: "repo-a", path: "/tmp/nope" }), /relative/);
    await assert.rejects(() => service.readFile({ repositoryId: "repo-a", path: "../outside.txt" }), /inside|relative|traversal/);
    await assert.rejects(() => service.readFile({ repositoryId: "repo-a", path: "src/outside-link" }), /escapes/);
    await assert.rejects(() => service.readFile({ repositoryId: "repo-a", path: "src" }), /regular file/);
    await assert.rejects(() => service.readFile({ repositoryId: "repo-a", path: "src/binary.dat" }), /Binary/);
    await assert.rejects(() => service.readFile({ repositoryId: "repo-a", path: "src/large.txt" }), /read limit/);
  });
});

test("repository search uses fixed git argv and reports truncation", async () => {
  const calls = [];
  const git = async (args) => {
    calls.push(args);
    return { stdout: "src/a.js:1:needle\nsrc/b.js:2:needle\n", stderr: "" };
  };
  const repository = fakeRepository("/worktree");
  const service = new RepositoryToolService({ repositories: [repository], git, maxSearchResults: 1 });
  const result = await service.searchText({ repositoryId: "repo-a", path: "src", query: "needle; rm -rf /" });

  assert.equal(result.truncated, true);
  assert.deepEqual(result.matches, [{ path: "src/a.js", line: 1, text: "needle" }]);
  assert.deepEqual(calls[0], [
    "-C",
    "/worktree",
    "grep",
    "-n",
    "-I",
    "-F",
    "-e",
    "needle; rm -rf /",
    "--",
    "src",
  ]);
});

test("Nora tool set does not register mutating Pi tools", () => {
  const names = [
    ...createCodeTools({ repositories: [fakeRepository("/repo")] }),
    createSkillReadTool({ roots: ["/skills"] }),
    ...createCanvasTools({ document: fakeDocument() }),
  ].map((tool) => tool.name);

  for (const forbidden of ["bash", "edit", "write", "clipboard", "package_manager", "image_conversion"]) {
    assert.equal(names.includes(forbidden), false, `${forbidden} must not be registered`);
  }
  assert(names.includes("read"), "standard read is reserved for skill resources");
  assert(names.includes("nora_read_file"), "repository reads use a Nora-specific tool");
});

/** @param {string} dir */
async function createTrackedRepository(dir) {
  const worktreePath = path.join(dir, "work");
  await fs.mkdir(path.join(worktreePath, "src"), { recursive: true });
  await git(worktreePath, ["init"]);
  await fs.writeFile(path.join(worktreePath, "README.md"), "Nora repo\n");
  await fs.writeFile(path.join(worktreePath, "src", "app.js"), "export const answer = 42;\nconsole.log(answer);\n");
  await git(worktreePath, ["add", "README.md", "src/app.js"]);
  const sha = "1234567890abcdef1234567890abcdef12345678";
  return fakeRepository(worktreePath, sha);
}

/** @param {string} cwd @param {string[]} args */
async function git(cwd, args) {
  return runGit(args, { cwd });
}

/** @param {string} worktreePath @param {string} [sha] */
function fakeRepository(worktreePath, sha = "1234567890abcdef1234567890abcdef12345678") {
  return {
    id: "repo-a",
    barePath: path.join(worktreePath, ".git"),
    worktreePath,
    acquisitionUrl: "file:///repo-a",
    sanitizedRemote: "file:///repo-a",
    sha,
    forgeType: null,
    forgeBaseUrl: "",
    repo: "repo-a",
    title: "repo-a",
  };
}

function fakeDocument() {
  return {
    state: { rootNodeId: "root", nodes: new Map([["root", { id: "root" }]]), sources: new Map() },
    revision: 0,
    commitRunEvent: async () => ({ committed: true, effects: {} }),
  };
}
