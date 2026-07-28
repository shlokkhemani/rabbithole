import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { GitRepositoryCache } from "../../src/extension/git/cache.js";
import { codeEvidenceRecord } from "../../src/extension/git/evidence.js";
import { runGit } from "../../src/extension/git/process.js";
import {
  acquireRepository,
  assertCommitReachableFromRemote,
  resolveLocalRepositoryRemote,
  resolveRepositoryFilePath,
} from "../../src/extension/git/repository.js";
import { withTempDir } from "../support/nora-archive-fixture.mjs";

test("repository cache mirrors committed bytes, reuses worktrees, enforces publication, and preserves old revisions", async () => {
  await withTempDir(async (dir) => {
    const { work, remote, firstSha } = await createPublishedRepository(dir);
    const cache = new GitRepositoryCache({ rootDir: path.join(dir, "cache") });

    const resolved = await resolveLocalRepositoryRemote(work);
    assert.equal(resolved?.name, "origin", "origin is selected after upstream when no branch-specific remote exists");
    assert.match(resolved?.normalized.repo ?? "", /^remote-/);

    await fs.writeFile(path.join(work, "README.md"), "dirty working tree\n");
    const [firstHandle, secondHandle] = await Promise.all([
      acquireRepository(cache, work),
      acquireRepository(cache, work),
    ]);
    assert.equal(firstHandle.repository.sha, firstSha);
    assert.equal(secondHandle.repository.sha, firstSha);
    assert.equal(firstHandle.worktreePath, secondHandle.worktreePath, "concurrent acquisition shares the pinned worktree");
    assert.equal(await fs.readFile(path.join(firstHandle.worktreePath, "README.md"), "utf8"), "one\n", "worktree uses committed bytes, not dirty local content");

    const evidence = codeEvidenceRecord(firstHandle.repository, {
      relativePath: "README.md",
      startLine: 1,
      excerpt: "one",
      capturedAt: "2026-07-29T00:00:00.000Z",
    });
    assert.equal(evidence.commit, firstSha);
    assert.equal(evidence.permalink, undefined, "local test remotes do not invent forge permalinks");
    assert.equal(await resolveRepositoryFilePath(firstHandle.repository, "README.md"), await fs.realpath(path.join(firstHandle.worktreePath, "README.md")));
    await assert.rejects(() => resolveRepositoryFilePath(firstHandle.repository, "../README.md"), /inside/);

    await fs.writeFile(path.join(work, "README.md"), "two\n");
    await git(work, ["add", "README.md"]);
    await git(work, ["commit", "-m", "second"]);
    const unpublishedSha = await revParse(work, "HEAD");
    assert.notEqual(unpublishedSha, firstSha);
    await assert.rejects(
      acquireRepository(cache, work),
      /not reachable from fetched remote/,
      "local HEAD must be pushed before Nora emits permalink-ready repository metadata",
    );
    const selectedReachable = await acquireRepository(cache, work, {
      chooseReachableRevision: async (revisions) => {
        assert(revisions.some((revision) => revision.sha === firstSha), "fetched remote revisions are offered when local HEAD is unpublished");
        return firstSha;
      },
    });
    assert.equal(selectedReachable.repository.sha, firstSha);
    await selectedReachable.release();

    await git(work, ["push", "origin", "HEAD:main"]);
    const refreshed = await acquireRepository(cache, work);
    assert.equal(refreshed.repository.sha, unpublishedSha);
    assert.notEqual(refreshed.worktreePath, firstHandle.worktreePath);
    assert.equal(await fs.readFile(path.join(firstHandle.worktreePath, "README.md"), "utf8"), "one\n", "old pinned worktree stays immutable");
    assert.equal(await fs.readFile(path.join(refreshed.worktreePath, "README.md"), "utf8"), "two\n");

    await firstHandle.release();
    assert.equal(await exists(secondHandle.worktreePath), true, "one reference keeps the shared worktree alive");
    await secondHandle.release();
    assert.equal(await exists(firstHandle.worktreePath), false, "unreferenced worktrees are pruned");
    assert.equal(await exists(path.join(dir, "cache", "bare", firstHandle.repository.id)), true, "bare caches are retained");
    await refreshed.release();

    const clone = path.join(dir, "clone");
    await runGit(["clone", remote, clone]);
    await git(clone, ["config", "user.email", "nora@example.test"]);
    await git(clone, ["config", "user.name", "Nora Test"]);
    await fs.writeFile(path.join(clone, "clone.txt"), "clone-only\n");
    await git(clone, ["add", "clone.txt"]);
    await git(clone, ["commit", "-m", "clone-only"]);
    await assert.rejects(
      assertCommitReachableFromRemote(clone, "origin", await revParse(clone, "HEAD")),
      /not reachable/,
      "unpublished local commits are refused before permalink creation",
    );
  });
});

test("repository cache surfaces missing Git and cancellation failures", async () => {
  await withTempDir(async (dir) => {
    const { work } = await createPublishedRepository(dir);
    const missingGit = new GitRepositoryCache({ rootDir: path.join(dir, "bad-cache"), gitPath: "nora-git-that-does-not-exist" });
    await assert.rejects(missingGit.acquireLocal(work), /Unable to start Git/);

    const aborted = new AbortController();
    aborted.abort();
    const cache = new GitRepositoryCache({ rootDir: path.join(dir, "cancel-cache") });
    await assert.rejects(cache.acquireLocal(work, { signal: aborted.signal }), /aborted/);
  });
});

/** @param {string} dir */
async function createPublishedRepository(dir) {
  const remote = path.join(dir, `remote-${Math.random().toString(16).slice(2)}.git`);
  const work = path.join(dir, `work-${Math.random().toString(16).slice(2)}`);
  await runGit(["init", "--bare", remote]);
  await fs.mkdir(work, { recursive: true });
  await git(work, ["init"]);
  await git(work, ["checkout", "-B", "main"]);
  await git(work, ["config", "user.email", "nora@example.test"]);
  await git(work, ["config", "user.name", "Nora Test"]);
  await fs.writeFile(path.join(work, "README.md"), "one\n");
  await git(work, ["add", "README.md"]);
  await git(work, ["commit", "-m", "first"]);
  await git(work, ["remote", "add", "origin", remote]);
  await git(work, ["push", "-u", "origin", "HEAD:main"]);
  return { work, remote, firstSha: await revParse(work, "HEAD") };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
async function git(cwd, args) {
  return runGit(args, { cwd });
}

/**
 * @param {string} cwd
 * @param {string} revision
 */
async function revParse(cwd, revision) {
  const result = await runGit(["rev-parse", "--verify", revision], { cwd });
  return result.stdout.trim();
}

/** @param {string} filePath */
async function exists(filePath) {
  return fs.access(filePath).then(
    () => true,
    (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    },
  );
}
