import * as vscode from "vscode";
import { registerDocumentCommands } from "./commands/document-commands.js";
import { registerLlmCommands } from "./commands/llm-commands.js";
import { DocumentRegistry } from "./document-registry.js";
import { NoraEditorProvider, VIEW_TYPE } from "./nora-editor-provider.js";

/** @param {vscode.ExtensionContext} context */
export function activate(context) {
  const registry = new DocumentRegistry();
  const provider = new NoraEditorProvider(context, registry);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      provider,
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
    ...registerDocumentCommands(context, registry, provider),
    ...registerLlmCommands(context, registry, { vscode }),
  );
}

export function deactivate() {}
