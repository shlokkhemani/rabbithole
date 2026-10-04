import { BRANCH_FOLLOWUP, BRANCH_SELECTION, branchTypeOfNode, isDockedNote } from "../../core/hole/ask.js";
import {
  CANVAS_BASE,
  edgesSvg,
  flashHint,
  fontPx,
  frozen,
  motionSourceFromEvent,
  nextStack,
  nodes,
  view,
  viewport,
  world,
  zoomLabel,
} from "../core.js";
import { createModuleLifecycle } from "../kit/scope.js";
import { createPinnedWindows } from "../pinned-windows.js";
import { onPreferenceChange } from "../preferences.js";
import { createAnchoredMenu } from "../primitives/anchored-menu.js";
import { cancelViewAnimation, exposeFilmCameraHook, showPinnedOriginal, zoomAt, zoomTo } from "./camera.js";
import { onWorldMouseOut, onWorldMouseOver, scheduleEdges, scheduleNodeEdges } from "./edges.js";
import { layoutNode } from "./gestures.js";
import { onCardMenuClick } from "./menu.js";
import {
  canPinWindow,
  nodePin,
  persistCanvasExtension,
  pinnedFontScale,
  setPinnedFontScale,
  syncNodePinPresentation,
} from "./pins.js";
import { r } from "./runtime.js";
import { tidy } from "./tidy.js";
import { initViewportPan, onViewportDblClick, onViewportWheel } from "./viewport.js";

export function isSelectionBranch(node) {
  return branchTypeOfNode(node) === BRANCH_SELECTION;
}

export function isFollowup(node) {
  return branchTypeOfNode(node) === BRANCH_FOLLOWUP;
}

export function raiseCard(el) {
  el.style.zIndex = String(nextStack());
}

export function raiseEventCard(e) {
  const el = e.target.closest && e.target.closest(".card");
  if (el) raiseCard(el);
}

export function clipboardImageFiles(event) {
  const files = [];
  for (const item of Array.from(event.clipboardData?.items || [])) {
    if (
      item.kind !== "file" ||
      !String(item.type || "")
        .toLowerCase()
        .startsWith("image/")
    )
      continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

export function flashClipboardImageError(error) {
  flashHint(
    error?.code === "asset_too_large"
      ? "That image is over 20 MB."
      : error?.code === "clipboard_image_too_large"
        ? "That image is too large."
        : "Couldn't paste that image.",
  );
}

export function defaultCanvasHooks() {
  return {
    hideAsk: function () {},
    sendFollowup: function () {
      return null;
    },
    sendPlacedNote: function () {
      return null;
    },
    rollbackBranch: function () {},
    copyNodeMarkdown: function () {},
    removeBranch: function () {},
    persistNode: function () {},
    persistNodesBulk: function () {},
    scheduleViewSave: function () {},
    createCanvasMaintenance: null,
    // Docked notes render on the cards this module owns, so the canvas asks
    // for them by hook rather than reaching into their module.
    renderDockedNotes: function () {},
    positionDockedNotes: function () {},
    /** @param {Element} _doc */
    watchDocumentLayout: function (_doc) {},
    closeDockedNotePopover: function () {},
  };
}

export function canvasCard(node) {
  return node && (node.canvasEl || node.el);
}

export function canvasBody(node) {
  return node && (node.canvasBodyEl || node.bodyEl);
}

export { canPinWindow, nodePin, persistCanvasExtension, pinnedFontScale, setPinnedFontScale, syncNodePinPresentation };

export function syncNodeCanvasPresentation(node) {
  layoutNode(node);
}

export function setWindowPinned(node, pinned) {
  if (!canPinWindow(node) || frozen) return;
  node.view = Object.assign({}, node.view);
  const current = nodePin(node);
  if (pinned) {
    if (current) return;
    const graphCard = canvasCard(node);
    const rect = graphCard.getBoundingClientRect();
    node.view.pin = {
      x: rect.left,
      y: rect.top,
      scale: view.scale,
      w: node.size.w,
      h: Math.max(160, graphCard.offsetHeight || node.size.h),
    };
  } else {
    if (!current) return;
    delete node.view.pin;
  }
  layoutNode(node);
  persistCanvasExtension(node);
}

export function initCanvasView(hooks) {
  r.lifecycle.register(hooks);
  cleanupCanvasView(false);
  const canvasScope = r.lifecycle.beginInit();
  if (!frozen && typeof r.lifecycle.hooks.createCanvasMaintenance === "function") {
    r.canvasMaintenance = r.lifecycle.hooks.createCanvasMaintenance();
    canvasScope.addCleanup(function () {
      r.canvasMaintenance?.dispose();
      r.canvasMaintenance = null;
    });
  }
  r.pinnedWindows = createPinnedWindows({
    layer: document.getElementById("pinned-windows"),
    readOnly: frozen,
    onChange: function (node) {
      persistCanvasExtension(node);
    },
    // The proxy shows the card as it lives in the document — the authorial
    // text size, not whatever the pinned window has been dialed to.
    prepareProxy: function (node, visual) {
      const surfaces = visual.querySelectorAll(".doc-content, .note-editor");
      for (let i = 0; i < surfaces.length; i++) {
        if (surfaces[i].dataset.nodeId !== node.id) continue;
        surfaces[i].style.fontSize = fontPx(CANVAS_BASE, node.font_scale || 1) + "px";
      }
    },
    onShowOriginal: showPinnedOriginal,
    onUnpin: function (node) {
      setWindowPinned(node, false);
      requestAnimationFrame(function () {
        node.moreBtn?.focus({ preventScroll: true });
      });
    },
  });
  canvasScope.addCleanup(function () {
    r.pinnedWindows?.dispose();
    r.pinnedWindows = null;
  });
  // A global reading-scale change resizes the live surfaces in core, but the
  // inert pin proxies carry no node id — re-render them under the new scale.
  canvasScope.addCleanup(
    onPreferenceChange(function (kind) {
      if (kind !== "reading-scale") return;
      for (const id in nodes) if (nodePin(nodes[id])) syncNodePinPresentation(nodes[id]);
    }),
  );
  if (typeof ResizeObserver === "function")
    r.cardResizeObserver = new ResizeObserver(function (entries) {
      for (let i = 0; i < entries.length; i++) {
        const target = entries[i].target;
        const id = target instanceof HTMLElement ? target.dataset.nodeId : undefined;
        if (id && nodes[id]) scheduleNodeEdges(nodes[id]);
        else scheduleEdges();
      }
    });
  const cardMenu = document.getElementById("cardmenu");
  r.cardMenuController = createAnchoredMenu({
    surface: cardMenu,
    placement: "bottom-end",
    onClose: function () {
      r.cardMenuNode = null;
    },
  });
  canvasScope.addCleanup(function () {
    r.cardMenuController?.dispose();
    r.cardMenuController = null;
    r.cardMenuNode = null;
  });
  canvasScope.listen(cardMenu, "click", onCardMenuClick);
  canvasScope.listen(world, "mouseover", onWorldMouseOver);
  canvasScope.listen(world, "mouseout", onWorldMouseOut);
  canvasScope.listen(world, "pointerdown", raiseEventCard, { capture: true });
  canvasScope.listen(world, "focusin", raiseEventCard);
  initViewportPan();
  canvasScope.listen(viewport, "wheel", onViewportWheel, { passive: false });
  canvasScope.listen(viewport, "dblclick", onViewportDblClick);
  canvasScope.listen(document.getElementById("t-tidy"), "click", function (e) {
    tidy(motionSourceFromEvent(e));
  });
  canvasScope.listen(document.getElementById("t-zin"), "click", function () {
    zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 1.15);
  });
  canvasScope.listen(document.getElementById("t-zout"), "click", function () {
    zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 0.87);
  });
  canvasScope.listen(zoomLabel, "click", function () {
    zoomTo(viewport.clientWidth / 2, viewport.clientHeight / 2, 1);
  });
  exposeFilmCameraHook();
  return disposeCanvasView;
}

export function disposeCanvasView() {
  cleanupCanvasView(true);
}

export function closeCardMenu(settings) {
  if (r.cardMenuController) r.cardMenuController.close(settings);
}

export function cleanupCanvasView(resetHooks) {
  r.lifecycle.dispose(resetHooks);
  if (r.cardResizeObserver) r.cardResizeObserver.disconnect();
  r.cardResizeObserver = null;
  r.activePointerGestures.forEach(function (cancel) {
    cancel();
  });
  r.activePointerGestures.clear();
  r.suppressClickUntil = 0;
  r.cardMenuController = null;
  r.cardMenuNode = null;
  r.canvasMaintenance?.dispose();
  r.canvasMaintenance = null;
  r.pinnedWindows?.dispose();
  r.pinnedWindows = null;
  cancelViewAnimation();
  if (r.edgeRaf) {
    cancelAnimationFrame(r.edgeRaf);
    r.edgeRaf = 0;
  }
  r.edgeRedrawAll = false;
  r.edgeRedrawIds = {};
  if (r.filmCameraHandle && window.__rhFilmCamera === r.filmCameraHandle) {
    try {
      delete window.__rhFilmCamera;
    } catch (_e) {}
  }
  r.filmCameraHandle = null;
  if (edgesSvg) while (edgesSvg.firstChild) edgesSvg.removeChild(edgesSvg.firstChild);
  r.edgeEls = {};
  r.edgeGeometry = {};
  r.edgeHl = {};
  r.wheelKind = null;
  r.wheelCard = null;
  r.wheelTs = 0;
  viewport?.classList.remove("panning");
}
r.lifecycle = createModuleLifecycle({ defaults: defaultCanvasHooks });
