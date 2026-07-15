import { CANVAS_SHELL } from "./html/shell.js";
import { escapeHtml, serializeForInlineScript } from "./utils.js";

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
    "\n" + payloadOpen + serializeForInlineScript(snapshotProjection) + scriptClose +
    "\n" + scriptOpen + "\n" +
    dompurifySource +
    (mermaidSource ? "\n" + mermaidSource : "") +
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

/** @param {import("./contracts/artifact.js").PortableArtifact | null | undefined} snapshotProjection */
export function snapshotUsesMermaid(snapshotProjection) {
  const nodes = snapshotProjection?.hole?.nodes;
  if (!Array.isArray(nodes)) return false;
  return nodes.some((node) => /(?:^|\n) {0,3}(?:`{3,}|~{3,})[ \t]*mermaid(?=$|[ \t\r\n])/i.test(String(node?.markdown || "")));
}
