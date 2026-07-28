import * as vscode from "vscode";
import { createNoraWebviewHtml, createNonce } from "./webview-html.js";
import { serializeExtensionMessage, validateWebviewMessage } from "./protocol.js";
import { NoraDocument, requireFilePath, titleForUri } from "./nora-document.js";
import { resolveWorkspaceScope } from "./workspace-scope.js";
import { NoraRunController } from "./agent/run-controller.js";

export const VIEW_TYPE = "nora.research";

/** @implements {vscode.CustomEditorProvider<vscode.CustomDocument>} */
export class NoraEditorProvider {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {import("./document-registry.js").DocumentRegistry} registry
   * @param {{ runController?: NoraRunController }} [options]
   */
  constructor(context, registry, options = {}) {
    this.context = context;
    this.registry = registry;
    this.runController = options.runController ?? new NoraRunController({
      vscode,
      secretStorage: context.secrets,
    });
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeCustomDocument = this.changeEmitter.event;
    /** @type {WeakMap<NoraDocument, Set<vscode.WebviewPanel>>} */
    this.panels = new WeakMap();
  }

  /**
   * @param {vscode.Uri} uri
   * @param {vscode.CustomDocumentOpenContext} openContext
   */
  async openCustomDocument(uri, openContext) {
    if (uri.scheme !== "file" && uri.scheme !== "untitled") throw new Error(`Nora can open only local file documents in v1: ${uri.toString()}`);
    const backupUri = openContext.backupId ? vscode.Uri.parse(openContext.backupId) : null;
    if (backupUri && backupUri.scheme !== "file") throw new Error(`Nora backups must be local files: ${backupUri.toString()}`);
    const document = await NoraDocument.open(uri, {
      archivePath: backupUri?.fsPath ?? null,
      untitledDocumentData: openContext.untitledDocumentData ?? null,
      title: titleForUri(uri),
      tempRoot: vscode.Uri.joinPath(this.context.globalStorageUri, "tmp").fsPath,
    });
    const registryEntry = this.registry.add(document);
    document.onDidDispose(() => registryEntry.dispose());
    document.onDidChange(() => {
      this.changeEmitter.fire(Object.freeze({ document }));
      this.#postHydrationToPanels(document);
    });
    document.onDidRequestSave(() => vscode.commands.executeCommand("workbench.action.files.save"));
    return document;
  }

  /**
   * @param {vscode.CustomDocument} document
   * @param {vscode.WebviewPanel} panel
   */
  async resolveCustomEditor(document, panel) {
    const noraDocument = asNoraDocument(document);
    if (noraDocument.uri && /** @type {vscode.Uri} */ (noraDocument.uri).scheme !== "untitled") {
      await resolveWorkspaceScope(vscode, /** @type {vscode.Uri} */ (noraDocument.uri));
    }
    const webview = panel.webview;
    const assetRoot = vscode.Uri.joinPath(this.context.extensionUri, "out", "webview");
    webview.options = {
      enableScripts: true,
      localResourceRoots: [assetRoot],
    };
    webview.html = createNoraWebviewHtml({
      nonce: createNonce(),
      cspSource: webview.cspSource,
      assetBaseUri: `${webview.asWebviewUri(assetRoot)}/`,
      scriptUri: String(webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, "nora-entry.js"))),
      canvasStyleUri: String(webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, "canvas.css"))),
      katexStyleUri: String(webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, "katex.css"))),
      dompurifyUri: String(webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, "dompurify.js"))),
    });
    panel.title = titleForUri(noraDocument.uri);
    this.#trackPanel(noraDocument, panel);
    if (panel.active) this.registry.setActive(noraDocument);

    panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) this.registry.setActive(noraDocument);
    });
    panel.onDidDispose(() => {
      this.#untrackPanel(noraDocument, panel);
      if (this.registry.activeDocument === noraDocument) this.registry.clearActive();
    });
    panel.webview.onDidReceiveMessage(async (raw) => {
      let message;
      try {
        message = validateWebviewMessage(raw);
      } catch (error) {
        await postError(panel, error);
        return;
      }
      if (message.type === "ready") {
        await postHydration(panel, noraDocument);
        return;
      }
      if (message.event.type === "done") {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        return;
      }
      if (message.event.type === "nora_ask" || message.event.type === "branch_request") {
        try {
          await this.runController.startFromWebviewEvent(noraDocument, message.event);
        } catch (error) {
          await postError(panel, error);
        }
        return;
      }
      try {
        await noraDocument.commitWebviewEvent(message.event);
      } catch (error) {
        await postError(panel, error);
      }
    });
  }

  /** @param {vscode.CustomDocument} document */
  async saveCustomDocument(document) {
    await asNoraDocument(document).save();
  }

  /** @param {vscode.CustomDocument} document @param {vscode.Uri} destination */
  async saveCustomDocumentAs(document, destination) {
    requireFilePath(destination, "save-as");
    await asNoraDocument(document).saveAs(destination);
  }

  /** @param {vscode.CustomDocument} document */
  async revertCustomDocument(document) {
    await asNoraDocument(document).revert();
  }

  /** @param {vscode.CustomDocument} document @param {vscode.CustomDocumentBackupContext} context */
  async backupCustomDocument(document, context) {
    requireFilePath(context.destination, "backup");
    await asNoraDocument(document).backupToPath(context.destination.fsPath);
    return {
      id: context.destination.toString(),
      delete: async () => {
        await vscode.workspace.fs.delete(context.destination).then(undefined, () => undefined);
      },
    };
  }

  /** @param {NoraDocument} document @param {vscode.WebviewPanel} panel */
  #trackPanel(document, panel) {
    let panels = this.panels.get(document);
    if (!panels) {
      panels = new Set();
      this.panels.set(document, panels);
    }
    panels.add(panel);
  }

  /** @param {NoraDocument} document @param {vscode.WebviewPanel} panel */
  #untrackPanel(document, panel) {
    this.panels.get(document)?.delete(panel);
  }

  /** @param {NoraDocument} document */
  #postHydrationToPanels(document) {
    for (const panel of this.panels.get(document) ?? []) {
      void postHydration(panel, document);
    }
  }

  /**
   * @param {NoraDocument | null | undefined} document
   * @param {"ask"} command
   */
  async postCommandToDocument(document, command) {
    if (!document) return false;
    const panels = this.panels.get(document);
    if (!panels || panels.size === 0) return false;
    await Promise.all([...panels].map((panel) => panel.webview.postMessage(serializeExtensionMessage({ type: "command", command }))));
    return true;
  }
}

/** @param {vscode.CustomDocument} document @returns {NoraDocument} */
function asNoraDocument(document) {
  if (!(document instanceof NoraDocument)) throw new Error("Unexpected Nora custom document instance");
  return document;
}

/** @param {vscode.WebviewPanel} panel @param {NoraDocument} document */
function postHydration(panel, document) {
  return panel.webview.postMessage(serializeExtensionMessage({
    type: "hydrate",
    hydration: document.toHydration(),
    readonly: false,
  }));
}

/** @param {vscode.WebviewPanel} panel @param {unknown} error */
function postError(panel, error) {
  return panel.webview.postMessage(serializeExtensionMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  }));
}
