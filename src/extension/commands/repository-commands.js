import * as vscode from "vscode";
import { GitRepositoryCache } from "../git/cache.js";
import { repositorySourceRecord } from "../git/evidence.js";
import { acquireRepository } from "../git/repository.js";
import { isForgeType } from "../git/remote.js";

/**
 * @param {vscode.ExtensionContext} context
 * @param {import("../document-registry.js").DocumentRegistry} registry
 * @param {{ vscode?: typeof import("vscode"), cache?: GitRepositoryCache }} [options]
 */
export function registerRepositoryCommands(context, registry, options = {}) {
  const api = options.vscode ?? vscode;
  const cache = options.cache ?? new GitRepositoryCache({
    rootDir: api.Uri.joinPath(context.globalStorageUri, "git").fsPath,
  });
  return [
    api.commands.registerCommand("nora.addRepository", () => addRepository(api, registry, cache)),
  ];
}

/**
 * @param {typeof import("vscode")} api
 * @param {import("../document-registry.js").DocumentRegistry} registry
 * @param {GitRepositoryCache} cache
 */
async function addRepository(api, registry, cache) {
  const document = registry.activeDocument;
  if (!document) {
    await api.window.showInformationMessage("Open a Nora document before adding a repository.");
    return;
  }
  const mode = await api.window.showQuickPick([
    { label: "Remote URL", value: "remote" },
    { label: "Local repository", value: "local" },
  ], {
    title: "Add repository to Nora",
    placeHolder: "Choose how Nora should acquire the repository",
    ignoreFocusOut: true,
  });
  if (!mode) return;

  let input = "";
  if (mode.value === "local") {
    const picked = await api.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: "Select Git repository",
    });
    input = picked?.[0]?.fsPath ?? "";
  } else {
    input = await api.window.showInputBox({
      title: "Remote Git URL",
      prompt: "Enter an HTTPS, SSH, or SCP-style Git remote URL",
      ignoreFocusOut: true,
    }) ?? "";
  }
  if (!input) return;

  await api.window.withProgress({
    location: api.ProgressLocation.Notification,
    title: "Nora is acquiring repository",
    cancellable: true,
  }, async (_progress, token) => {
    const controller = new AbortController();
    const disposable = token.onCancellationRequested(() => controller.abort());
    try {
      const handle = await acquireRepository(cache, input, {
        signal: controller.signal,
        chooseRemote: (remotes) => chooseRemote(api, remotes),
        chooseForgeType: (host) => chooseForgeType(api, host),
        chooseReachableRevision: (revisions) => chooseReachableRevision(api, revisions),
      });
      const source = repositorySourceRecord(handle.repository);
      try {
        await document.commitEvent({ type: "source_record", source });
        document.retainRepositoryWorktree(`${handle.repository.id}:${handle.repository.sha}`, handle);
      } catch (error) {
        await handle.release();
        throw error;
      }
      await api.window.showInformationMessage(`Added repository ${handle.repository.repo} at ${handle.repository.sha.slice(0, 12)}.`);
    } finally {
      disposable.dispose();
    }
  });
}

/**
 * @param {typeof import("vscode")} api
 * @param {Array<{ ref: string, sha: string }>} revisions
 */
async function chooseReachableRevision(api, revisions) {
  const picked = await api.window.showQuickPick(revisions.map((revision) => ({
    label: revision.ref,
    description: revision.sha,
    revision,
  })), {
    title: "Select fetched repository revision",
    placeHolder: "The current local commit is not published; choose a fetched revision or cancel and push first",
    ignoreFocusOut: true,
  });
  return picked?.revision.sha ?? null;
}

/**
 * @param {typeof import("vscode")} api
 * @param {Array<{ name: string, url: string, normalized: import("../git/remote.js").NormalizedRemote }>} remotes
 */
async function chooseRemote(api, remotes) {
  const picked = await api.window.showQuickPick(remotes.map((remote) => ({
    label: remote.name,
    description: remote.url,
    remote,
  })), {
    title: "Select permalink remote",
    placeHolder: "Choose the fetched remote Nora should use for immutable permalinks",
    ignoreFocusOut: true,
  });
  return picked?.remote ?? null;
}

/**
 * @param {typeof import("vscode")} api
 * @param {string} host
 */
async function chooseForgeType(api, host) {
  const picked = await api.window.showQuickPick([
    { label: "GitHub Enterprise", value: "github" },
    { label: "GitLab self-managed", value: "gitlab" },
    { label: "Bitbucket Data Center", value: "bitbucket-data-center" },
  ], {
    title: `Select forge type for ${host}`,
    placeHolder: "Nora needs the forge type to create immutable permalinks",
    ignoreFocusOut: true,
  });
  if (!picked || !isForgeType(picked.value)) return null;
  return picked.value;
}
