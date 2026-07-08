/**
 * Self-contained page for a Rabbithole.
 *
 * The frontend is authored as three focused strings (styles, shell, browser
 * runtime) and assembled here into one HTML document. The output is still a
 * single-file page for live sessions and frozen exports.
 */

import { escapeHtml, serializeForInlineScript } from "../utils.js";
import { getClientBundle, getDompurifyScript, getFrozenClientBundle, getKatexCss } from "./built-assets.js";
import { CANVAS_SHELL } from "./shell.js";
import { CANVAS_STYLES } from "./styles.js";

export function buildCanvasHtml(hydration) {
  const title = hydration?.title || "Rabbithole";
  const hydrationJson = serializeForInlineScript(hydration);
  const frozen = !!hydration?.frozen;
  const clientBundle = frozen ? getFrozenClientBundle() : getClientBundle();
  const clientGlobal = frozen ? "RabbitholeFrozenClient" : "RabbitholeClient";
  const liveSnapshotSource = frozen
    ? ""
    : `  window.__RABBITHOLE_FROZEN_CLIENT__ = ${serializeForInlineScript(getFrozenClientBundle())};\n`;

  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${CANVAS_STYLES}
${getKatexCss()}
</style>
</head>
<body>
${CANVAS_SHELL}
<script>
${getDompurifyScript()}
(function(){
	  "use strict";
	  var hydration = ${hydrationJson};
	${liveSnapshotSource}${clientBundle}
	  ${clientGlobal}.startRabbithole(hydration);
	})();
</script>
</body>
</html>`;
}
