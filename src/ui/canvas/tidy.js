import { isDockedNote } from "../../core/hole/ask.js";
import {
  boundsOverlap,
  nodeBounds,
  nodeOrder,
  shiftBounds,
  TREE_PARENT_GAP,
  TREE_STACK_GAP,
  unionBounds,
} from "../../core/layout.js";
import {
  canvasBuilt,
  canvasFramed,
  currentNodeId,
  isVisible,
  mode,
  nodes,
  playLandingCue,
  rootId,
  setCanvasBuilt,
  setCanvasFramed,
  setModeValue,
} from "../core.js";
import { flyReaderToRect } from "../mode-transition.js";
import { openNode, readerScroller, readerViewState } from "../reader.js";
import { putPlaces, readPlaces } from "../scroll-position.js";
import { restoreCardScrolls } from "../view-state.js";
import { animateView, applyTransform, diveTargetView } from "./camera.js";
import { createNodeEl } from "./card.js";
import { cardScreenRect, rectMostlyVisible } from "./card-composer.js";
import { effH, rebuildEdges } from "./edges.js";
import { discardAllCollapseStacks, renderVisibility } from "./fold.js";
import { layoutNode } from "./gestures.js";
import { placedChildren } from "./menu.js";
import { r } from "./runtime.js";
import { isFollowup, isSelectionBranch } from "./shared.js";
import { frameAll } from "./viewport.js";

export function tidy(source) {
  // Tidy is an explicit replacement for the hand-arranged layout. Keep the
  // current folded geometry as its input and retire any older restore point,
  // so a later expansion cannot undo the layout the human just requested.
  discardAllCollapseStacks();
  const visited = {};
  function moveSubtree(node, dx, dy) {
    node.position.x += dx;
    node.position.y += dy;
    placedChildren(node.id)
      .filter(function (k) {
        return visited[k.id];
      })
      .sort(nodeOrder)
      .forEach(function (k) {
        moveSubtree(k, dx, dy);
      });
  }
  function place(node, x, y) {
    visited[node.id] = true;
    node.position.x = x;
    node.position.y = y;
    let bounds = nodeBounds(node, { effH: effH });
    const kids = placedChildren(node.id).sort(nodeOrder);
    const selectionKids = kids.filter(isSelectionBranch);
    const followupKids = kids.filter(isFollowup);
    let sideBounds = null;
    const sideX = node.position.x + node.size.w + TREE_PARENT_GAP;
    let sideY = node.position.y;
    selectionKids.forEach(function (k) {
      const kb = place(k, sideX, sideY);
      sideBounds = unionBounds(sideBounds, kb);
      bounds = unionBounds(bounds, kb);
      sideY = kb.maxY + TREE_STACK_GAP;
    });
    let belowY = node.position.y + effH(node) + TREE_PARENT_GAP;
    followupKids.forEach(function (k) {
      let kb = place(k, node.position.x, belowY);
      if (boundsOverlap(kb, sideBounds)) {
        const dy = sideBounds.maxY + TREE_STACK_GAP - kb.minY;
        moveSubtree(k, 0, dy);
        kb = shiftBounds(kb, 0, dy);
      }
      bounds = unionBounds(bounds, kb);
      belowY = kb.maxY + TREE_STACK_GAP;
    });
    return bounds;
  }
  const root = nodes[rootId];
  if (!root) return;
  place(root, 0, 0);
  // Only nodes actually visited (the live tree) are laid out.
  const ids = Object.keys(visited);
  const moved = [];
  ids.forEach(function (id) {
    const nn = nodes[id];
    layoutNode(nn);
    moved.push(nn);
  });
  r.lifecycle.hooks.persistNodesBulk(moved);
  rebuildEdges();
  frameAll(true, source);
}

// Canvas cards (DOM + rendered markdown for every node) are built on first
// canvas entry — with canvas as the landing surface that is effectively at
// hydrate, but the guard keeps re-entry and programmatic callers cheap.
export function ensureCanvasBuilt() {
  if (canvasBuilt) return;
  setCanvasBuilt(true);
  // Docked notes get no card: they are drawn onto their parent's, which
  // fillBody does as each card is built.
  Object.keys(nodes).forEach(function (id) {
    if (!nodes[id].el && !isDockedNote(nodes[id])) createNodeEl(nodes[id]);
  });
  renderVisibility();
  applyTransform();
}

/**
 * Build the canvas a card at a time while the browser is idle — behind a
 * reader that came up first. Entering the canvas sooner builds whatever is
 * left at once (ensureCanvasBuilt).
 */
export function prebuildCanvas() {
  const idle = window.requestIdleCallback
    ? window.requestIdleCallback.bind(window)
    : function (fn) {
        return setTimeout(function () {
          fn({ timeRemaining: () => 8 });
        }, 50);
      };
  const ids = Object.keys(nodes);
  const hole = rootId;
  function slice(deadline) {
    if (canvasBuilt || rootId !== hole) return;
    while (ids.length && deadline.timeRemaining() > 2) {
      const node = nodes[ids.shift()];
      if (node && !node.el && !isDockedNote(node)) createNodeEl(node);
    }
    if (ids.length) idle(slice);
    else ensureCanvasBuilt();
  }
  idle(slice);
}

export function setMode(m) {
  const fromReader = m === "canvas" && mode === "reader";
  // Every document the reader shows hands its place to its card, read while
  // the reader still shows it.
  const places = fromReader ? readPlaces((readerViewState()?.trail || []).map((id) => [id, readerScroller(id)])) : null;
  setModeValue(m);
  if (m === "canvas") {
    ensureCanvasBuilt();
    document.body.classList.add("mode-canvas");
    if (places) {
      putPlaces(places, (id) => nodes[id]?.bodyEl);
      // Every other card goes back to where it was read to on the canvas.
      restoreCardScrolls({ except: places });
    }
    // Settle the reader back toward the card it is. If the card still sits
    // in view, the camera stays put (macOS restore: the window returns to
    // its spot). If the human panned away — or dove into a different branch
    // while reading — the camera jumps home NOW, while the opaque reader
    // still covers the canvas: the jump is invisible, the card is already
    // seated when the fade reveals it, and there is nothing to keep in sync.
    if (fromReader) {
      const target = nodes[currentNodeId];
      let rect = null;
      if (target && isVisible(target)) {
        rect = cardScreenRect(target);
        if (!rectMostlyVisible(rect)) {
          const pose = diveTargetView(target);
          animateView(pose.x, pose.y, pose.scale, { source: "flight" });
          rect = cardScreenRect(target);
        }
      }
      const flew = flyReaderToRect(rect);
      if (target && target.el) {
        // The flash confirms the landing, so it waits for the fade to
        // finish; under the fading sheet it reads as a glitch.
        const cueEl = target.el;
        if (flew)
          document.addEventListener(
            "rh-reader-flight-end",
            function () {
              playLandingCue(cueEl, "flash");
            },
            { once: true },
          );
        else playLandingCue(cueEl, "flash");
      }
    }
    requestAnimationFrame(function () {
      rebuildEdges();
      // Frame everything only the first time; afterwards the canvas keeps the
      // pan/zoom you left it at.
      if (!canvasFramed) {
        setCanvasFramed(true);
        frameAll();
      }
    });
    r.lifecycle.hooks.scheduleViewSave();
  } else {
    openNode(currentNodeId);
  }
}
