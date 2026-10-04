import { systemClock } from "../../core/clock.js";
import { isDockedNote } from "../../core/hole/ask.js";
import { makeNode } from "../../core/hole/node.js";
import { DEFAULT_CHILD, DEFAULT_STANDALONE_NOTE } from "../../core/layout.js";
import {
  closed,
  frozen,
  isVisible,
  MAX_SCALE,
  MIN_SCALE,
  mode,
  nextOrder,
  nodes,
  registerNode,
  setViewAdjusted,
  uuid,
  view,
  viewport,
} from "../core.js";
import {
  absorbViewportScroll,
  animateView,
  applyTransform,
  cancelViewAnimation,
  screenToWorld,
  visibleCanvasRect,
  zoomAt,
} from "./camera.js";
import { createNodeEl } from "./card.js";
import { drawEdges, effH } from "./edges.js";
import { renderVisibility } from "./fold.js";
import { onPointerGesture } from "./gestures.js";
import { startNoteEditing } from "./inline-note.js";
import { r } from "./runtime.js";
import { initTouchViewportGestures } from "./viewport-touch.js";

export function initViewportPan() {
  let sx, sy, ox, oy;
  onPointerGesture(
    viewport,
    function (e) {
      if (e.pointerType === "touch" || e.button !== 0 || e.target.closest(".card, .pinned-window")) return false;
      r.lifecycle.hooks.hideAsk();
      cancelViewAnimation();
      viewport.classList.add("panning");
      sx = e.clientX;
      sy = e.clientY;
      ox = view.x;
      oy = view.y;
      return true;
    },
    function (ev) {
      setViewAdjusted(true);
      view.x = ox + (ev.clientX - sx);
      view.y = oy + (ev.clientY - sy);
      applyTransform();
    },
    function () {
      viewport.classList.remove("panning");
    },
    r.lifecycle.scope,
  );
  initTouchViewportGestures();
  r.lifecycle.scope.listen(viewport, "scroll", absorbViewportScroll);
}

// Can this element still scroll in the direction of the wheel delta?
export function canScroll(el, dx, dy) {
  if (dx && el.scrollWidth > el.clientWidth + 1) {
    if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
  }
  if (dy && el.scrollHeight > el.clientHeight + 1) {
    if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
  }
  return false;
}

export function onViewportWheel(e) {
  if (e.ctrlKey) {
    e.preventDefault();
    r.wheelKind = null;
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    return;
  }
  if (!r.wheelKind || e.timeStamp - r.wheelTs > 180) {
    r.wheelCard = (e.target.closest && e.target.closest(".card, .pinned-window")) || null;
    r.wheelKind = r.wheelCard ? "card" : "pan";
  }
  r.wheelTs = e.timeStamp;
  if (r.wheelKind === "pan") {
    e.preventDefault();
    cancelViewAnimation();
    setViewAdjusted(true);
    view.x -= e.deltaX;
    view.y -= e.deltaY;
    applyTransform();
    return;
  }
  const over = (e.target.closest && e.target.closest(".card, .pinned-window")) || null;
  if (over !== r.wheelCard) {
    // Drifted off the origin card mid-scroll: keep moving ITS content by hand.
    e.preventDefault();
    const nb = r.wheelCard ? r.wheelCard.querySelector(".card-body") : null;
    if (nb) {
      const beforeLeft = nb.scrollLeft;
      const beforeTop = nb.scrollTop;
      nb.scrollLeft += e.deltaX;
      nb.scrollTop += e.deltaY;
      if (nb.scrollLeft !== beforeLeft || nb.scrollTop !== beforeTop) r.canvasMaintenance?.cardScrolled(r.wheelCard);
    }
    return;
  }
  // Still over the origin card: allow the browser to scroll the innermost thing
  // that can still move (body, a code block, a wide table); if nothing can,
  // swallow the event so the canvas doesn't lurch mid-read.
  let el = e.target,
    consumable = false;
  while (el && el.nodeType === 1) {
    if (canScroll(el, e.deltaX, e.deltaY)) {
      consumable = true;
      break;
    }
    if (el === over) break;
    el = el.parentNode;
  }
  if (!consumable) e.preventDefault();
  else r.canvasMaintenance?.cardScrolled(r.wheelCard);
}

export function frameAll(animate, source) {
  const visCache = Object.create(null);
  const ids = Object.keys(nodes).filter(function (id) {
    const node = nodes[id];
    const emptyDraft =
      node._ephemeral && !node._noteEditor?.value.trim() && !node._noteAttachments?.length && !node._notePastePending;
    return !emptyDraft && !isDockedNote(node) && isVisible(node, visCache);
  });
  if (!ids.length) return;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  ids.forEach(function (id) {
    const n = nodes[id];
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + n.size.w);
    maxY = Math.max(maxY, n.position.y + effH(n));
  });
  const r = visibleCanvasRect(),
    pad = 100;
  const vw = r.width,
    vh = r.height;
  const ts = Math.max(
    MIN_SCALE,
    Math.min(MAX_SCALE, Math.min((vw - pad) / (maxX - minX), (vh - pad) / (maxY - minY), 1.2)),
  );
  const tx = r.left + vw / 2 - (minX + (maxX - minX) / 2) * ts,
    ty = r.top + vh / 2 - (minY + (maxY - minY) / 2) * ts;
  if (source) setViewAdjusted(true);
  if (animate) {
    animateView(tx, ty, ts, { source: source, duration: 270, ease: "inOut" });
    return;
  }
  view.scale = ts;
  view.x = tx;
  view.y = ty;
  applyTransform();
}

export function createStandaloneNoteAtViewportCenter() {
  const r = visibleCanvasRect();
  createStandaloneNoteAtScreen(
    r.left + r.width / 2 - (DEFAULT_STANDALONE_NOTE.w * view.scale) / 2,
    r.top + r.height / 2 - (DEFAULT_STANDALONE_NOTE.h * view.scale) / 2,
  );
}

export function createStandaloneNoteAtScreen(sx, sy) {
  if (mode !== "canvas" || document.body.classList.contains("mode-flight") || frozen || closed) return null;
  cancelViewAnimation();
  const point = screenToWorld(sx, sy);
  const standalone = Object.assign(
    makeNode({
      id: uuid(),
      parent_id: null,
      title: "Note",
      html: "",
      markdown: "",
      base_url: null,
      base_url_source: null,
      read: true,
      origin: { kind: "note" },
      position: { x: point.x, y: point.y },
      size: { w: DEFAULT_STANDALONE_NOTE.w, h: DEFAULT_CHILD.h },
      collapsed: false,
      status: "answered",
    }),
    { html: "", _order: nextOrder(), _startTs: 0, _ephemeral: true },
  );
  const node = registerNode(standalone);
  // The cursor should land on an exact, stable canvas point immediately;
  // type-to-grow must never inherit the branch-card entrance translation.
  createNodeEl(node, false);
  renderVisibility();
  drawEdges();
  startNoteEditing(node, node.bodyEl.querySelector(".doc-content"));
  return node;
}

export function onViewportDblClick(e) {
  if (systemClock.now() < r.suppressClickUntil) return;
  if (e.target.closest && e.target.closest(".card, .pinned-window")) return;
  createStandaloneNoteAtScreen(e.clientX, e.clientY);
}
