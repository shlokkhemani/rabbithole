import {
  DEFAULT_CHILD,
  DEFAULT_ROOT,
  MAX_SCALE,
  MIN_SCALE,
  currentNodeId,
  frozen,
  hydration,
  nextOrder,
  nodes,
  registerNode,
  rootId,
  setCanvasFramed,
  setCurrentNodeId,
  setViewAdjusted,
  view
} from "./core.js";
import { openNode } from "./reader.js";
import { setMode } from "./canvas-view.js";
import { setRendererAssetData } from "./renderer.js";

export function hydrateInitialState({ connectSse = null, refreshStatus = null } = {}) {
  setRendererAssetData(hydration.asset_data || null);
  if (frozen) document.body.classList.add("frozen");
  (hydration.nodes || []).forEach(function(raw){
    var isRoot = raw.id === rootId;
    var size = raw.size || (isRoot ? DEFAULT_ROOT : DEFAULT_CHILD);
    var node = registerNode({
      id: raw.id, parent_id: raw.parent_id, title: raw.title,
      html: "", md: raw.markdown || "",
      base_url: raw.base_url || null, base_url_source: raw.base_url_source || null,
      read: !!raw.read, origin: raw.origin,
      x: (raw.position && raw.position.x) || 0, y: (raw.position && raw.position.y) || 0,
      w: size.w, h: size.h, font_scale: raw.font_scale || 1, collapsed: !!raw.collapsed,
      status: raw.status || "answered", _order: 0,
      extensions: raw.extensions || {},
      _startTs: (raw.status === "pending") ? Date.now() : 0
    });
  });
  Object.keys(nodes).forEach(function(id){ nodes[id]._order = nextOrder(); });
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
    setViewAdjusted(true); // keep an existing user view in later state saves
  }
  openNode(currentNodeId); // READER is the default; canvas DOM is built lazily
  if (vs && vs.mode === "canvas") setMode("canvas");
  if (typeof refreshStatus === "function") refreshStatus();
  if (!frozen && typeof connectSse === "function") connectSse();
}
