import { setSurfaceOrigin } from "../core.js";
import { registerLayer } from "./layer-stack.js";

function tokenPx(surface, name) {
  var value = parseFloat(getComputedStyle(surface).getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}

function viewportRect() {
  var viewport = window.visualViewport;
  return { left: viewport ? viewport.offsetLeft : 0, top: viewport ? viewport.offsetTop : 0,
    width: viewport ? viewport.width : window.innerWidth, height: viewport ? viewport.height : window.innerHeight };
}

export function anchorSurface(trigger, surface, options) {
  options = options || {};
  var contextElement = trigger && trigger.contextElement;
  var observedTrigger = contextElement || trigger;
  var virtual = !!contextElement || !(trigger instanceof Element);
  var placement = options.placement || "bottom-end", disposed = false, frame = 0, updating = false;
  var lastLeft = null, lastTop = null;

  function updateNow() {
    frame = 0;
    if (disposed || !surface.isConnected || (virtual ? contextElement && !contextElement.isConnected : !trigger.isConnected)) return;
    updating = true;
    var anchor = trigger.getBoundingClientRect(), box = surface.getBoundingClientRect(), viewport = viewportRect();
    // A 0×0 anchor at the origin is a dead anchor (collapsed range, detached
    // node) — hold the last good position rather than glide to the corner.
    if (!anchor.width && !anchor.height && !anchor.left && !anchor.top && lastLeft !== null) { updating = false; return; }
    var edge = tokenPx(surface, "--surface-edge"), gap = tokenPx(surface, "--surface-gap");
    var parts = placement.split("-"), side = parts[0], align = parts[1] || "center";
    var left, top;
    if (side === "center") {
      left = viewport.left + (viewport.width - box.width) / 2;
      top = viewport.top + (viewport.height - box.height) / 2;
    } else {
      var vertical = side === "top" || side === "bottom";
      var before = vertical ? anchor.top - viewport.top : anchor.left - viewport.left;
      var after = vertical ? viewport.top + viewport.height - anchor.bottom : viewport.left + viewport.width - anchor.right;
      var mainSize = vertical ? box.height : box.width;
      var preferredSpace = side === "top" || side === "left" ? before : after;
      var alternateSpace = side === "top" || side === "left" ? after : before;
      if (preferredSpace < mainSize + gap + edge && alternateSpace > preferredSpace) {
        side = side === "top" ? "bottom" : side === "bottom" ? "top" : side === "left" ? "right" : "left";
      }
      if (side === "top" || side === "bottom") {
        top = side === "bottom" ? anchor.bottom + gap : anchor.top - box.height - gap;
        left = align === "start" ? anchor.left : align === "end" ? anchor.right - box.width : anchor.left + (anchor.width - box.width) / 2;
      } else {
        left = side === "right" ? anchor.right + gap : anchor.left - box.width - gap;
        top = align === "start" ? anchor.top : align === "end" ? anchor.bottom - box.height : anchor.top + (anchor.height - box.height) / 2;
      }
    }
    left = Math.min(viewport.left + viewport.width - edge - box.width, Math.max(viewport.left + edge, left));
    top = Math.min(viewport.top + viewport.height - edge - box.height, Math.max(viewport.top + edge, top));
    if (left !== lastLeft) surface.style.left = left + "px";
    if (top !== lastTop) surface.style.top = top + "px";
    lastLeft = left; lastTop = top;
    surface.dataset.placement = side === "center" ? "center" : side + "-" + align;
    updating = false;
  }
  function update() { if (!disposed && !frame) frame = requestAnimationFrame(updateNow); }
  window.addEventListener("resize", update, { passive: true });
  window.visualViewport?.addEventListener("resize", update, { passive: true });
  window.visualViewport?.addEventListener("scroll", update, { passive: true });
  var resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(function(){ if (!updating) update(); }) : null;
  if (!virtual || contextElement) resizeObserver?.observe(observedTrigger);
  resizeObserver?.observe(surface);
  var mutationObserver = typeof MutationObserver === "function" ? new MutationObserver(update) : null;
  mutationObserver?.observe(surface, { childList: true, subtree: true, characterData: true });
  updateNow();
  return { update: update, dispose: function() {
    disposed = true; if (frame) cancelAnimationFrame(frame);
    window.removeEventListener("resize", update);
    window.visualViewport?.removeEventListener("resize", update);
    window.visualViewport?.removeEventListener("scroll", update);
    resizeObserver?.disconnect(); mutationObserver?.disconnect();
  } };
}

/**
 * @param {{ surface: Element, anchor: Element | { getBoundingClientRect: () => DOMRect, contextElement?: Element }, placement?: string, trigger?: Element, restoreFocus?: boolean, closeOnOutsidePointer?: boolean, preventOutsidePointerDefault?: boolean, onClose?: (reason: string) => void }} options
 */
export function openAnchoredSurface(options) {
  var surface = options.surface;
  var anchor = options.anchor;
  setSurfaceOrigin(surface, anchor.getBoundingClientRect());
  var position = anchorSurface(anchor, surface, { placement: options.placement });
  var unregister = registerLayer({
    element: surface,
    trigger: options.trigger,
    restoreFocus: options.restoreFocus,
    closeOnOutsidePointer: options.closeOnOutsidePointer,
    preventOutsidePointerDefault: options.preventOutsidePointerDefault,
    onClose: options.onClose
  });
  return {
    update: position.update,
    dispose: function(){
      position.dispose();
      unregister({ restoreFocus: false });
      surface.classList.remove("visible");
    }
  };
}
