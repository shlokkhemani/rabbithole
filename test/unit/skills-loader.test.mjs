import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createSkillReadTool, SkillResourceReadService } from "../../src/extension/agent/skill-tools.js";
import { createNoraResourceLoader, NORA_SYSTEM_PROMPT } from "../../src/extension/agent/resource-loader.js";
import {
  emitVisibleSkillDiagnostics,
  loadNoraSkills,
  visibleSkillDiagnosticMessages,
} from "../../src/extension/skills/loader.js";
import { withTempDir } from "../support/nora-archive-fixture.mjs";

test("Nora loads exactly workspace and global .agents skills with workspace precedence", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const workspace = path.join(dir, "workspace");
    await writeSkill(path.join(home, ".agents", "skills", "shared"), "shared", "global shared");
    await writeSkill(path.join(home, ".agents", "skills", "global-only"), "global-only", "global only");
    await writeSkill(path.join(workspace, ".agents", "skills", "shared"), "shared", "workspace shared");
    await writeSkill(path.join(workspace, ".agents", "skills", "workspace-only"), "workspace-only", "workspace only");
    await writeSkill(path.join(workspace, ".pi", "skills", "ignored"), "ignored", "must not load");
    await fs.mkdir(path.join(workspace, ".agents", "skills", "bad"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".agents", "skills", "bad", "SKILL.md"), "---\nname: bad\n---\nNo description.\n");

    const loaded = await loadNoraSkills({ workspaceFolderPath: workspace, homeDir: home });
    assert.deepEqual(loaded.skills.map((skill) => skill.name), ["global-only", "shared", "workspace-only"]);
    assert.equal(loaded.skills.find((skill) => skill.name === "shared")?.description, "workspace shared");
    assert.equal(loaded.skills.some((skill) => skill.name === "ignored"), false, ".pi/skills is excluded");
    assert(loaded.diagnostics.some((diagnostic) => /description is required/.test(diagnostic.message)), "malformed skills surface parser diagnostics");
    const shadow = loaded.diagnostics.find((diagnostic) => diagnostic.type === "collision" && diagnostic.collision?.name === "shared");
    assert(shadow, "workspace shadowing emits a collision diagnostic");
    assert.equal(shadow.collision.winnerPath.endsWith(path.join("workspace", ".agents", "skills", "shared", "SKILL.md")), true);
    assert.equal(shadow.collision.loserPath.endsWith(path.join("home", ".agents", "skills", "shared", "SKILL.md")), true);

    const messages = visibleSkillDiagnosticMessages(loaded.diagnostics);
    assert(messages.some((message) => message.includes(shadow.collision.winnerPath) && message.includes(shadow.collision.loserPath)));
  });
});

test("visible skill diagnostics are emitted through VS Code UI", async () => {
  const messages = [];
  await emitVisibleSkillDiagnostics({
    window: {
      showWarningMessage: async (message) => {
        messages.push(message);
      },
    },
  }, [{
    type: "collision",
    message: "workspace skill \"x\" shadows global skill",
    path: "/workspace/.agents/skills/x/SKILL.md",
    collision: {
      resourceType: "skill",
      name: "x",
      winnerPath: "/workspace/.agents/skills/x/SKILL.md",
      loserPath: "/home/.agents/skills/x/SKILL.md",
    },
  }]);

  assert.equal(messages.length, 1);
  assert(messages[0].includes("/workspace/.agents/skills/x/SKILL.md"));
  assert(messages[0].includes("/home/.agents/skills/x/SKILL.md"));
});

test("Nora ResourceLoader exposes skills, Nora prompt, and no extensions, prompts, themes, or agent files", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const workspace = path.join(dir, "workspace");
    await writeSkill(path.join(workspace, ".agents", "skills", "research"), "research", "research skill");
    const loader = await createNoraResourceLoader({ workspaceFolderPath: workspace, homeDir: home });

    assert.deepEqual(loader.getSkills().skills.map((skill) => skill.name), ["research"]);
    assert.equal(loader.getExtensions().extensions.length, 0);
    assert.equal(loader.getPrompts().prompts.length, 0);
    assert.equal(loader.getThemes().themes.length, 0);
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
    assert.equal(loader.getSystemPrompt(), NORA_SYSTEM_PROMPT);
    assert(loader.getSystemPrompt().includes("Repository code is immutable"));
    assert(loader.getSystemPrompt().includes("MCP tools may have side effects"));
    assert(loader.getSystemPrompt().includes("Capture evidence for code claims"));
    assert(loader.getSystemPrompt().includes("Mutate the research canvas only through Nora canvas tools"));
  });
});

test("skill read tool accepts only absolute realpaths inside loaded skill directories", async () => {
  await withTempDir(async (dir) => {
    const skillDir = path.join(dir, "workspace", ".agents", "skills", "alpha");
    await writeSkill(skillDir, "alpha", "alpha skill");
    const helper = path.join(skillDir, "references.md");
    await fs.writeFile(helper, "one\ntwo\nthree\n");
    const outside = path.join(dir, "outside.md");
    await fs.writeFile(outside, "outside\n");
    await fs.symlink(outside, path.join(skillDir, "outside-link.md"));

    const service = new SkillResourceReadService({ roots: [skillDir], maxReadLines: 2 });
    const read = await service.read({ path: await fs.realpath(helper), offset: 2 });
    assert.equal(read.text, "two\nthree");

    await assert.rejects(() => service.read({ path: "references.md" }), /absolute realpath/);
    await assert.rejects(() => service.read({ path: outside }), /outside Nora skill directories/);
    await assert.rejects(() => service.read({ path: path.join(skillDir, "outside-link.md") }), /outside Nora skill directories/);

    const tool = createSkillReadTool({ roots: [skillDir] });
    const result = await tool.execute("call-1", { path: await fs.realpath(helper), limit: 1 });
    assert.equal(result.content[0].text, "one");
    assert.equal(result.details.truncated, true);
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
