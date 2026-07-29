import path from "node:path";
import { createMarkdownExport } from "../../core/markdown-export.js";
import {
  collectNoraSnapshotAssetNames,
  createNoraSnapshotProjection,
} from "../../core/snapshot-projection.js";
import {
  buildSnapshotHtml,
  snapshotProjectionUsesMermaid,
  snapshotProjectionUsesPdf,
} from "../../core/snapshot-html.js";
import { documentStateToPersisted } from "../../core/document-state.js";
import { slugifyTitle } from "../../core/utils.js";

/**
 * @param {import("vscode").ExtensionContext} context
 * @param {import("../document-registry.js").DocumentRegistry} registry
 * @param {{ vscode?: typeof import("vscode") }} [options]
 */
export function registerExportCommands(context, registry, options = {}) {
  const api = requireVscodeApi(options.vscode);
  return [
    api.commands.registerCommand("nora.exportMarkdown", () => exportActiveMarkdown(context, api, registry)),
    api.commands.registerCommand("nora.exportSnapshot", () => exportActiveSnapshot(context, api, registry)),
  ];
}

/**
 * @param {import("vscode").ExtensionContext} context
 * @param {typeof import("vscode")} api
 * @param {import("../document-registry.js").DocumentRegistry} registry
 */
async function exportActiveMarkdown(context, api, registry) {
  const document = registry.activeDocument;
  if (!document) {
    await api.window.showInformationMessage("Open a Nora document before exporting Markdown.");
    return null;
  }
  return exportMarkdownDocument(context, api, document);
}

/**
 * @param {import("vscode").ExtensionContext} context
 * @param {typeof import("vscode")} api
 * @param {import("../document-registry.js").DocumentRegistry} registry
 */
async function exportActiveSnapshot(context, api, registry) {
  const document = registry.activeDocument;
  if (!document) {
    await api.window.showInformationMessage("Open a Nora document before exporting a snapshot.");
    return null;
  }
  return exportSnapshotDocument(context, api, document);
}

/**
 * @param {import("vscode").ExtensionContext} _context
 * @param {typeof import("vscode")} api
 * @param {import("../nora-document.js").NoraDocument} document
 * @param {{
 *   destination?: import("vscode").Uri | null,
 *   writeFile?: (uri: import("vscode").Uri, bytes: Uint8Array) => Promise<void>,
 *   rethrow?: boolean
 * }} [options]
 */
export async function exportMarkdownDocument(_context, api, document, options = {}) {
  const destination = options.destination ?? await api.window.showSaveDialog({
    defaultUri: defaultExportUri(api, document, "md"),
    filters: { Markdown: ["md"] },
    saveLabel: "Export Markdown",
  });
  if (!destination) return null;
  try {
    const markdown = createMarkdownExport(documentStateToPersisted(document.state));
    await (options.writeFile ?? api.workspace.fs.writeFile)(destination, Buffer.from(markdown, "utf8"));
    return { uri: destination, markdown };
  } catch (error) {
    await api.window.showErrorMessage(`Nora could not export Markdown: ${errorMessage(error)}`);
    if (options.rethrow) throw error;
    return null;
  }
}

/**
 * @param {import("vscode").ExtensionContext} context
 * @param {typeof import("vscode")} api
 * @param {import("../nora-document.js").NoraDocument} document
 * @param {{
 *   destination?: import("vscode").Uri | null,
 *   bundle?: Partial<SnapshotBundle>,
 *   writeFile?: (uri: import("vscode").Uri, bytes: Uint8Array) => Promise<void>,
 *   rethrow?: boolean
 * }} [options]
 */
export async function exportSnapshotDocument(context, api, document, options = {}) {
  const destination = options.destination ?? await api.window.showSaveDialog({
    defaultUri: defaultExportUri(api, document, "html"),
    filters: { HTML: ["html"] },
    saveLabel: "Export Snapshot",
  });
  if (!destination) return null;
  try {
    const html = await buildSnapshotHtmlForDocument(context, api, document, options.bundle ?? {});
    await (options.writeFile ?? api.workspace.fs.writeFile)(destination, Buffer.from(html, "utf8"));
    return { uri: destination, html };
  } catch (error) {
    await api.window.showErrorMessage(`Nora could not export snapshot: ${errorMessage(error)}`);
    if (options.rethrow) throw error;
    return null;
  }
}

/**
 * @typedef {{
 *   stylesheetText: string,
 *   dompurifySource: string,
 *   frozenClientSource: string,
 *   mermaidSource: string,
 *   pdfJsSource: string,
 *   pdfWorkerSource: string
 * }} SnapshotBundle
 */

/**
 * @param {import("vscode").ExtensionContext} context
 * @param {typeof import("vscode")} api
 * @param {import("../nora-document.js").NoraDocument} document
 * @param {Partial<SnapshotBundle>} bundle
 */
export async function buildSnapshotHtmlForDocument(context, api, document, bundle = {}) {
  const persisted = documentStateToPersisted(document.state);
  const assetData = await buildSnapshotAssetData(document, persisted);
  const projection = createNoraSnapshotProjection(persisted, persisted.viewState, assetData);
  const resources = await loadSnapshotBundle(context, api, projection, bundle);
  return buildSnapshotHtml({
    title: persisted.title || "Nora",
    stylesheetText: resources.stylesheetText,
    dompurifySource: resources.dompurifySource,
    mermaidSource: snapshotProjectionUsesMermaid(projection) ? resources.mermaidSource : "",
    pdfJsSource: snapshotProjectionUsesPdf(projection) ? resources.pdfJsSource : "",
    pdfWorkerSource: snapshotProjectionUsesPdf(projection) ? resources.pdfWorkerSource : "",
    frozenClientSource: resources.frozenClientSource,
    snapshotProjection: projection,
  });
}

/**
 * @param {import("../nora-document.js").NoraDocument} document
 * @param {import("../../core/contracts/document.js").NoraDocument} persisted
 */
async function buildSnapshotAssetData(document, persisted) {
  const names = new Set(collectNoraSnapshotAssetNames(persisted));
  /** @type {Record<string, string>} */
  const out = {};
  for (const entry of document.getAssetNames()) {
    if (!names.has(entry.name)) continue;
    const filePath = await document.materializeAssetByName(entry.name);
    const bytes = await import("node:fs/promises").then((fs) => fs.readFile(filePath));
    out[entry.name] = bytes.toString("base64");
  }
  return out;
}

/**
 * @param {import("vscode").ExtensionContext} context
 * @param {typeof import("vscode")} api
 * @param {ReturnType<typeof createNoraSnapshotProjection>} projection
 * @param {Partial<SnapshotBundle>} bundle
 * @returns {Promise<SnapshotBundle>}
 */
async function loadSnapshotBundle(context, api, projection, bundle) {
  const read = (/** @type {string[]} */ parts) => readText(api, api.Uri.joinPath(context.extensionUri, "out", "webview", ...parts));
  const stylesheetText = bundle.stylesheetText ?? [
    await read(["canvas.css"]),
    await read(["katex.css"]),
  ].join("\n");
  return {
    stylesheetText,
    dompurifySource: bundle.dompurifySource ?? await read(["dompurify.js"]),
    frozenClientSource: bundle.frozenClientSource ?? await read(["frozen-client.js"]),
    mermaidSource: bundle.mermaidSource ?? (snapshotProjectionUsesMermaid(projection) ? await read(["mermaid.js"]) : ""),
    pdfJsSource: bundle.pdfJsSource ?? (snapshotProjectionUsesPdf(projection) ? await read(["pdf.mjs"]) : ""),
    pdfWorkerSource: bundle.pdfWorkerSource ?? (snapshotProjectionUsesPdf(projection) ? await read(["pdf.worker.mjs"]) : ""),
  };
}

/**
 * @param {typeof import("vscode")} api
 * @param {import("vscode").Uri} uri
 */
async function readText(api, uri) {
  return Buffer.from(await api.workspace.fs.readFile(uri)).toString("utf8");
}

/**
 * @param {typeof import("vscode")} api
 * @param {import("../nora-document.js").NoraDocument} document
 * @param {"md" | "html"} extension
 */
function defaultExportUri(api, document, extension) {
  const baseName = `${slugifyTitle(document.state.title, { fallback: "nora-export" })}.${extension}`;
  const fsPath = document.filePath || document.uri?.fsPath;
  if (fsPath) return api.Uri.file(path.join(path.dirname(fsPath), baseName));
  return api.Uri.file(path.resolve(baseName));
}

/** @param {typeof import("vscode") | undefined} api */
function requireVscodeApi(api) {
  if (!api) throw new Error("VS Code API is required to register Nora export commands");
  return api;
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
