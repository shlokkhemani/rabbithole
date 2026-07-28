import * as vscode from "vscode";
import { createNoraWebviewHtml, createNonce } from "./webview-html.js";
import { serializeExtensionMessage, validateWebviewMessage } from "./protocol.js";

const VIEW_TYPE = "nora.research";
const COMMANDS = [
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

/** @param {vscode.ExtensionContext} context */
export function activate(context) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      new NoraEditorProvider(context),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
    vscode.commands.registerCommand("nora.newResearch", () => newResearch()),
    vscode.commands.registerCommand("nora.undo", () => vscode.commands.executeCommand("undo")),
    vscode.commands.registerCommand("nora.redo", () => vscode.commands.executeCommand("redo")),
    ...COMMANDS.map((command) => vscode.commands.registerCommand(command, () => showDeferredCommand(command))),
  );
}

export function deactivate() {}

class NoraDocument {
  /** @param {vscode.Uri} uri @param {Uint8Array} content */
  constructor(uri, content) {
    this.uri = uri;
    this.content = content;
  }

  /** @param {vscode.Uri} uri */
  static async open(uri) {
    const content = await vscode.workspace.fs.readFile(uri).then(
      (bytes) => bytes,
      (error) => {
        if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return new Uint8Array();
        throw error;
      },
    );
    return new NoraDocument(uri, content);
  }

  dispose() {}
}

class NoraEditorProvider {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeCustomDocument = this.changeEmitter.event;
  }

  /** @param {vscode.Uri} uri */
  openCustomDocument(uri) {
    return NoraDocument.open(uri);
  }

  /** @param {NoraDocument} document @param {vscode.WebviewPanel} panel */
  resolveCustomEditor(document, panel) {
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
    panel.title = titleForUri(document.uri);

    panel.webview.onDidReceiveMessage(async (raw) => {
      let message;
      try {
        message = validateWebviewMessage(raw);
      } catch (error) {
        await postError(panel, error);
        return;
      }
      if (message.type === "ready") {
        await postHydration(panel, document);
        return;
      }
      if (message.event.type === "done") {
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      }
    });
  }

  /** @param {NoraDocument} document */
  async saveCustomDocument(document) {
    await vscode.workspace.fs.writeFile(document.uri, document.content);
  }

  /** @param {NoraDocument} document @param {vscode.Uri} destination */
  async saveCustomDocumentAs(document, destination) {
    await vscode.workspace.fs.writeFile(destination, document.content);
  }

  /** @param {NoraDocument} document */
  async revertCustomDocument(document) {
    const reopened = await NoraDocument.open(document.uri);
    document.content = reopened.content;
  }

  /** @param {NoraDocument} document @param {vscode.CustomDocumentBackupContext} context */
  async backupCustomDocument(document, context) {
    await vscode.workspace.fs.writeFile(context.destination, document.content);
    return {
      id: context.destination.toString(),
      delete: () => vscode.workspace.fs.delete(context.destination).then(undefined, () => {}),
    };
  }
}

async function newResearch() {
  const uri = await vscode.window.showSaveDialog({
    filters: { "Nora Research": ["nora"] },
    saveLabel: "Create Nora Research",
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, new Uint8Array());
  await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
}

/** @param {string} command */
function showDeferredCommand(command) {
  const label = command.slice("nora.".length).replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
  return vscode.window.showInformationMessage(`Nora ${label} is not available in this migration slice.`);
}

/** @param {vscode.WebviewPanel} panel @param {NoraDocument} document */
function postHydration(panel, document) {
  return panel.webview.postMessage(serializeExtensionMessage({
    type: "hydrate",
    hydration: hydrationForDocument(document),
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

/** @param {NoraDocument} document */
function hydrationForDocument(document) {
  const title = titleForUri(document.uri);
  const modified = document.content.byteLength ? "Existing archive content will be loaded by the Nora document slice." : "";
  return {
    session_id: `vscode-${document.uri.toString()}`,
    hole_id: document.uri.toString(),
    title,
    root_id: "root",
    last_event_id: 0,
    agent_attached: false,
    view_state: { mode: "reader", node_id: "root", scroll: 0 },
    nodes: [{
      id: "root",
      parent_id: null,
      title,
      markdown: [`# ${title}`, modified].filter(Boolean).join("\n\n"),
      base_url: null,
      base_url_source: null,
      origin: null,
      position: { x: 0, y: 0 },
      size: null,
      font_scale: 1,
      collapsed: false,
      status: "answered",
      read: true,
      extensions: {},
    }],
  };
}

/** @param {vscode.Uri} uri */
function titleForUri(uri) {
  const name = uri.path.split("/").pop() || "Untitled";
  return name.replace(/\.nora$/i, "") || "Untitled";
}
