import {
  DEFAULT_CHILD,
  DEFAULT_ROOT,
  MAX_SCALE,
  MIN_SCALE,
  armSince,
  currentNodeId,
  flashHint,
  frozen,
  hydration,
  mode,
  nextOrder,
  nodes,
  refreshAmbient,
  rootId,
  setCanvasFramed,
  setCurrentNodeId,
  toggleTheme,
  unreadNodes,
  updateSince,
  view
} from "./core.js";
import { focusedMark, jumpToOrigin, openNode, stepMark } from "./reader.js";
import { frameAll, setMode, tidy } from "./canvas-view.js";
import { togglePalette } from "./palette.js";
import { connectSse, post, refreshStatus } from "./transport-status.js";

  // ===========================================================================
  // chrome (theme, hint, keys)
  // ===========================================================================
export function initChrome(){
  document.addEventListener("keydown", onGlobalKeydown);
  applyInitialTheme();
  hydrateInitialState();
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

  // ===========================================================================
  // init
  // ===========================================================================
function hydrateInitialState(){
    if (frozen) document.body.classList.add("frozen");
    (hydration.nodes || []).forEach(function(raw){
      var isRoot = raw.id === rootId;
      var size = raw.size || (isRoot ? DEFAULT_ROOT : DEFAULT_CHILD);
      nodes[raw.id] = {
        id: raw.id, parent_id: raw.parent_id, title: raw.title, html: raw.contentHtml,
        md: raw.markdown || "", read: !!raw.read, origin: raw.origin,
        x: (raw.position && raw.position.x) || 0, y: (raw.position && raw.position.y) || 0,
        w: size.w, h: size.h, font_scale: raw.font_scale || 1, collapsed: !!raw.collapsed,
        status: raw.status || "answered", _order: 0,
        _startTs: (raw.status === "pending") ? Date.now() : 0
      };
    });
    Object.keys(nodes).forEach(function(id){ nodes[id]._order = nextOrder(); });
    // Holes saved before read-tracking would wake up all-unread. If nothing was
    // ever marked read (and no view was ever saved), treat the past as read.
    var anyRead = false, k;
    for (k in nodes) if (nodes[k].read) anyRead = true;
    if (!anyRead && !hydration.view_state){
      var legacy = [];
      for (k in nodes){
        if (nodes[k].status === "answered"){ nodes[k].read = true; legacy.push({ node_id: k, read: true }); }
      }
      if (!frozen && legacy.length) post({ type: "nodes_update", nodes: legacy });
    }
    // Land exactly where the human left off: same document, same scroll, same
    // canvas framing, same mode. A first open starts at the root like always.
    var vs = hydration.view_state;
    if (vs && vs.node_id && nodes[vs.node_id]){
      setCurrentNodeId(vs.node_id);
      if (vs.scroll) nodes[vs.node_id]._scrollTop = vs.scroll;
    }
    if (vs && vs.view){
      view.x = vs.view.x; view.y = vs.view.y;
      view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, vs.view.scale || 1));
      setCanvasFramed(true); // the saved framing wins; don't re-frame on first entry
    }
    openNode(currentNodeId); // READER is the default; canvas DOM is built lazily
    if (vs && vs.mode === "canvas") setMode("canvas");
    if (unreadNodes().length){ armSince(); updateSince(); }
    refreshAmbient();
    refreshStatus();
    if (!frozen) connectSse();
}
