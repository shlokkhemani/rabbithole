const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const vscode = require("vscode");

suite("Nora custom editor", () => {
  test("opens a .nora file through the custom editor and exposes scoped commands", async function () {
    this.timeout(30_000);
    const root = path.resolve(__dirname, "../../..");
    const { writeMinimalNoraArchive } = await import(pathToFileURL(path.join(root, "src/extension/nora-document.js")).href);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nora-vscode-test-"));
    try {
      const filePath = path.join(dir, "custom-editor.nora");
      await writeMinimalNoraArchive(filePath, "Custom Editor", {
        now: "2026-07-28T00:00:00.000Z",
        idFactory: () => "vscode-custom-editor",
      });

      const uri = vscode.Uri.file(filePath);
      await vscode.commands.executeCommand("vscode.openWith", uri, "nora.research");
      await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() === uri.toString());

      const commands = await vscode.commands.getCommands(true);
      assert(commands.includes("nora.undo"));
      assert(commands.includes("nora.redo"));
      await vscode.commands.executeCommand("nora.undo");
      await vscode.commands.executeCommand("nora.redo");
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("condition was not met before timeout");
}
