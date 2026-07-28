import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Bytes } from "../archive/hash.js";
import { runGit } from "./process.js";
import { normalizeRemoteUrl } from "./remote.js";

/**
 * @typedef {import("./remote.js").ForgeType} ForgeType
 * @typedef {import("./remote.js").NormalizedRemote} NormalizedRemote
 * @typedef {{
 *   id: string,
 *   barePath: string,
 *   worktreePath: string,
 *   acquisitionUrl: string,
 *   sanitizedRemote: string,
 *   sha: string,
 *   forgeType: ForgeType | null,
 *   forgeBaseUrl: string,
 *   owner?: string,
 *   namespace?: string,
 *   workspace?: string,
 *   project?: string,
 *   repo: string,
 *   title: string
 * }} AcquiredRepository
 */

export class RepositoryWorktreeHandle {
  /**
   * @param {GitRepositoryCache} cache
   * @param {AcquiredRepository} repository
   */
  constructor(cache, repository) {
    this.cache = cache;
    this.repository = repository;
    this.released = false;
  }

  get id() {
    return this.repository.id;
  }

  get worktreePath() {
    return this.repository.worktreePath;
  }

  async release() {
    if (this.released) return;
    this.released = true;
    await this.cache.releaseWorktree(this.repository);
  }
}

export class GitRepositoryCache {
  /**
   * @param {{
   *   rootDir: string,
   *   git?: typeof runGit,
   *   gitPath?: string
   * }} options
   */
  constructor(options) {
    this.rootDir = options.rootDir;
    this.git = options.git ?? runGit;
    this.gitPath = options.gitPath;
    /** @type {Map<string, Promise<unknown>>} */
    this.locks = new Map();
    /** @type {Map<string, number>} */
    this.worktreeRefs = new Map();
  }

  /**
   * @param {string} remoteUrl
   * @param {{ revision?: string, forgeType?: ForgeType | null, forgeBaseUrl?: string | null, signal?: AbortSignal }} [options]
   */
  async acquireRemote(remoteUrl, options = {}) {
    const remote = normalizeRemoteUrl(remoteUrl, options);
    return this.#withLock(remote.sanitizedUrl, async () => {
      const barePath = await this.#ensureBareClone(remote.gitUrl, remote.sanitizedUrl, options.signal);
      const sha = await this.#resolveCommit(barePath, options.revision ?? "HEAD", options.signal);
      const worktreePath = await this.#ensureWorktree(barePath, repositoryId(remote.sanitizedUrl), sha, options.signal);
      const repository = repositoryDescriptor(remote, {
        id: repositoryId(remote.sanitizedUrl),
        barePath,
        worktreePath,
        acquisitionUrl: remote.sanitizedUrl,
        sha,
      });
      this.#retain(worktreePath);
      return new RepositoryWorktreeHandle(this, repository);
    });
  }

  /**
   * @param {string} localPath
   * @param {{
   *   revision?: string,
   *   permalinkRemote?: NormalizedRemote | null,
   *   signal?: AbortSignal
   * }} [options]
   */
  async acquireLocal(localPath, options = {}) {
    const realPath = await fs.realpath(localPath);
    const acquisitionUrl = pathToFileURL(realPath).href;
    const remote = options.permalinkRemote;
    return this.#withLock(acquisitionUrl, async () => {
      const barePath = await this.#ensureBareClone(realPath, acquisitionUrl, options.signal);
      const sha = await this.#resolveCommit(barePath, options.revision ?? "HEAD", options.signal);
      const worktreePath = await this.#ensureWorktree(barePath, repositoryId(acquisitionUrl), sha, options.signal);
      const fallbackRemote = normalizeLocalFileRemote(acquisitionUrl, realPath);
      const repository = repositoryDescriptor(remote ?? fallbackRemote, {
        id: repositoryId(acquisitionUrl),
        barePath,
        worktreePath,
        acquisitionUrl,
        sha,
      });
      this.#retain(worktreePath);
      return new RepositoryWorktreeHandle(this, repository);
    });
  }

  /**
   * @param {AcquiredRepository} repository
   */
  async refresh(repository) {
    if (repository.acquisitionUrl.startsWith("file:")) {
      const localPath = fileURLToPath(repository.acquisitionUrl);
      return this.acquireLocal(localPath);
    }
    return this.acquireRemote(repository.acquisitionUrl, {
      forgeType: repository.forgeType,
      forgeBaseUrl: repository.forgeBaseUrl,
    });
  }

  /**
   * @param {AcquiredRepository} repository
   */
  async releaseWorktree(repository) {
    const current = this.worktreeRefs.get(repository.worktreePath) ?? 0;
    if (current > 1) {
      this.worktreeRefs.set(repository.worktreePath, current - 1);
      return;
    }
    this.worktreeRefs.delete(repository.worktreePath);
    await this.#removeWorktree(repository).catch(() => undefined);
  }

  /**
   * @param {string} gitUrl
   * @param {string} sanitizedAcquisitionUrl
   * @param {AbortSignal | undefined} signal
   */
  async #ensureBareClone(gitUrl, sanitizedAcquisitionUrl, signal) {
    const barePath = path.join(this.rootDir, "bare", repositoryId(sanitizedAcquisitionUrl));
    await fs.mkdir(path.dirname(barePath), { recursive: true });
    if (await isGitDirectory(barePath)) {
      await this.#git(["--git-dir", barePath, "remote", "set-url", "origin", gitUrl], { signal });
      await this.#git(["--git-dir", barePath, "fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"], { signal });
      return barePath;
    }
    await fs.rm(barePath, { recursive: true, force: true });
    await this.#git(["clone", "--bare", gitUrl, barePath], { signal });
    return barePath;
  }

  /**
   * @param {string} barePath
   * @param {string} revision
   * @param {AbortSignal | undefined} signal
   */
  async #resolveCommit(barePath, revision, signal) {
    const result = await this.#git(["--git-dir", barePath, "rev-parse", "--verify", `${revision}^{commit}`], { signal });
    return result.stdout.trim();
  }

  /**
   * @param {string} barePath
   * @param {string} id
   * @param {string} sha
   * @param {AbortSignal | undefined} signal
   */
  async #ensureWorktree(barePath, id, sha, signal) {
    const worktreePath = path.join(this.rootDir, "worktrees", id, sha);
    if (await pathExists(worktreePath)) {
      const current = await this.#git(["-C", worktreePath, "rev-parse", "HEAD"], { signal }).then((result) => result.stdout.trim(), () => "");
      if (current === sha) return worktreePath;
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await this.#git(["--git-dir", barePath, "worktree", "prune"], { signal });
    await this.#git(["--git-dir", barePath, "worktree", "add", "--detach", worktreePath, sha], { signal });
    return worktreePath;
  }

  /** @param {string} worktreePath */
  #retain(worktreePath) {
    this.worktreeRefs.set(worktreePath, (this.worktreeRefs.get(worktreePath) ?? 0) + 1);
  }

  /** @param {AcquiredRepository} repository */
  async #removeWorktree(repository) {
    await this.#git(["--git-dir", repository.barePath, "worktree", "remove", "--force", repository.worktreePath], {});
    await fs.rm(repository.worktreePath, { recursive: true, force: true });
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async #withLock(key, fn) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    /** @type {() => void} */
    let release = () => {};
    const current = new Promise((resolve) => { release = () => resolve(undefined); });
    const gate = previous.then(() => current, () => current);
    this.locks.set(key, gate);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === gate) this.locks.delete(key);
    }
  }

  /**
   * @param {string[]} args
   * @param {{ signal?: AbortSignal }} options
   */
  #git(args, options) {
    return this.git(args, { signal: options.signal, gitPath: this.gitPath });
  }
}

/** @param {string} sanitizedAcquisitionUrl */
export function repositoryId(sanitizedAcquisitionUrl) {
  return sha256Bytes(sanitizedAcquisitionUrl);
}

/**
 * @param {NormalizedRemote} remote
 * @param {{ id: string, barePath: string, worktreePath: string, acquisitionUrl: string, sha: string }} base
 * @returns {AcquiredRepository}
 */
function repositoryDescriptor(remote, base) {
  return {
    ...base,
    sanitizedRemote: remote.sanitizedUrl,
    forgeType: remote.forgeType,
    forgeBaseUrl: remote.forgeBaseUrl,
    owner: remote.owner,
    namespace: remote.namespace,
    workspace: remote.workspace,
    project: remote.project,
    repo: remote.repo,
    title: remote.repo,
  };
}

/**
 * @param {string} acquisitionUrl
 * @param {string} localPath
 * @returns {NormalizedRemote}
 */
function normalizeLocalFileRemote(acquisitionUrl, localPath) {
  return {
    gitUrl: localPath,
    sanitizedUrl: acquisitionUrl,
    transport: "http",
    host: "local",
    path: localPath,
    forgeType: null,
    forgeBaseUrl: "",
    repo: path.basename(localPath),
  };
}

/** @param {string} dir */
async function isGitDirectory(dir) {
  return pathExists(path.join(dir, "HEAD"));
}

/** @param {string} filePath */
async function pathExists(filePath) {
  return fs.access(filePath).then(
    () => true,
    (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    },
  );
}
