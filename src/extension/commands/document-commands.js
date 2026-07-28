import * as vscode from "vscode";
import { writeMinimalNoraArchive, titleForUri, requireFilePath } from "../nora-document.js";

const VIEW_TYPE = "nora.research";

/**
 * @param {vscode.ExtensionContext} context
 * @param {import("../document-registry.js").DocumentRegistry} registry
 * @param {import("../nora-editor-provider.js").NoraEditorProvider} provider
 */
export function registerDocumentCommands(context, registry, provider) {
  return [
    vscode.commands.registerCommand("nora.newResearch", () => newResearch(context)),
    vscode.commands.registerCommand("nora.undo", () => registry.activeDocument?.undo()),
    vscode.commands.registerCommand("nora.redo", () => registry.activeDocument?.redo()),
    vscode.commands.registerCommand("nora.ask", async () => {
      if (!await provider.postCommandToDocument(registry.activeDocument, "ask")) {
        await vscode.window.showInformationMessage("Open a Nora document before asking.");
      }
    }),
  ];
}

/** @param {vscode.ExtensionContext} context */
export async function newResearch(context) {
  const uri = await vscode.window.showSaveDialog({
    filters: { "Nora Research": ["nora"] },
    saveLabel: "Create Nora Research",
  });
  if (!uri) return;
  const filePath = requireFilePath(uri, "new research");
  await writeMinimalNoraArchive(filePath, titleForUri(uri));
  await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
}
