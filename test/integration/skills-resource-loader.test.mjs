import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { NoraResourceLoaderProvider } from "../../src/extension/agent/resource-loader.js";
import { createSkillReadTool } from "../../src/extension/agent/skill-tools.js";
import { withTempDir } from "../support/nora-archive-fixture.mjs";

test("resource loader provider rebuilds for the next run without mutating an existing loader", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const workspace = path.join(dir, "workspace");
    await writeSkill(path.join(home, ".agents", "skills", "shared"), "shared", "global shared");

    const messages = [];
    const provider = new NoraResourceLoaderProvider({
      workspaceFolderPath: workspace,
      homeDir: home,
      vscode: { window: { showWarningMessage: async (message) => messages.push(message) } },
    });
    try {
      const first = await provider.createForNextRun();
      assert.deepEqual(first.getSkills().skills.map((skill) => skill.description), ["global shared"]);

      await writeSkill(path.join(workspace, ".agents", "skills", "shared"), "shared", "workspace shared");
      const second = await provider.createForNextRun();

      assert.deepEqual(first.getSkills().skills.map((skill) => skill.description), ["global shared"], "existing AgentSession resources are not mutated");
      assert.deepEqual(second.getSkills().skills.map((skill) => skill.description), ["workspace shared"], "next run sees rebuilt skill resources");
      assert(second.getSkills().diagnostics.some((diagnostic) => diagnostic.type === "collision"), "shadow diagnostics remain on the next-run loader");
      assert(messages.some((message) => message.includes("workspace") && message.includes("home")), "shadow diagnostics are visible in VS Code");
      const emitted = messages.length;
      await provider.createForNextRun();
      assert.equal(messages.length, emitted, "unchanged diagnostics are not emitted repeatedly");
      assert(provider.watchers.length > 0, "skill directories are watched after loading");
    } finally {
      provider.dispose();
    }
  });
});

test("skill resources remain source-backed and readable through the standard read tool", async () => {
  await withTempDir(async (dir) => {
    const workspace = path.join(dir, "workspace");
    const skillDir = path.join(workspace, ".agents", "skills", "alpha");
    await writeSkill(skillDir, "alpha", "alpha skill");
    const reference = path.join(skillDir, "references", "guide.md");
    await fs.mkdir(path.dirname(reference), { recursive: true });
    await fs.writeFile(reference, "reference content\n");

    const provider = new NoraResourceLoaderProvider({ workspaceFolderPath: workspace, homeDir: path.join(dir, "home") });
    try {
      const loader = await provider.createForNextRun();
      const skill = loader.getSkills().skills[0];
      assert.equal(skill.filePath, path.join(skillDir, "SKILL.md"));
      assert.equal(skill.baseDir, skillDir);

      const read = createSkillReadTool({ roots: loader.skillBaseDirs });
      const result = await read.execute("read-1", { path: await fs.realpath(reference) });
      assert.equal(result.content[0].text, "reference content\n");
    } finally {
      provider.dispose();
    }
  });
});

/** @param {string} skillDir @param {string} name @param {string} description */
async function writeSkill(skillDir, name, description) {
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n"));
}
