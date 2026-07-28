import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * @typedef {{ name: string, description: string, filePath: string, baseDir: string, sourceInfo: { scope?: string, [key: string]: unknown }, disableModelInvocation?: boolean }} Skill
 * @typedef {{ resourceType: "extension" | "skill" | "prompt" | "theme", name: string, winnerPath: string, loserPath: string, winnerSource?: string, loserSource?: string }} ResourceCollision
 * @typedef {{ type: "warning" | "error" | "collision", message: string, path?: string, collision?: ResourceCollision }} ResourceDiagnostic
 */

/**
 * @param {{
 *   workspaceFolderPath?: string | null,
 *   homeDir?: string,
 * }} options
 */
export async function loadNoraSkills(options = {}) {
  const directories = noraSkillDirectories(options);
  const global = await loadSkillDirectory(directories.globalSkillsDir, "user", directories.globalSkillsDir);
  const workspace = directories.workspaceSkillsDir
    ? await loadSkillDirectory(directories.workspaceSkillsDir, "project", directories.workspaceSkillsDir)
    : emptyLoadResult();

  const merged = mergeSkillsWithWorkspacePrecedence(global.skills, workspace.skills);
  return {
    skills: merged.skills,
    diagnostics: [
      ...global.diagnostics,
      ...workspace.diagnostics,
      ...merged.diagnostics,
    ],
    directories,
    skillBaseDirs: skillBaseDirs(merged.skills),
  };
}

/**
 * @param {{
 *   workspaceFolderPath?: string | null,
 *   homeDir?: string,
 * }} options
 */
export function noraSkillDirectories(options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  return {
    workspaceSkillsDir: options.workspaceFolderPath
      ? path.join(options.workspaceFolderPath, ".agents", "skills")
      : null,
    globalSkillsDir: path.join(homeDir, ".agents", "skills"),
  };
}

/**
 * @param {ResourceDiagnostic[]} diagnostics
 */
export function visibleSkillDiagnosticMessages(diagnostics) {
  return diagnostics
    .filter((diagnostic) => diagnostic.type === "warning" || diagnostic.type === "error" || diagnostic.type === "collision")
    .map((diagnostic) => {
      if (diagnostic.collision) {
        return `${diagnostic.message}: ${diagnostic.collision.winnerPath} shadows ${diagnostic.collision.loserPath}`;
      }
      return diagnostic.path ? `${diagnostic.message}: ${diagnostic.path}` : diagnostic.message;
    });
}

/**
 * @param {Pick<typeof import("vscode"), "window">} vscode
 * @param {ResourceDiagnostic[]} diagnostics
 */
export async function emitVisibleSkillDiagnostics(vscode, diagnostics) {
  for (const message of visibleSkillDiagnosticMessages(diagnostics)) {
    await vscode.window.showWarningMessage(`Nora skill diagnostic: ${message}`);
  }
}

/** @param {string[]} roots */
export async function existingRealDirectories(roots) {
  const real = await Promise.all(roots.map(async (root) => {
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) return null;
      return await fs.realpath(root);
    } catch {
      return null;
    }
  }));
  return [...new Set(real.filter((entry) => typeof entry === "string"))];
}

/**
 * @param {string} dir
 * @param {"user" | "project"} source
 * @param {string} root
 */
async function loadSkillDirectory(dir, source, root) {
  const { loadSkillsFromDir } = await loadPiSkillParser();
  const result = loadSkillsFromDir({ dir, source });
  const realRoot = await fs.realpath(root).catch(() => null);
  if (!realRoot) return result;
  /** @type {Skill[]} */
  const skills = [];
  /** @type {ResourceDiagnostic[]} */
  const diagnostics = [...result.diagnostics];
  for (const skill of result.skills) {
    const realFile = await fs.realpath(skill.filePath).catch(() => null);
    if (!realFile || !isInside(realRoot, realFile)) {
      diagnostics.push({
        type: "warning",
        message: "skill path escapes Nora skill directory",
        path: skill.filePath,
      });
      continue;
    }
    skills.push(skill);
  }
  return { skills, diagnostics };
}

/** @param {Skill[]} globalSkills @param {Skill[]} workspaceSkills */
function mergeSkillsWithWorkspacePrecedence(globalSkills, workspaceSkills) {
  /** @type {Map<string, Skill>} */
  const byName = new Map();
  /** @type {ResourceDiagnostic[]} */
  const diagnostics = [];
  for (const skill of globalSkills) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
    else diagnostics.push(duplicateSkillDiagnostic(skill, byName.get(skill.name), "global skill duplicate ignored"));
  }
  for (const skill of workspaceSkills) {
    const existing = byName.get(skill.name);
    if (existing && existing.sourceInfo.scope === "project") {
      diagnostics.push(duplicateSkillDiagnostic(skill, existing, "workspace skill duplicate ignored"));
      continue;
    }
    if (existing) {
      diagnostics.push({
        type: "collision",
        message: `workspace skill "${skill.name}" shadows global skill`,
        path: skill.filePath,
        collision: {
          resourceType: "skill",
          name: skill.name,
          winnerPath: skill.filePath,
          loserPath: existing.filePath,
          winnerSource: "workspace",
          loserSource: "global",
        },
      });
    }
    byName.set(skill.name, skill);
  }
  return {
    skills: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    diagnostics,
  };
}

/** @param {Skill[]} skills */
function skillBaseDirs(skills) {
  return [...new Set(skills.map((skill) => skill.baseDir).filter(Boolean))].sort();
}

function emptyLoadResult() {
  return { skills: [], diagnostics: [] };
}

/** @param {Skill} skill @param {Skill | undefined} existing @param {string} message @returns {ResourceDiagnostic} */
function duplicateSkillDiagnostic(skill, existing, message) {
  return {
    type: "collision",
    message: `${message}: ${skill.name}`,
    path: skill.filePath,
    collision: {
      resourceType: "skill",
      name: skill.name,
      winnerPath: existing?.filePath ?? skill.filePath,
      loserPath: skill.filePath,
    },
  };
}

/** @param {string} root @param {string} target */
function isInside(root, target) {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(prefix);
}

async function loadPiSkillParser() {
  const dynamicImport = Function("specifier", "return import(specifier)");
  return /** @type {Promise<{ loadSkillsFromDir: (options: { dir: string, source: string }) => { skills: Skill[], diagnostics: ResourceDiagnostic[] } }>} */ (
    dynamicImport("@earendil-works/pi-coding-agent")
  );
}
