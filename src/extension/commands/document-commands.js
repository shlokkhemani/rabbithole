import * as vscode from "vscode";
import { writeMinimalNoraArchive, titleForUri, requireFilePath } from "../nora-document.js";

const VIEW_TYPE = "nora.research";
const DEFERRED_COMMANDS = [
  "nora.ask",
  "nora.selectProfile",
  "nora.setCredential",
  "nora.signIn",
  "nora.signOut",
  "nora.addRepository",
  "nora.addAttachment",
  "nora.exportMarkdown",
  "nora.exportSnapshot",
];

/**
 * @param {vscode.ExtensionContext} context
 * @param {import("../document-registry.js").DocumentRegistry} registry
 */
export function registerDocumentCommands(context, registry) {
  return [
    vscode.commands.registerCommand("nora.newResearch", () => newResearch(context)),
    vscode.commands.registerCommand("nora.undo", () => registry.activeDocument?.undo()),
    vscode.commands.registerCommand("nora.redo", () => registry.activeDocument?.redo()),
    ...DEFERRED_COMMANDS.map((command) => vscode.commands.registerCommand(command, () => showDeferredCommand(command))),
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

/** @param {string} command */
function showDeferredCommand(command) {
  const label = command.slice("nora.".length).replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
  return vscode.window.showInformationMessage(`Nora ${label} is not available in this migration slice.`);
}
