import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeRepositoryRelativePath } from "./evidence.js";
import { runGit } from "./process.js";
import { isForgeType, normalizeRemoteUrl } from "./remote.js";

/**
 * @typedef {import("./cache.js").GitRepositoryCache} GitRepositoryCache
 * @typedef {import("./cache.js").RepositoryWorktreeHandle} RepositoryWorktreeHandle
 * @typedef {import("./remote.js").ForgeType} ForgeType
 * @typedef {import("./remote.js").NormalizedRemote} NormalizedRemote
 * @typedef {{ name: string, url: string, normalized: NormalizedRemote }} ResolvedRemote
 */

/**
 * @param {GitRepositoryCache} cache
 * @param {string} input
 * @param {{
 *   revision?: string,
 *   forgeType?: ForgeType | null,
 *   forgeBaseUrl?: string | null,
 *   chooseRemote?: (remotes: ResolvedRemote[]) => Promise<ResolvedRemote | null>,
 *   chooseForgeType?: (host: string) => Promise<ForgeType | null>,
 *   chooseReachableRevision?: (revisions: Array<{ ref: string, sha: string }>) => Promise<string | null>,
 *   signal?: AbortSignal,
 *   git?: typeof runGit
 * }} [options]
 * @returns {Promise<RepositoryWorktreeHandle>}
 */
export async function acquireRepository(cache, input, options = {}) {
  if (await isLocalRepository(input, options.git)) {
    const remote = await resolveLocalRepositoryRemote(input, options);
    if (remote) {
      const head = await localHead(input, options);
      let revision = options.revision ?? head;
      try {
        await assertCommitReachableFromRemote(input, remote.name, revision, options);
      } catch (error) {
        if (options.revision || !options.chooseReachableRevision) throw error;
        const selected = await options.chooseReachableRevision(await listReachableRemoteRevisions(input, remote.name, options));
        if (!selected) throw error;
        revision = selected;
        await assertCommitReachableFromRemote(input, remote.name, revision, options);
      }
      return cache.acquireLocal(input, {
        revision,
        permalinkRemote: remote.normalized,
        signal: options.signal,
      });
    }
    throw new Error("Local repository has no usable remote for Nora permalinks; add an upstream/origin remote before adding it to Nora.");
  }

  const initial = normalizeRemoteUrl(input, {
    forgeType: options.forgeType ?? null,
    forgeBaseUrl: options.forgeBaseUrl ?? null,
  });
  const forgeType = initial.forgeType ?? await options.chooseForgeType?.(initial.host) ?? null;
  if (forgeType && !isForgeType(forgeType)) throw new TypeError(`Unsupported forge type: ${forgeType}`);
  return cache.acquireRemote(input, {
    revision: options.revision,
    forgeType,
    forgeBaseUrl: options.forgeBaseUrl,
    signal: options.signal,
  });
}

/**
 * Resolve the local repository remote used for forge permalinks. Precedence:
 * current branch upstream, then origin, then explicit user choice.
 * @param {string} repoPath
 * @param {{
 *   forgeType?: ForgeType | null,
 *   forgeBaseUrl?: string | null,
 *   chooseRemote?: (remotes: ResolvedRemote[]) => Promise<ResolvedRemote | null>,
 *   chooseForgeType?: (host: string) => Promise<ForgeType | null>,
 *   git?: typeof runGit,
 *   signal?: AbortSignal
 * }} [options]
 * @returns {Promise<ResolvedRemote | null>}
 */
export async function resolveLocalRepositoryRemote(repoPath, options = {}) {
  const git = options.git ?? runGit;
  const remotes = await listNormalizedRemotes(repoPath, options);
  if (remotes.length === 0) return null;

  const upstream = await currentBranchUpstreamRemote(repoPath, git, options.signal);
  const byName = new Map(remotes.map((remote) => [remote.name, remote]));
  if (upstream && byName.has(upstream)) return byName.get(upstream) ?? null;
  if (byName.has("origin")) return byName.get("origin") ?? null;
  if (remotes.length === 1) return remotes[0];
  return await options.chooseRemote?.(remotes) ?? null;
}

/**
 * @param {string} repoPath
 * @param {string} remoteName
 * @param {string} sha
 * @param {{ git?: typeof runGit, signal?: AbortSignal }} [options]
 */
export async function assertCommitReachableFromRemote(repoPath, remoteName, sha, options = {}) {
  const git = options.git ?? runGit;
  await git(["-C", repoPath, "fetch", "--prune", remoteName], { signal: options.signal });
  const result = await git(["-C", repoPath, "for-each-ref", "--format=%(refname)", "--contains", sha, "refs/remotes"], { signal: options.signal });
  const refs = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!refs.some((ref) => ref === `refs/remotes/${remoteName}/HEAD` || ref.startsWith(`refs/remotes/${remoteName}/`))) {
    throw new Error(`Local commit ${sha} is not reachable from fetched remote ${remoteName}; push it or select a fetched upstream revision before creating forge permalinks.`);
  }
}

/**
 * @param {string} repoPath
 * @param {string} remoteName
 * @param {{ git?: typeof runGit, signal?: AbortSignal }} [options]
 */
export async function listReachableRemoteRevisions(repoPath, remoteName, options = {}) {
  const git = options.git ?? runGit;
  await git(["-C", repoPath, "fetch", "--prune", remoteName], { signal: options.signal });
  const result = await git(["-C", repoPath, "for-each-ref", "--format=%(objectname)%00%(refname:short)", `refs/remotes/${remoteName}`], { signal: options.signal });
  /** @type {Array<{ ref: string, sha: string }>} */
  const revisions = [];
  const seen = new Set();
  for (const line of result.stdout.trim().split(/\r?\n/).filter(Boolean)) {
    const [sha, ref] = line.split("\0");
    if (!sha || !ref || ref.endsWith("/HEAD") || seen.has(sha)) continue;
    seen.add(sha);
    revisions.push({ ref, sha });
  }
  return revisions;
}

/**
 * @param {string} repoPath
 * @param {{ git?: typeof runGit, signal?: AbortSignal }} [options]
 */
export async function localHead(repoPath, options = {}) {
  const result = await (options.git ?? runGit)(["-C", repoPath, "rev-parse", "--verify", "HEAD"], { signal: options.signal });
  return result.stdout.trim();
}

/**
 * @param {import("./cache.js").AcquiredRepository} repository
 * @param {string} relativePath
 */
export async function resolveRepositoryFilePath(repository, relativePath) {
  const normalized = normalizeRepositoryRelativePath(relativePath);
  const root = await fs.realpath(repository.worktreePath);
  const filePath = await fs.realpath(path.join(root, normalized));
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (filePath !== root && !filePath.startsWith(prefix)) throw new TypeError("Repository path escapes the acquired worktree");
  return filePath;
}

/**
 * @param {string} repoPath
 * @param {typeof runGit | undefined} git
 */
async function isLocalRepository(repoPath, git = runGit) {
  if (typeof repoPath !== "string" || repoPath.trim() === "") return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repoPath) || /^[^@\s/:]+@[^:\s]+:.+/.test(repoPath)) return false;
  return git(["-C", repoPath, "rev-parse", "--git-dir"], { maxStdoutBytes: 4096, maxStderrBytes: 4096 }).then(
    () => true,
    () => false,
  );
}

/**
 * @param {string} repoPath
 * @param {{
 *   forgeType?: ForgeType | null,
 *   forgeBaseUrl?: string | null,
 *   chooseForgeType?: (host: string) => Promise<ForgeType | null>,
 *   git?: typeof runGit,
 *   signal?: AbortSignal
 * }} options
 */
async function listNormalizedRemotes(repoPath, options) {
  const git = options.git ?? runGit;
  const names = await git(["-C", repoPath, "remote"], { signal: options.signal }).then((result) => (
    result.stdout.trim().split(/\r?\n/).filter(Boolean)
  ));
  /** @type {ResolvedRemote[]} */
  const remotes = [];
  for (const name of names) {
    const url = await git(["-C", repoPath, "remote", "get-url", name], { signal: options.signal }).then((result) => result.stdout.trim());
    const first = await normalizeRepositoryRemote(url, options);
    const forgeType = first.forgeType ?? await options.chooseForgeType?.(first.host) ?? null;
    remotes.push({
      name,
      url,
      normalized: first.forgeType === forgeType ? first : await normalizeRepositoryRemote(url, { ...options, forgeType }),
    });
  }
  return remotes;
}

/**
 * @param {string} url
 * @param {{ forgeType?: ForgeType | null, forgeBaseUrl?: string | null }} options
 * @returns {Promise<NormalizedRemote>}
 */
async function normalizeRepositoryRemote(url, options) {
  try {
    return normalizeRemoteUrl(url, {
      forgeType: options.forgeType ?? null,
      forgeBaseUrl: options.forgeBaseUrl ?? null,
    });
  } catch (error) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith("file:")) throw error;
    const localPath = url.startsWith("file:") ? fileURLToPath(url) : url;
    const realPath = await fs.realpath(localPath);
    const sanitizedUrl = pathToFileURL(realPath).href;
    return {
      gitUrl: url,
      sanitizedUrl,
      transport: "http",
      host: "local",
      path: realPath,
      forgeType: null,
      forgeBaseUrl: "",
      repo: path.basename(realPath).replace(/\.git$/i, ""),
    };
  }
}

/**
 * @param {string} repoPath
 * @param {typeof runGit} git
 * @param {AbortSignal | undefined} signal
 */
async function currentBranchUpstreamRemote(repoPath, git, signal) {
  const upstream = await git(["-C", repoPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { signal }).then(
    (result) => result.stdout.trim(),
    () => "",
  );
  if (!upstream || upstream === "HEAD") return null;
  const slash = upstream.indexOf("/");
  return slash > 0 ? upstream.slice(0, slash) : null;
}

/** @param {string} fileUrl */
export function fileUrlToPath(fileUrl) {
  return fileURLToPath(fileUrl);
}
