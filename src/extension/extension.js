import * as vscode from "vscode";
import { registerDocumentCommands } from "./commands/document-commands.js";
import { registerAttachmentCommands } from "./commands/attachment-commands.js";
import { registerExportCommands } from "./commands/export-commands.js";
import { registerLlmCommands } from "./commands/llm-commands.js";
import { registerRepositoryCommands } from "./commands/repository-commands.js";
import { DocumentRegistry } from "./document-registry.js";
import { NoraRunController } from "./agent/run-controller.js";
import { McpSupervisor } from "./mcp/supervisor.js";
import { NoraEditorProvider, VIEW_TYPE } from "./nora-editor-provider.js";
import { runVsixSmoke } from "./testing/pi-smoke.js";

/** @param {vscode.ExtensionContext} context */
export function activate(context) {
  const registry = new DocumentRegistry();
  const outputChannel = vscode.window.createOutputChannel("Nora");
  const mcpSupervisor = new McpSupervisor({ outputChannel });
  const provider = new NoraEditorProvider(context, registry, {
    runController: new NoraRunController({
      vscode,
      secretStorage: context.secrets,
      mcpSupervisor,
    }),
  });
  const mcpConfigWatcher = vscode.workspace.createFileSystemWatcher("**/.vscode/mcp.json");
  /** @param {vscode.Uri} uri */
  const markMcpConfigChanged = (uri) => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    mcpSupervisor.markWorkspaceChanged(folder?.uri.fsPath ?? null);
  };
  mcpConfigWatcher.onDidCreate(markMcpConfigChanged);
  mcpConfigWatcher.onDidChange(markMcpConfigChanged);
  mcpConfigWatcher.onDidDelete(markMcpConfigChanged);
  context.subscriptions.push(
    outputChannel,
    mcpConfigWatcher,
    { dispose: () => { void mcpSupervisor.dispose(); } },
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      provider,
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
    ...registerDocumentCommands(context, registry, provider),
    ...registerAttachmentCommands(context, registry, { vscode }),
    ...registerExportCommands(context, registry, { vscode }),
    ...registerLlmCommands(context, registry, { vscode }),
    ...registerRepositoryCommands(context, registry, { vscode }),
  );
  if (process.env.NORA_VSIX_SMOKE === "1") {
    return {
      runVsixSmoke: () => runVsixSmoke({ extensionPath: context.extensionPath }),
    };
  }
  return undefined;
}

export function deactivate() {}
