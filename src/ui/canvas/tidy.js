import { isDockedNote } from "../../core/hole/ask.js";
import { tidyPositions } from "../../core/layout.js";
import {
  canvasBuilt,
  canvasFramed,
  currentNodeId,
  isVisible,
  mode,
  nodes,
  playLandingCue,
  readerMain,
  rootId,
  setCanvasBuilt,
  setCanvasFramed,
  setModeValue,
} from "../core.js";
import { flyReaderToRect } from "../mode-transition.js";
import { openNode } from "../reader.js";
import { captureContentPosition, restoreContentPosition } from "../scroll-position.js";
import { animateView, applyTransform, diveTargetView } from "./camera.js";
import { createNodeEl } from "./card.js";
import { cardScreenRect, rectMostlyVisible } from "./card-composer.js";
import { effH, rebuildEdges } from "./edges.js";
import { discardAllCollapseStacks, renderVisibility } from "./fold.js";
import { layoutNode } from "./gestures.js";
import { placedChildren } from "./menu.js";
import { r } from "./runtime.js";
import { frameAll } from "./viewport.js";

export function tidy(source) {
  // Tidy is an explicit replacement for the hand-arranged layout. Keep the
  // current folded geometry as its input and retire any older restore point,
  // so a later expansion cannot undo the layout the human just requested.
  discardAllCollapseStacks();
  const root = nodes[rootId];
  if (!root) return;
  // The tree shape is computed by the pure core layout; this module owns only
  // the DOM, persistence, edge, and camera work that applying it requires.
  const positions = tidyPositions({ root, childrenOf: placedChildren, effH });
  const moved = [];
  positions.forEach(function (position, id) {
    const node = nodes[id];
    if (!node) return;
    node.position.x = position.x;
    node.position.y = position.y;
    layoutNode(node);
    moved.push(node);
  });
  if (!moved.length) return;
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

export function setMode(m) {
  let transferredPosition = null;
  const fromReader = m === "canvas" && mode === "reader";
  if (fromReader) {
    // display:none resets the reader's scrollTop — remember it first so
    // collapsing out to the canvas and diving back lands exactly where you were.
    const cur = nodes[currentNodeId];
    if (cur) {
      cur._scrollTop = readerMain.scrollTop;
      transferredPosition = captureContentPosition(readerMain);
    }
  }
  setModeValue(m);
  if (m === "canvas") {
    ensureCanvasBuilt();
    document.body.classList.add("mode-canvas");
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
      const active = nodes[currentNodeId];
      if (transferredPosition && active?.bodyEl) restoreContentPosition(active.bodyEl, transferredPosition);
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
