/**
 * Self-contained page for a Rabbithole.
 *
 * The frontend is authored as three focused strings (styles, shell, browser
 * runtime) and assembled here into one HTML document. The output is still a
 * single-file page for live sessions and frozen exports.
 */

import { escapeHtml, serializeForInlineScript } from "../utils.js";
import { renderClientScript } from "./client-script.js";
import { CANVAS_SHELL } from "./shell.js";
import { CANVAS_STYLES } from "./styles.js";
import { getDompurifyScript, getKatexCss } from "./vendor-css.js";

export function buildCanvasHtml(hydration) {
  const title = hydration?.title || "Rabbithole";
  const hydrationJson = serializeForInlineScript(hydration);

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
${renderClientScript(hydrationJson)}
</script>
</body>
</html>`;
}
