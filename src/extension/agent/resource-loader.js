import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  emitVisibleSkillDiagnostics,
  existingRealDirectories,
  loadNoraSkills,
  noraSkillDirectories,
  visibleSkillDiagnosticMessages,
} from "../skills/loader.js";

export const NORA_SYSTEM_PROMPT = [
  "You are Nora, a VS Code research agent that writes findings back to the current Nora canvas.",
  "Repository code is immutable. Use Nora repository tools with explicit repository IDs and relative paths; do not infer access to local filesystem paths.",
  "Capture evidence for code claims before relying on them in canvas nodes.",
  "User-configured MCP tools may have side effects. Treat MCP as user-owned capability and report material tool results plainly.",
  "Mutate the research canvas only through Nora canvas tools. Do not ask for bash, edit, write, package-manager, clipboard, or unrestricted filesystem tools.",
  "Use the read tool only to load SKILL.md files and files referenced by those skills.",
].join("\n");

/** @typedef {{ name: string, description: string, filePath: string, baseDir: string, sourceInfo: Record<string, unknown>, disableModelInvocation?: boolean }} Skill */
/** @typedef {import("../skills/loader.js").ResourceDiagnostic} ResourceDiagnostic */

export class NoraResourceLoader {
  /**
   * @param {{
   *   skills: Skill[],
   *   diagnostics: ResourceDiagnostic[],
   *   systemPrompt?: string,
   *   appendSystemPrompt?: string[],
   *   skillBaseDirs?: string[]
   * }} options
   */
  constructor(options) {
    this.skills = [...options.skills];
    this.diagnostics = [...options.diagnostics];
    this.systemPrompt = options.systemPrompt ?? NORA_SYSTEM_PROMPT;
    this.appendSystemPrompt = [...(options.appendSystemPrompt ?? [])];
    this.skillBaseDirs = [...(options.skillBaseDirs ?? [])];
    this.extensionRuntime = createEmptyExtensionRuntime();
  }

  getExtensions() {
    return { extensions: [], errors: [], runtime: this.extensionRuntime };
  }

  getSkills() {
    return { skills: this.skills, diagnostics: this.diagnostics };
  }

  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }

  getThemes() {
    return { themes: [], diagnostics: [] };
  }

  getAgentsFiles() {
    return { agentsFiles: [] };
  }

  getSystemPrompt() {
    return this.systemPrompt;
  }

  getAppendSystemPrompt() {
    return [...this.appendSystemPrompt];
  }

  /** @param {unknown} _paths */
  extendResources(_paths) {
    // Nora deliberately does not accept Pi extension, prompt, theme, or agent-file discovery.
  }

  async reload() {
    // Loader snapshots are immutable for an AgentSession. Ask the provider for a
    // fresh loader on the next run instead of mutating this instance.
  }
}

export class NoraResourceLoaderProvider {
  /**
   * @param {{
   *   workspaceFolderPath?: string | null,
   *   homeDir?: string,
   *   systemPrompt?: string,
   *   appendSystemPrompt?: string[],
   *   vscode?: Pick<typeof import("vscode"), "window">
   * }} options
   */
  constructor(options = {}) {
    this.options = { ...options };
    this.cached = null;
    this.signature = "";
    this.dirty = true;
    this.emittedDiagnosticMessages = new Set();
    /** @type {fs.FSWatcher[]} */
    this.watchers = [];
  }

  async createForNextRun() {
    const signature = await skillDirectorySignature(this.options);
    if (this.cached && !this.dirty && this.signature === signature) return this.#loaderFromCached();
    const loaded = await loadNoraSkills(this.options);
    this.cached = loaded;
    this.signature = signature;
    this.dirty = false;
    this.#refreshWatchers(loaded.skillBaseDirs);
    await this.#emitNewDiagnostics(loaded.diagnostics);
    return this.#loaderFromCached();
  }

  markDirty() {
    this.dirty = true;
  }

  dispose() {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  #loaderFromCached() {
    if (!this.cached) throw new Error("Nora resource loader cache has not been initialized");
    return new NoraResourceLoader({
      skills: this.cached.skills,
      diagnostics: this.cached.diagnostics,
      skillBaseDirs: this.cached.skillBaseDirs,
      systemPrompt: this.options.systemPrompt,
      appendSystemPrompt: this.options.appendSystemPrompt,
    });
  }

  /** @param {ResourceDiagnostic[]} diagnostics */
  async #emitNewDiagnostics(diagnostics) {
    if (!this.options.vscode) return;
    const fresh = diagnostics.filter((diagnostic) => {
      const [message] = visibleSkillDiagnosticMessages([diagnostic]);
      if (!message || this.emittedDiagnosticMessages.has(message)) return false;
      this.emittedDiagnosticMessages.add(message);
      return true;
    });
    if (fresh.length) await emitVisibleSkillDiagnostics(this.options.vscode, fresh);
  }

  /** @param {string[]} skillBaseDirs */
  #refreshWatchers(skillBaseDirs) {
    this.dispose();
    const dirs = noraSkillDirectories(this.options);
    const roots = [
      dirs.globalSkillsDir,
      ...(dirs.workspaceSkillsDir ? [dirs.workspaceSkillsDir] : []),
      ...skillBaseDirs,
    ];
    for (const dir of roots) {
      try {
        const watcher = fs.watch(dir, { persistent: false }, () => this.markDirty());
        this.watchers.push(watcher);
      } catch {
        // Missing skill directories are expected before a workspace opts in.
      }
    }
  }
}

/**
 * @param {{
 *   workspaceFolderPath?: string | null,
 *   homeDir?: string,
 *   systemPrompt?: string,
 *   appendSystemPrompt?: string[]
 * }} options
 */
export async function createNoraResourceLoader(options = {}) {
  const loaded = await loadNoraSkills(options);
  return new NoraResourceLoader({
    skills: loaded.skills,
    diagnostics: loaded.diagnostics,
    skillBaseDirs: loaded.skillBaseDirs,
    systemPrompt: options.systemPrompt,
    appendSystemPrompt: options.appendSystemPrompt,
  });
}

/**
 * @param {{ workspaceFolderPath?: string | null, homeDir?: string }} options
 */
async function skillDirectorySignature(options) {
  const dirs = noraSkillDirectories(options);
  const roots = await existingRealDirectories([
    dirs.globalSkillsDir,
    ...(dirs.workspaceSkillsDir ? [dirs.workspaceSkillsDir] : []),
  ]);
  /** @type {string[]} */
  const entries = [];
  for (const root of roots) {
    await collectDirectorySignature(root, root, entries);
  }
  return entries.sort().join("\n");
}

function createEmptyExtensionRuntime() {
  const notInitialized = () => {
    throw new Error("Nora does not load Pi extensions for this ResourceLoader");
  };
  return {
    sendMessage: notInitialized,
    sendUserMessage: notInitialized,
    appendEntry: notInitialized,
    setSessionName: notInitialized,
    getSessionName: notInitialized,
    setLabel: notInitialized,
    getActiveTools: notInitialized,
    getAllTools: notInitialized,
    setActiveTools: notInitialized,
    refreshTools: () => {},
    getCommands: notInitialized,
    setModel: () => Promise.reject(new Error("Nora does not load Pi extensions for this ResourceLoader")),
    getThinkingLevel: notInitialized,
    setThinkingLevel: notInitialized,
    flagValues: new Map(),
    pendingProviderRegistrations: [],
    pendingNativeProviderRegistrations: [],
    assertActive: () => {},
    invalidate: () => {},
    registerProvider: () => {},
    registerNativeProvider: () => {},
    unregisterProvider: () => {},
  };
}

/**
 * @param {string} root
 * @param {string} dir
 * @param {string[]} entries
 */
async function collectDirectorySignature(root, dir, entries) {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    if (dirent.name === "node_modules") continue;
    const fullPath = path.join(dir, dirent.name);
    let stat;
    try {
      stat = await fsp.stat(fullPath);
    } catch {
      continue;
    }
    const rel = path.relative(root, fullPath).split(path.sep).join("/");
    entries.push(`${root}:${rel}:${stat.mtimeMs}:${stat.size}`);
    if (stat.isDirectory()) await collectDirectorySignature(root, fullPath, entries);
  }
}
