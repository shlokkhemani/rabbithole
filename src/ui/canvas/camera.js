import { iconSvg } from "../../core/html/icons.js";
import {
  MAX_SCALE,
  MIN_SCALE,
  nodes,
  setViewAdjusted,
  shouldReduceMotion,
  view,
  viewport,
  world,
  zoomLabel,
} from "../core.js";
import { easeInOutMotion, easeOutMotion } from "../easing.js";
import { drawEdges, effH } from "./edges.js";
import { applyCollapsedState, renderVisibility } from "./fold.js";
import { r } from "./runtime.js";
import { canvasCard } from "./shared.js";

// ===========================================================================
// CANVAS
// ===========================================================================
export function applyTransform() {
  // The card menu and the docked-note popover are transient command surfaces:
  // the view moving underneath them dismisses them rather than chases them.
  if (r.cardMenuController && r.cardMenuController.isOpen()) r.cardMenuController.close({ restoreFocus: false });
  r.lifecycle.hooks.closeDockedNotePopover({ restoreFocus: false, commit: true });
  world.style.transform = "translate(" + view.x + "px," + view.y + "px) scale(" + view.scale + ")";
  zoomLabel.textContent = Math.round(view.scale * 100) + "%";
  // A transform moves every on-canvas anchor rect without firing anything a
  // resize or mutation observer can see. Announce the view change so open
  // anchored surfaces (the selection ask/note popover) follow their anchors.
  document.dispatchEvent(new CustomEvent("rh-view-change"));
  r.lifecycle.hooks.scheduleViewSave();
}

export function exposeFilmCameraHook() {
  let enabled = false;
  try {
    enabled = localStorage.getItem("rh-film") === "1";
  } catch (e) {}
  if (!enabled) return;
  r.filmCameraHandle = {
    getView: function () {
      return { x: view.x, y: view.y, scale: view.scale };
    },
    setView: function (x, y, scale) {
      cancelViewAnimation();
      setViewAdjusted(true);
      view.x = Number(x);
      view.y = Number(y);
      view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(scale)));
      applyTransform();
      drawEdges();
      return { x: view.x, y: view.y, scale: view.scale };
    },
  };
  Object.defineProperty(window, "__rhFilmCamera", {
    configurable: true,
    value: r.filmCameraHandle,
  });
}

export function screenToWorld(sx, sy) {
  return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
}

// The canvas the human can actually see: the viewport minus the chrome that
// floats over it. Framing, note placement, and edge-scroll all owe the same
// answer, or they aim at pixels hidden under the rail or the taskbar.
export function visibleCanvasRect() {
  const fullW = viewport.clientWidth || window.innerWidth;
  const fullH = viewport.clientHeight || window.innerHeight;
  const rail = document.getElementById("web-rail"),
    taskbar = document.getElementById("taskbar");
  const left = rail && rail.classList.contains("open") ? rail.getBoundingClientRect().width : 0;
  const top = taskbar ? taskbar.getBoundingClientRect().height : 0;
  return { left: left, top: top, right: fullW, bottom: fullH, width: fullW - left, height: fullH - top };
}

export function zoomAt(sx, sy, factor) {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  zoomTo(sx, sy, next);
}

export function zoomTo(sx, sy, next) {
  cancelViewAnimation(); // manual zoom cancels any in-flight glide
  next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
  if (next === view.scale) return;
  setViewAdjusted(true);
  const w = screenToWorld(sx, sy);
  view.scale = next;
  view.x = sx - w.x * view.scale;
  view.y = sy - w.y * view.scale;
  applyTransform();
}

// The camera pose that frames a card at reading scale.
export function diveTargetView(node) {
  const vw = viewport.clientWidth,
    vh = viewport.clientHeight;
  const ts = Math.min(1, Math.max(0.75, Math.min((vw - 120) / node.size.w, (vh - 120) / effH(node))));
  return {
    x: vw / 2 - (node.position.x + node.size.w / 2) * ts,
    y: vh / 2 - (node.position.y + effH(node) / 2) * ts,
    scale: ts,
  };
}

// Glide the canvas view into a card at reading scale.
export function diveToNode(node, source) {
  const t = diveTargetView(node);
  animateView(t.x, t.y, t.scale, { source: source, duration: 270, ease: "inOut" });
}

export function showPinnedOriginal(node, source) {
  if (!node?.el) return;
  const changed = [];
  let ancestor = node.parent_id ? nodes[node.parent_id] : null;
  while (ancestor) {
    if (applyCollapsedState(ancestor, false)) changed.push(ancestor);
    ancestor = ancestor.parent_id ? nodes[ancestor.parent_id] : null;
  }
  for (let i = 0; i < changed.length; i++) r.lifecycle.hooks.persistNode(changed[i]);
  if (changed.length) {
    renderVisibility();
    drawEdges();
  }
  diveToNode(node, source);
  const original = canvasCard(node);
  original?.classList.add("flash");
  setTimeout(function () {
    original?.classList.remove("flash");
  }, 520);
  if (source === "keyboard")
    setTimeout(function () {
      original?.querySelector(".pinned-origin-overlay")?.focus({ preventScroll: true });
    }, 300);
}

// One shared view glide (pan + zoom together): frame-all and
// search/activity jumps. A newer glide cancels an in-flight one; hidden windows jump
// instantly (rAF never fires there).
let viewAnimId = 0,
  viewAnimRaf = 0,
  viewAnimPromise = null,
  resolveViewAnim = null;

function finishViewAnimation() {
  if (!resolveViewAnim) return;
  const resolve = resolveViewAnim;
  viewAnimPromise = null;
  resolveViewAnim = null;
  resolve();
}

// The camera uses a JavaScript rAF loop, so Web Animations and DOM stability
// cannot report when a glide has actually landed. The web host exposes this
// promise through its existing test seam; production callers never wait on it.
export function whenViewAnimationSettled() {
  const pending = viewAnimPromise;
  return pending ? pending.then(whenViewAnimationSettled) : Promise.resolve();
}

export function cancelViewAnimation() {
  viewAnimId++;
  if (viewAnimRaf) {
    cancelAnimationFrame(viewAnimRaf);
    viewAnimRaf = 0;
  }
  finishViewAnimation();
}

export function animateView(tx, ty, ts, opts) {
  opts = opts || {};
  cancelViewAnimation();
  const myId = viewAnimId;
  if (document.hidden || shouldReduceMotion() || opts.source !== "pointer") {
    view.x = tx;
    view.y = ty;
    view.scale = ts;
    applyTransform();
    return;
  }
  const sx = view.x,
    sy = view.y,
    ss = view.scale,
    t0 = performance.now(),
    D = opts.duration || 270;
  viewAnimPromise = new Promise(function (resolve) {
    resolveViewAnim = resolve;
  });
  const easeFn = opts.ease === "inOut" ? easeInOutMotion : easeOutMotion;
  function step(t) {
    viewAnimRaf = 0;
    if (myId !== viewAnimId) return;
    const p = Math.min(1, (t - t0) / D),
      k = easeFn(p);
    view.x = sx + (tx - sx) * k;
    view.y = sy + (ty - sy) * k;
    view.scale = ss + (ts - ss) * k;
    applyTransform();
    if (p < 1) viewAnimRaf = requestAnimationFrame(step);
    else finishViewAnimation();
  }
  viewAnimRaf = requestAnimationFrame(step);
}
r.NODE_EXPAND_ICON = iconSvg("expand");
r.NODE_COLLAPSE_ICON = iconSvg("collapse");
r.NODE_MORE_ICON = iconSvg("more");
r.NODE_RESTORE_ICON = iconSvg("restore");
