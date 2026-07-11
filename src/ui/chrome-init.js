import {
  currentNodeId,
  flashHint,
  mode,
  nodes,
  toggleTheme,
} from "./core.js";
import { focusedMark, jumpToOrigin, openNode, stepMark } from "./reader.js";
import { frameAll, tidy } from "./canvas-view.js";
import { togglePalette } from "./palette.js";
import { hydrateInitialState } from "./hydrate.js";
import { createCleanupScope } from "./lifecycle.js";

var chromeScope = null;

  // ===========================================================================
  // chrome (theme, hint, keys)
  // ===========================================================================
export function initChrome(options){
  disposeChrome();
  chromeScope = createCleanupScope();
  chromeScope.listen(document, "keydown", onGlobalKeydown);
  try {
    applyInitialTheme();
    hydrateInitialState(options || {});
  } catch (error) {
    disposeChrome();
    throw error;
  }
  return disposeChrome;
}

export function disposeChrome(){
  var scope = chromeScope;
  chromeScope = null;
  if (scope) scope.dispose();
}

function onGlobalKeydown(e){
    // ⌘K works everywhere, even from inside a textarea — it's the escape hatch.
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")){
      e.preventDefault();
      togglePalette();
      return;
    }
    if (e.target && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT")) return;
    if (e.key === "?"){ flashHint("j / k — walk the highlights · ↵ open · ⌫ up a level · ⌘K search"); return; }
    if (e.key === "Escape" && mode === "canvas"){ openNode(currentNodeId); return; }
    if ((e.key === "f" || e.key === "F") && mode === "canvas"){ frameAll(true, "keyboard"); return; }
    if ((e.key === "t" || e.key === "T") && mode === "canvas"){ tidy("keyboard"); return; }
    if (mode !== "reader") return;
    // Reading is keyboard-shaped; branching is too: j/k walk the marks in this
    // document, ↵ dives into the focused branch, ⌫ surfaces to the parent.
    if (e.key === "j" || e.key === "k"){ e.preventDefault(); stepMark(e.key === "j" ? 1 : -1); }
    else if (e.key === "Enter"){
      var m = focusedMark();
      if (m){ e.preventDefault(); var kid = nodes[m.dataset.child]; if (kid) openNode(kid.id); }
    }
    else if (e.key === "Backspace"){
      var cur = nodes[currentNodeId];
      if (cur && cur.parent_id && nodes[cur.parent_id]){ e.preventDefault(); jumpToOrigin(cur, "keyboard"); }
    }
}

  // A saved choice wins; otherwise the page follows the system preference.
function applyInitialTheme(){
  try {
    var savedTheme = localStorage.getItem("rh-theme");
    if (!savedTheme && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) savedTheme = "dark";
    if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);
  } catch(e){}
}
