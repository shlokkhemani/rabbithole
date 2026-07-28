import assert from "node:assert/strict";
import test from "node:test";
import { bitbucketCloudPermalink } from "../../src/extension/git/forge/bitbucket-cloud.js";
import { bitbucketDataCenterPermalink } from "../../src/extension/git/forge/bitbucket-data-center.js";
import { githubPermalink } from "../../src/extension/git/forge/github.js";
import { gitlabPermalink } from "../../src/extension/git/forge/gitlab.js";
import {
  codeEvidenceRecord,
  normalizeLineRange,
  normalizeRepositoryRelativePath,
  repositorySourceRecord,
} from "../../src/extension/git/evidence.js";

const sha = "0123456789abcdef0123456789abcdef01234567";

test("builds immutable forge permalinks with provider-specific anchors", () => {
  assert.equal(
    githubPermalink({ baseUrl: "https://github.com", owner: "o", repo: "r", sha, relativePath: "src/a b.js", startLine: 3, endLine: 5 }),
    `https://github.com/o/r/blob/${sha}/src/a%20b.js#L3-L5`,
  );
  assert.equal(
    gitlabPermalink({ baseUrl: "https://gitlab.com", namespace: "group/sub", repo: "r", sha, relativePath: "lib/main.js", startLine: 7, endLine: 9 }),
    `https://gitlab.com/group/sub/r/-/blob/${sha}/lib/main.js#L7-9`,
  );
  assert.equal(
    bitbucketCloudPermalink({ baseUrl: "https://bitbucket.org", workspace: "team", repo: "r", sha, relativePath: "src/main.js", startLine: 11 }),
    `https://bitbucket.org/team/r/src/${sha}/src/main.js#main.js-11`,
  );
  assert.equal(
    bitbucketDataCenterPermalink({ baseUrl: "https://bb.example.test", project: "PROJ", repo: "r", sha, relativePath: "src/main.js" }),
    `https://bb.example.test/projects/PROJ/repos/r/browse/src/main.js?at=${sha}`,
  );
});

test("validates repository paths and line ranges before creating evidence", () => {
  assert.equal(normalizeRepositoryRelativePath("src/../README.md"), "README.md");
  assert.throws(() => normalizeRepositoryRelativePath("../outside.js"), /inside/);
  assert.throws(() => normalizeRepositoryRelativePath("/outside.js"), /relative/);
  assert.deepEqual(normalizeLineRange(1, 1), { startLine: 1, endLine: 1 });
  assert.throws(() => normalizeLineRange(4, 3), /greater/);
});

test("creates SourceRecord and EvidenceRecord values pinned to a repository SHA", () => {
  const repository = {
    id: "repo-1",
    sanitizedRemote: "https://github.com/owner/repo.git",
    acquisitionUrl: "https://github.com/owner/repo.git",
    forgeType: "github",
    forgeBaseUrl: "https://github.com",
    sha,
    owner: "owner",
    repo: "repo",
  };
  const source = repositorySourceRecord(repository, { capturedAt: "2026-07-29T00:00:00.000Z" });
  assert.equal(source.type, "git-repository");
  assert.equal(source.commit, sha);
  assert.equal(source.extensions.nora.repositoryId, "repo-1");

  const evidence = codeEvidenceRecord(repository, {
    relativePath: "src/index.js",
    startLine: 2,
    endLine: 4,
    excerpt: "export const value = 1;",
    capturedAt: "2026-07-29T00:00:01.000Z",
  });
  assert.equal(evidence.sourceId, source.id);
  assert.equal(evidence.commit, sha);
  assert.equal(evidence.permalink, `https://github.com/owner/repo/blob/${sha}/src/index.js#L2-L4`);
  assert.deepEqual(evidence.range, { startLine: 2, endLine: 4 });
});
