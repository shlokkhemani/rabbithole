import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRemoteUrl } from "../../src/extension/git/remote.js";
import { sanitizeGitDiagnostic } from "../../src/extension/git/process.js";

test("normalizes HTTPS, SSH, and SCP remotes without stored userinfo", () => {
  const https = normalizeRemoteUrl("https://github.com/owner/repo.git");
  assert.equal(https.sanitizedUrl, "https://github.com/owner/repo.git");
  assert.equal(https.forgeType, "github");
  assert.equal(https.owner, "owner");
  assert.equal(https.repo, "repo");

  const ssh = normalizeRemoteUrl("ssh://git@gitlab.com/group/sub/repo.git");
  assert.equal(ssh.gitUrl, "ssh://git@gitlab.com/group/sub/repo.git");
  assert.equal(ssh.sanitizedUrl, "ssh://gitlab.com/group/sub/repo.git");
  assert.equal(ssh.forgeType, "gitlab");
  assert.equal(ssh.namespace, "group/sub");

  const scp = normalizeRemoteUrl("git@bitbucket.org:team/repo.git");
  assert.equal(scp.sanitizedUrl, "ssh://bitbucket.org/team/repo.git");
  assert.equal(scp.forgeType, "bitbucket-cloud");
  assert.equal(scp.workspace, "team");
});

test("rejects credential-bearing remotes and redacts diagnostics", () => {
  assert.throws(() => normalizeRemoteUrl("https://user:pass@example.test/owner/repo.git"), /userinfo/);
  assert.throws(() => normalizeRemoteUrl("https://example.test/owner/repo.git?access_token=secret"), /credential-bearing/);

  const diagnostic = sanitizeGitDiagnostic("fatal: https://user:secret@example.test/repo.git?token=abc failed");
  assert(!diagnostic.includes("secret"));
  assert(!diagnostic.includes("token=abc"));
  assert(diagnostic.includes("token=<redacted>"));
});

test("classifies unknown hosts only when a forge type is provided", () => {
  const unknown = normalizeRemoteUrl("ssh://git@git.example.test/team/repo.git");
  assert.equal(unknown.forgeType, null);

  const enterprise = normalizeRemoteUrl("ssh://git@git.example.test/team/repo.git", {
    forgeType: "github",
    forgeBaseUrl: "https://git.example.test",
  });
  assert.equal(enterprise.forgeType, "github");
  assert.equal(enterprise.forgeBaseUrl, "https://git.example.test");
  assert.equal(enterprise.owner, "team");
});
