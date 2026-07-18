import { CANVAS_SHELL } from "./html/shell.js";
import { markdownContainsBlockType } from "./blocks.js";
import { escapeHtml, serializeForInlineScript } from "./utils.js";

/** @param {import("./contracts/artifact.js").PortableArtifact | null | undefined} projection */
export function snapshotProjectionUsesMermaid(projection) {
  return !!projection?.hole?.nodes?.some((node) => markdownContainsBlockType(node?.markdown, "mermaid"));
}

/** @param {unknown} source */
function mermaidRuntimeCarrier(source) {
  const escaped = String(source || "").replace(/<\/script/gi, "<\\/script");
  return `<script type="application/vnd.rabbithole+mermaid" id="rabbithole-mermaid-runtime">${escaped}</script>`;
}

/**
 * @param {{
 *   title: string,
 *   stylesheetText: string,
 *   dompurifySource: string,
 *   mermaidSource?: string,
 *   frozenClientSource: string,
 *   snapshotProjection: import("./contracts/artifact.js").PortableArtifact
 * }} options
 */
export function buildSnapshotHtml({ title, stylesheetText, dompurifySource, mermaidSource = "", frozenClientSource, snapshotProjection }) {
  const usesMermaid = snapshotProjectionUsesMermaid(snapshotProjection);
  if (usesMermaid && !mermaidSource) throw new Error("Mermaid runtime is unavailable for this snapshot");
  var lt = String.fromCharCode(60);
  var gt = String.fromCharCode(62);
  var scriptOpen = lt + "script" + gt;
  var scriptClose = lt + String.fromCharCode(47) + "script" + gt;
  var payloadOpen = lt + 'script type="application/vnd.rabbithole+json" id="rabbithole-portable"' + gt;
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
    (usesMermaid ? "\n" + mermaidRuntimeCarrier(mermaidSource) : "") +
    "\n" + payloadOpen + serializeForInlineScript(snapshotProjection) + scriptClose +
    "\n" + scriptOpen + "\n" +
    dompurifySource +
    "\n(function(){\n" +
    '  "use strict";\n' +
    frozenClientSource +
    "\n  var payload = document.getElementById(\"rabbithole-portable\");\n" +
    "  RabbitholeFrozenClient.startPortableSnapshot(JSON.parse(payload.textContent));\n" +
    "})();\n" +
    scriptClose + "\n" +
    "</body>\n" +
    "</html>";
}
