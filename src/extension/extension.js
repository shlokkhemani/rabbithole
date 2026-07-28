import * as vscode from "vscode";
import { registerDocumentCommands } from "./commands/document-commands.js";
import { DocumentRegistry } from "./document-registry.js";
import { NoraEditorProvider, VIEW_TYPE } from "./nora-editor-provider.js";

/** @param {vscode.ExtensionContext} context */
export function activate(context) {
  const registry = new DocumentRegistry();
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      new NoraEditorProvider(context, registry),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
    ...registerDocumentCommands(context, registry),
  );
}

export function deactivate() {}
