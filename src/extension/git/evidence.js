import path from "node:path";
import { bitbucketCloudPermalink } from "./forge/bitbucket-cloud.js";
import { bitbucketDataCenterPermalink } from "./forge/bitbucket-data-center.js";
import { githubPermalink } from "./forge/github.js";
import { gitlabPermalink } from "./forge/gitlab.js";

/**
 * @typedef {import("./remote.js").ForgeType} ForgeType
 * @typedef {{
 *   id: string,
 *   sanitizedRemote: string,
 *   acquisitionUrl: string,
 *   forgeType: ForgeType | null,
 *   forgeBaseUrl: string,
 *   sha: string,
 *   owner?: string,
 *   namespace?: string,
 *   workspace?: string,
 *   project?: string,
 *   repo: string,
 *   title?: string
 * }} RepositoryDescriptor
 */

/**
 * @param {RepositoryDescriptor} repository
 * @param {{ capturedAt?: string }} [options]
 * @returns {import("../../core/contracts/evidence.js").SourceRecord}
 */
export function repositorySourceRecord(repository, options = {}) {
  const persistedRemote = persistedRepositoryRemote(repository);
  return {
    id: repositorySourceId(repository.id),
    type: "git-repository",
    stableLocator: {
      repositoryId: repository.id,
      remote: persistedRemote,
      commit: repository.sha,
    },
    title: repository.title ?? repository.repo,
    revision: repository.sha,
    commit: repository.sha,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    extensions: {
      nora: {
        repositoryId: repository.id,
        sanitizedRemote: persistedRemote,
        forgeType: repository.forgeType,
        forgeBaseUrl: repository.forgeBaseUrl,
      },
    },
  };
}

/**
 * @param {RepositoryDescriptor} repository
 * @param {{
 *   relativePath: string,
 *   startLine: number,
 *   endLine?: number,
 *   excerpt: string,
 *   title?: string,
 *   capturedAt?: string,
 *   id?: string
 * }} input
 * @returns {import("../../core/contracts/evidence.js").EvidenceRecord}
 */
export function codeEvidenceRecord(repository, input) {
  const relativePath = normalizeRepositoryRelativePath(input.relativePath);
  const range = normalizeLineRange(input.startLine, input.endLine ?? input.startLine);
  const permalink = repository.forgeType ? forgePermalink(repository, relativePath, range) : undefined;
  const persistedRemote = persistedRepositoryRemote(repository);
  return {
    id: input.id ?? codeEvidenceId(repository.id, repository.sha, relativePath, range.startLine, range.endLine),
    sourceId: repositorySourceId(repository.id),
    sourceType: "git",
    stableLocator: {
      repositoryId: repository.id,
      relativePath,
      commit: repository.sha,
      startLine: range.startLine,
      endLine: range.endLine,
    },
    title: input.title ?? `${relativePath}:${range.startLine}-${range.endLine}`,
    excerpt: input.excerpt,
    revision: repository.sha,
    commit: repository.sha,
    permalink,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    range,
    extensions: {
      nora: {
        repositoryId: repository.id,
        sanitizedRemote: persistedRemote,
        forgeType: repository.forgeType,
        forgeBaseUrl: repository.forgeBaseUrl,
        relativePath,
      },
    },
  };
}

/** @param {string} repositoryId */
export function repositorySourceId(repositoryId) {
  return `repository:${repositoryId}`;
}

/**
 * @param {string} repositoryId
 * @param {string} sha
 * @param {string} relativePath
 * @param {number} startLine
 * @param {number} endLine
 */
export function codeEvidenceId(repositoryId, sha, relativePath, startLine, endLine) {
  return `code:${repositoryId}:${sha}:${relativePath}:${startLine}-${endLine}`;
}

/** @param {RepositoryDescriptor} repository */
function persistedRepositoryRemote(repository) {
  const remote = String(repository.sanitizedRemote ?? "");
  return remote.startsWith("file:") ? `local:${repository.id}` : remote;
}

/** @param {string} relativePath */
export function normalizeRepositoryRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") throw new TypeError("Repository path must be a non-empty relative path");
  const value = relativePath.replace(/\\/g, "/");
  if (path.posix.isAbsolute(value)) throw new TypeError("Repository path must be relative");
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") throw new TypeError("Repository path must stay inside the repository");
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new TypeError("Repository path must not contain traversal");
  return normalized;
}

/**
 * @param {number} startLine
 * @param {number} endLine
 */
export function normalizeLineRange(startLine, endLine) {
  if (!Number.isSafeInteger(startLine) || startLine < 1) throw new TypeError("startLine must be a positive integer");
  if (!Number.isSafeInteger(endLine) || endLine < startLine) throw new TypeError("endLine must be greater than or equal to startLine");
  return { startLine, endLine };
}

/**
 * @param {RepositoryDescriptor} repository
 * @param {string} relativePath
 * @param {{ startLine: number, endLine: number }} range
 */
export function forgePermalink(repository, relativePath, range) {
  switch (repository.forgeType) {
    case "github":
      return githubPermalink({
        baseUrl: repository.forgeBaseUrl,
        owner: requirePart(repository.owner, "GitHub owner"),
        repo: repository.repo,
        sha: repository.sha,
        relativePath,
        ...range,
      });
    case "gitlab":
      return gitlabPermalink({
        baseUrl: repository.forgeBaseUrl,
        namespace: requirePart(repository.namespace, "GitLab namespace"),
        repo: repository.repo,
        sha: repository.sha,
        relativePath,
        ...range,
      });
    case "bitbucket-cloud":
      return bitbucketCloudPermalink({
        baseUrl: repository.forgeBaseUrl,
        workspace: requirePart(repository.workspace, "Bitbucket workspace"),
        repo: repository.repo,
        sha: repository.sha,
        relativePath,
        startLine: range.startLine,
      });
    case "bitbucket-data-center":
      return bitbucketDataCenterPermalink({
        baseUrl: repository.forgeBaseUrl,
        project: requirePart(repository.project, "Bitbucket project"),
        repo: repository.repo,
        sha: repository.sha,
        relativePath,
        ...range,
      });
    default:
      return undefined;
  }
}

/**
 * @param {string | undefined} value
 * @param {string} label
 */
function requirePart(value, label) {
  if (!value) throw new TypeError(`${label} is required for forge permalink`);
  return value;
}
