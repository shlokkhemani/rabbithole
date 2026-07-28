/**
 * Resolve the workspace folder that supplies session-scoped Nora resources for
 * one open document. The choice is intentionally not persisted into `.nora`.
 * @param {typeof import("vscode")} vscode
 * @param {import("vscode").Uri} documentUri
 */
export async function resolveWorkspaceScope(vscode, documentUri) {
  const direct = vscode.workspace.getWorkspaceFolder(documentUri);
  if (direct) return direct;
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return null;
  if (folders.length === 1) return folders[0];
  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder,
    })),
    {
      title: "Select Nora workspace scope",
      placeHolder: "Choose the workspace folder that supplies .vscode/mcp.json and .agents/skills for this session",
      ignoreFocusOut: true,
    },
  );
  return picked?.folder ?? null;
}
