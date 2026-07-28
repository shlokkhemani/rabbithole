import { CANVAS_SHELL } from "./html/shell.js";
import { markdownContainsBlockType } from "./blocks.js";
import { escapeHtml, serializeForInlineScript } from "./utils.js";

/** @param {ReturnType<import("./snapshot-projection.js").createNoraSnapshotProjection> | null | undefined} projection */
export function snapshotProjectionUsesMermaid(projection) {
  return !!projectionNodes(projection).some((/** @type {any} */ node) => markdownContainsBlockType(node?.markdown, "mermaid"));
}

/** @param {ReturnType<import("./snapshot-projection.js").createNoraSnapshotProjection> | null | undefined} projection */
export function snapshotProjectionUsesPdf(projection) {
  return !!projectionNodes(projection).some((/** @type {any} */ node) => node?.extensions?.pdf?.version === 2 && !node.extensions.pdf.converted);
}

/** @param {unknown} source */
function mermaidRuntimeCarrier(source) {
  const escaped = String(source || "").replace(/<\/script/gi, "<\\/script");
  return `<script type="application/vnd.nora+mermaid" id="nora-mermaid-runtime">${escaped}</script>`;
}

/**
 * @param {{
 *   title: string,
 *   stylesheetText: string,
 *   dompurifySource: string,
 *   mermaidSource?: string,
 *   frozenClientSource: string,
 *   pdfWorkerSource?: string,
 *   pdfJsSource?: string,
 *   snapshotProjection: ReturnType<import("./snapshot-projection.js").createNoraSnapshotProjection>
 * }} options
 */
export function buildSnapshotHtml({ title, stylesheetText, dompurifySource, mermaidSource = "", pdfJsSource = "", pdfWorkerSource = "", frozenClientSource, snapshotProjection }) {
  const usesMermaid = snapshotProjectionUsesMermaid(snapshotProjection);
  const usesPdf = snapshotProjectionUsesPdf(snapshotProjection);
  if (usesMermaid && !mermaidSource) throw new Error("Mermaid runtime is unavailable for this snapshot");
  if (usesPdf && (!pdfWorkerSource || !pdfJsSource)) throw new Error("PDF runtime is unavailable for this snapshot");
  var lt = String.fromCharCode(60);
  var gt = String.fromCharCode(62);
  var scriptOpen = lt + "script" + gt;
  var scriptClose = lt + String.fromCharCode(47) + "script" + gt;
  var payloadOpen = snapshotPayloadOpen(snapshotProjection, lt, gt);
  return "<!DOCTYPE html>\n" +
    '<html lang="en" data-theme="light">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<title>" + escapeHtml(title) + "</title>\n" +
    "<style>\n" + stylesheetText + "\n</style>\n" +
    "</head>\n" +
    "<body>\n" +
    CANVAS_SHELL +
    renderSnapshotEvidence(snapshotProjection) +
    (usesMermaid ? "\n" + mermaidRuntimeCarrier(mermaidSource) : "") +
    (usesPdf ? "\n" + pdfJsRuntimeCarrier(pdfJsSource) + "\n" + pdfWorkerRuntimeCarrier(pdfWorkerSource) : "") +
    "\n" + payloadOpen + serializeForInlineScript(snapshotProjection) + scriptClose +
    "\n" + scriptOpen + "\n" +
    dompurifySource +
    "\n(function(){\n" +
    '  "use strict";\n' +
    frozenClientSource +
    "\n  var payload = document.getElementById(\"nora-snapshot\");\n" +
    "  var client = (typeof NoraFrozenClient !== \"undefined\" && NoraFrozenClient) || globalThis.NoraFrozenClient;\n" +
    "  if (!client) throw new Error(\"Frozen snapshot client is unavailable\");\n" +
    "  client.startPortableSnapshot(JSON.parse(payload.textContent));\n" +
    "})();\n" +
    scriptClose + "\n" +
    "</body>\n" +
    "</html>";
}

/** @param {unknown} source */
function pdfJsRuntimeCarrier(source) {
  const escaped = String(source || "").replace(/<\/script/gi, "<\\/script");
  return `<script type="application/vnd.nora+pdfjs" id="nora-pdfjs-runtime">${escaped}</script>`;
}

/** @param {unknown} source */
function pdfWorkerRuntimeCarrier(source) {
  const escaped = String(source || "").replace(/<\/script/gi, "<\\/script");
  return `<script type="application/vnd.nora+pdf-worker" id="nora-pdf-worker-runtime">${escaped}</script>`;
}

/** @param {unknown} projection */
function projectionNodes(projection) {
  const raw = /** @type {any} */ (projection);
  return raw?.document?.nodes ?? [];
}

/** @param {unknown} projection @param {string} lt @param {string} gt */
function snapshotPayloadOpen(projection, lt, gt) {
  const raw = /** @type {{ format?: unknown }} */ (projection);
  if (raw?.format === "nora-snapshot") return lt + 'script type="application/vnd.nora+json" id="nora-snapshot"' + gt;
  throw new Error("Snapshot projection must use the Nora snapshot format");
}

/** @param {unknown} projection */
function renderSnapshotEvidence(projection) {
  const evidence = /** @type {{ document?: { evidence?: Array<Record<string, unknown>> } }} */ (projection)?.document?.evidence ?? [];
  const linked = evidence.filter((record) => typeof record.permalink === "string" && record.permalink);
  if (!linked.length) return "";
  return "\n<section id=\"nora-snapshot-evidence\" aria-label=\"Evidence links\">\n" +
    "<h2>Evidence</h2>\n<ol>\n" +
    linked.map((record) => {
      const title = String(record.title || record.permalink);
      const href = String(record.permalink);
      const commit = record.commit ? ` <span>${escapeHtml(String(record.commit).slice(0, 12))}</span>` : "";
      return `<li><a href="${escapeHtml(href)}" rel="noreferrer">${escapeHtml(title)}</a>${commit}</li>`;
    }).join("\n") +
    "\n</ol>\n</section>";
}
