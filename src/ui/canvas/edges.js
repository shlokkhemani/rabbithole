import { childrenOf, edgesSvg, isVisible, mode, nodes, SVGNS, view } from "../core.js";
import { transitionMarkGroups } from "../text-marks.js";
import { r } from "./runtime.js";
import { canvasBody, canvasCard, isFollowup } from "./shared.js";
export function requestEdgeFrame() {
  if (r.edgeRaf) return;
  r.edgeRaf = requestAnimationFrame(function () {
    r.edgeRaf = 0;
    const redrawAll = r.edgeRedrawAll;
    const ids = r.edgeRedrawIds;
    r.edgeRedrawAll = false;
    r.edgeRedrawIds = {};
    if (redrawAll) drawEdges();
    else drawEdgeSubset(ids);
  });
}

export function scheduleEdges() {
  r.edgeRedrawAll = true;
  r.edgeRedrawIds = {};
  requestEdgeFrame();
}

export function scheduleNodeEdges(node) {
  if (!node || r.edgeRedrawAll) return requestEdgeFrame();
  if (node.parent_id) r.edgeRedrawIds[node.id] = true;
  const kids = childrenOf(node.id);
  for (let i = 0; i < kids.length; i++) r.edgeRedrawIds[kids[i].id] = true;
  requestEdgeFrame();
}

// Effective on-canvas height follows the rendered card: collapsed cards are
// head-only and short branches may be smaller than their saved height cap.
export function effH(n) {
  const el = canvasCard(n);
  return el ? el.offsetHeight || (n.collapsed ? 36 : n.size.h) : n.size.h;
}

export function edgeMeasure(n, cache) {
  let measured = cache[n.id];
  if (!measured) {
    measured = { h: effH(n), elRect: null, bodyRect: null };
    cache[n.id] = measured;
  }
  return measured;
}

export function clamp(lo, hi, v) {
  return Math.max(lo, Math.min(hi, v));
}

// Which side the edge leaves the parent from and enters the child on — chosen
// by where the child actually sits, so a card dragged left of (or above) its
// parent gets a sensibly routed arrow instead of one that always exits right.
export function edgeSides(p, n, measureCache) {
  const ph = edgeMeasure(p, measureCache).h,
    nh = edgeMeasure(n, measureCache).h;
  const dx = n.position.x + n.size.w / 2 - (p.position.x + p.size.w / 2);
  const dy = n.position.y + nh / 2 - (p.position.y + ph / 2);
  const fx = dx / ((p.size.w + n.size.w) / 2 + 1);
  const fy = dy / ((ph + nh) / 2 + 1);
  if (Math.abs(fx) >= Math.abs(fy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

// Where an edge leaves its parent: at the inline mark of the exact text the
// branch was asked from (clamped to the card's visible body while scrolled) —
// the mark's y for side exits, its x for top/bottom exits — at the composer
// for follow-ups, or at the side's midpoint as a fallback.
export function edgeStart(p, child, side, measureCache) {
  const measured = edgeMeasure(p, measureCache);
  let ph = measured.h,
    ax = null,
    ay = null,
    anchored = false;
  const graphCard = canvasCard(p),
    graphBody = canvasBody(p);
  if (!p.collapsed && graphCard && graphBody) {
    const mark = graphBody.querySelector('mark[data-child="' + child.id + '"]');
    if (mark) {
      const mr = mark.getBoundingClientRect();
      if (mr.height > 0) {
        const er = measured.elRect || (measured.elRect = graphCard.getBoundingClientRect());
        const br = measured.bodyRect || (measured.bodyRect = graphBody.getBoundingClientRect());
        ay =
          p.position.y +
          clamp(
            (br.top - er.top) / view.scale + 10,
            (br.bottom - er.top) / view.scale - 10,
            (mr.top + mr.height / 2 - er.top) / view.scale,
          );
        ax =
          p.position.x +
          clamp(
            (br.left - er.left) / view.scale + 10,
            (br.right - er.left) / view.scale - 10,
            (mr.left + mr.width / 2 - er.left) / view.scale,
          );
        anchored = true;
      }
    } else if (isFollowup(child)) {
      ay = p.position.y + ph - 22;
    }
  }
  if (side === "right")
    return { x: p.position.x + p.size.w, y: ay != null ? ay : p.position.y + ph / 2, anchored: anchored };
  if (side === "left") return { x: p.position.x, y: ay != null ? ay : p.position.y + ph / 2, anchored: anchored };
  if (side === "bottom")
    return { x: ax != null ? ax : p.position.x + p.size.w / 2, y: p.position.y + ph, anchored: anchored };
  return { x: ax != null ? ax : p.position.x + p.size.w / 2, y: p.position.y, anchored: anchored };
}

export function edgeEnd(n, side, measureCache) {
  const nh = edgeMeasure(n, measureCache).h;
  if (side === "left") return { x: n.position.x, y: n.position.y + nh / 2 };
  if (side === "right") return { x: n.position.x + n.size.w, y: n.position.y + nh / 2 };
  if (side === "top") return { x: n.position.x + n.size.w / 2, y: n.position.y };
  return { x: n.position.x + n.size.w / 2, y: n.position.y + nh };
}

export function ctrlPt(pt, side, d) {
  if (side === "right") return pt.x + d + " " + pt.y;
  if (side === "left") return pt.x - d + " " + pt.y;
  if (side === "bottom") return pt.x + " " + (pt.y + d);
  return pt.x + " " + (pt.y - d);
}

export function ensureEdgeEls(childId) {
  const els = r.edgeEls[childId];
  if (els) return els;
  const path = document.createElementNS(SVGNS, "path");
  path.setAttribute("data-child", childId);
  const dot = document.createElementNS(SVGNS, "circle");
  dot.setAttribute("r", "3");
  dot.setAttribute("data-child", childId);
  edgesSvg.appendChild(path);
  edgesSvg.appendChild(dot);
  r.edgeEls[childId] = [path, dot];
  return r.edgeEls[childId];
}

export function removeEdge(childId) {
  const els = r.edgeEls[childId];
  if (els) {
    for (let i = 0; i < els.length; i++) if (els[i].parentNode) els[i].parentNode.removeChild(els[i]);
  }
  delete r.edgeEls[childId];
  delete r.edgeGeometry[childId];
  delete r.edgeHl[childId];
}

export function applyEdgeClasses(childId, path, dot, anchored) {
  path.classList.toggle("edge-hl", !!r.edgeHl[childId]);
  dot.classList.toggle("edge-hl", !!r.edgeHl[childId]);
  dot.classList.toggle("anchored", !!anchored);
}

export function rebuildEdges() {
  while (edgesSvg.firstChild) edgesSvg.removeChild(edgesSvg.firstChild);
  r.edgeEls = {};
  r.edgeGeometry = {};
  drawEdges();
  // Cards may have changed while the canvas was away: their dots take their
  // places once, here; from now on each card's own layout moves them.
  r.lifecycle.hooks.positionDockedNotes();
}

// Edges exist only on the canvas. Out of sight they are not measured at all —
// measuring would lay out every hidden card — and returning to the canvas
// rebuilds them (rebuildEdges).
export function drawEdges() {
  if (mode !== "canvas") return;
  const live = {};
  const visCache = Object.create(null);
  const measureCache = Object.create(null);
  function vis(node) {
    return isVisible(node, visCache);
  }
  for (const id in nodes) {
    const n = nodes[id];
    if (!n.parent_id || !n.el) continue;
    const p = nodes[n.parent_id];
    if (!p || !p.el) continue;
    if (!vis(n) || !vis(p)) continue;
    live[n.id] = true;
    renderEdge(p, n, measureCache);
  }
  for (const childId in r.edgeEls) {
    if (!live[childId]) removeEdge(childId);
  }
}

export function drawEdgeSubset(ids) {
  if (mode !== "canvas") return;
  const visCache = Object.create(null);
  const measureCache = Object.create(null);
  function vis(node) {
    return isVisible(node, visCache);
  }
  for (const childId in ids) {
    const child = nodes[childId];
    const parent = child && child.parent_id ? nodes[child.parent_id] : null;
    if (!child || !child.el || !parent || !parent.el || !vis(child) || !vis(parent)) {
      removeEdge(childId);
      continue;
    }
    renderEdge(parent, child, measureCache);
  }
}

export function renderEdge(parent, child, measureCache) {
  const sides = edgeSides(parent, child, measureCache);
  const start = edgeStart(parent, child, sides[0], measureCache);
  const end = edgeEnd(child, sides[1], measureCache);
  const horiz = sides[0] === "left" || sides[0] === "right";
  const reach = Math.max(40, (horiz ? Math.abs(end.x - start.x) : Math.abs(end.y - start.y)) / 2);
  const d =
    "M " +
    start.x +
    " " +
    start.y +
    " C " +
    ctrlPt(start, sides[0], reach) +
    " " +
    ctrlPt(end, sides[1], reach) +
    " " +
    end.x +
    " " +
    end.y;
  const geom = { d: d, cx: String(start.x), cy: String(start.y), anchored: !!start.anchored };
  const els = ensureEdgeEls(child.id);
  const path = els[0],
    dot = els[1],
    prev = r.edgeGeometry[child.id];
  if (!prev || prev.d !== geom.d) path.setAttribute("d", geom.d);
  if (!prev || prev.cx !== geom.cx) dot.setAttribute("cx", geom.cx);
  if (!prev || prev.cy !== geom.cy) dot.setAttribute("cy", geom.cy);
  if (!prev || prev.anchored !== geom.anchored) applyEdgeClasses(child.id, path, dot, geom.anchored);
  else if (!!r.edgeHl[child.id] !== path.classList.contains("edge-hl"))
    applyEdgeClasses(child.id, path, dot, geom.anchored);
  r.edgeGeometry[child.id] = geom;
}

export function setEdgeHighlight(childId, on) {
  if (on) r.edgeHl[childId] = true;
  else delete r.edgeHl[childId];
  const els = r.edgeEls[childId];
  if (!els) return;
  for (let i = 0; i < els.length; i++) els[i].classList.toggle("edge-hl", on);
}

export function clearEdgeHighlight(childId) {
  delete r.edgeHl[childId];
}

export function focusOrigin(node, on) {
  if (mode !== "canvas") return;
  setEdgeHighlight(node.id, on);
  const p = node.parent_id ? nodes[node.parent_id] : null;
  const graphBody = canvasBody(p);
  if (graphBody) {
    const marks = graphBody.querySelectorAll('[data-child="' + node.id + '"]');
    for (let i = 0; i < marks.length; i++) marks[i].classList.toggle("mark-focus", on);
  }
}

// Hovering the highlighted text lights up the edge to the branch it spawned.
export function onWorldMouseOver(e) {
  transitionMarkGroups(e, true, "mark-hover", setEdgeHighlight);
}

export function onWorldMouseOut(e) {
  transitionMarkGroups(e, false, "mark-hover", setEdgeHighlight);
}
