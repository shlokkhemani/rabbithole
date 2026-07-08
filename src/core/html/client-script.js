/*
 * Assembles the browser runtime for the self-contained Rabbithole page.
 * The runtime chunks are ordinary strings so their escape behavior matches the
 * former single template literal exactly; hydration is the only interpolation.
 */
import { CLIENT_CORE } from "./client/core.js";
import { CLIENT_VISUALS } from "./client/visuals.js";
import { CLIENT_READER } from "./client/reader.js";
import { CLIENT_CANVAS_VIEW } from "./client/canvas-view.js";
import { CLIENT_ASK_FOLLOWUPS } from "./client/ask-followups.js";
import { CLIENT_PALETTE } from "./client/palette.js";
import { CLIENT_BRANCH_SURFACES } from "./client/branch-surfaces.js";
import { CLIENT_TRANSPORT_STATUS } from "./client/transport-status.js";
import { CLIENT_CHROME_INIT } from "./client/chrome-init.js";

const CLIENT_PREFIX = `(function(){
  "use strict";
  var hydration = `;
const LINE_BREAK = String.fromCharCode(10);

export function renderClientScript(hydrationJson) {
  return [
    CLIENT_PREFIX + hydrationJson + ";" + LINE_BREAK,
    CLIENT_CORE,
    CLIENT_VISUALS,
    CLIENT_READER,
    CLIENT_CANVAS_VIEW,
    CLIENT_ASK_FOLLOWUPS,
    CLIENT_PALETTE,
    CLIENT_BRANCH_SURFACES,
    CLIENT_TRANSPORT_STATUS,
    CLIENT_CHROME_INIT
  ].join("");
}
