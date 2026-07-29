import * as vscode from "vscode";
import { addFileAttachmentToDocument } from "../attachments.js";

/**
 * @param {import("vscode").ExtensionContext} _context
 * @param {import("../document-registry.js").DocumentRegistry} registry
 * @param {{ vscode?: typeof import("vscode") }} [options]
 */
export function registerAttachmentCommands(_context, registry, options = {}) {
  const api = options.vscode ?? vscode;
  return [
    api.commands.registerCommand("nora.addAttachment", () => addAttachment(api, registry)),
  ];
}

/**
 * @param {typeof import("vscode")} api
 * @param {import("../document-registry.js").DocumentRegistry} registry
 */
async function addAttachment(api, registry) {
  const document = registry.activeDocument;
  if (!document) {
    await api.window.showInformationMessage("Open a Nora document before adding an attachment.");
    return;
  }
  const picked = await api.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    title: "Add attachment to Nora",
    filters: {
      "Research attachments": ["pdf", "png", "jpg", "jpeg", "gif", "webp", "svg", "txt", "md", "json", "csv"],
      "All files": ["*"],
    },
  });
  if (!picked?.length) return;
  for (const uri of picked) {
    await addFileAttachmentToDocument(document, uri.fsPath);
  }
  await api.window.showInformationMessage(`Added ${picked.length} attachment${picked.length === 1 ? "" : "s"} to Nora.`);
}
