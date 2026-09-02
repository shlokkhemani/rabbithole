import { registerLayer } from "./layer-stack.js";
import { setSurfaceOrigin } from "./surface-origin.js";

function tokenPx(surface, name) {
  const value = parseFloat(getComputedStyle(surface).getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}

export function viewportRect() {
  const viewport = window.visualViewport;
  return {
    left: viewport ? viewport.offsetLeft : 0,
    top: viewport ? viewport.offsetTop : 0,
    width: viewport ? viewport.width : window.innerWidth,
    height: viewport ? viewport.height : window.innerHeight,
  };
}

function clampToViewport(value, min, max) {
  // An on-screen keyboard or browser zoom can make a surface temporarily
  // larger than the visual viewport. Keep its leading edge reachable instead
  // of letting the usual clamp push that edge off-screen.
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function oppositeSide(side) {
  return side === "top" ? "bottom" : side === "bottom" ? "top" : side === "left" ? "right" : "left";
}

// The region where an anchor counts as visible: the visual viewport cut down
// by every overflow-clipping ancestor — the canvas viewport, a card body
// scrolling its document. An anchored surface annotates visible content; when
// its anchor leaves this region the surface hides (data-anchor-hidden) rather
// than clamps to an edge, because clamping strands an orphan beside nothing
// and dismissing would throw away a draft.
export function anchorClipBounds(element, viewport) {
  let left = viewport.left,
    top = viewport.top,
    right = viewport.left + viewport.width,
    bottom = viewport.top + viewport.height;
  let el = element;
  while (el && el !== document.body && el !== document.documentElement) {
    if (/auto|scroll|hidden|clip/.test(getComputedStyle(el).overflow)) {
      const rect = el.getBoundingClientRect();
      if (rect.left > left) left = rect.left;
      if (rect.top > top) top = rect.top;
      if (rect.right < right) right = rect.right;
      if (rect.bottom < bottom) bottom = rect.bottom;
    }
    el = el.parentElement;
  }
  return { left: left, top: top, right: right, bottom: bottom };
}

// An open surface keeps the side it opened on. Anchors wobble by fractions of
// a pixel — hover transforms, streaming re-measures, dot repositioning — and a
// naive side flip near the threshold teleports the surface across its anchor.
// Only a real shortfall beyond this margin earns a flip after opening.
const FLIP_HYSTERESIS = 8;

export function anchorSurface(trigger, surface, options) {
  options = options || {};
  const contextElement = trigger && trigger.contextElement;
  const observedTrigger = contextElement || trigger;
  const virtual = !!contextElement || !(trigger instanceof Element);
  // Anchor-visibility tracking is for surfaces that annotate content — their
  // anchor can scroll or pan out of view. A surface anchored to the viewport
  // itself (the mobile sheet) opts out: its anchor is a zero-height rect on
  // the viewport edge, which no intersection test can call visible.
  const trackVisibility = options.trackAnchorVisibility !== false;
  let placement = options.placement || "bottom-end",
    disposed = false,
    frame = 0,
    updating = false;
  let lastLeft = null,
    lastTop = null,
    settledSide = null;

  function updateNow() {
    frame = 0;
    if (
      disposed ||
      !surface.isConnected ||
      (virtual ? contextElement && !contextElement.isConnected : !trigger.isConnected)
    )
      return;
    updating = true;
    const viewport = viewportRect();
    // CSS viewport units describe the layout viewport on iOS, which does not
    // reliably shrink for the software keyboard. Expose the visual viewport so
    // scrollable overlays can size themselves to the space actually available.
    surface.style.setProperty("--overlay-viewport-width", viewport.width + "px");
    surface.style.setProperty("--overlay-viewport-height", viewport.height + "px");
    const anchor = trigger.getBoundingClientRect(),
      box = surface.getBoundingClientRect();
    // A 0×0 anchor at the origin is a dead anchor (collapsed range, detached
    // node) — hold the last good position rather than glide to the corner.
    if (!anchor.width && !anchor.height && !anchor.left && !anchor.top && lastLeft !== null) {
      updating = false;
      return;
    }
    const edge = tokenPx(surface, "--surface-edge"),
      gap = tokenPx(surface, "--surface-gap");
    let parts = placement.split("-"),
      side = parts[0],
      align = parts[1] || "center";
    let left,
      top,
      anchorVisible = true;
    if (side === "center") {
      left = viewport.left + (viewport.width - box.width) / 2;
      top = viewport.top + (viewport.height - box.height) / 2;
    } else {
      // Centered surfaces are exempt: a modal is not an annotation of its
      // trigger, so the trigger scrolling away must not hide it.
      if (trackVisibility) {
        const clip = anchorClipBounds(observedTrigger instanceof Element ? observedTrigger : null, viewport);
        anchorVisible =
          anchor.left < clip.right && anchor.right > clip.left && anchor.top < clip.bottom && anchor.bottom > clip.top;
      }
      const vertical = side === "top" || side === "bottom";
      // Sticky side: once a side has been settled on, keep preferring it.
      if (settledSide === side || settledSide === oppositeSide(side)) side = settledSide;
      const before = vertical ? anchor.top - viewport.top : anchor.left - viewport.left;
      const after = vertical
        ? viewport.top + viewport.height - anchor.bottom
        : viewport.left + viewport.width - anchor.right;
      const mainSize = vertical ? box.height : box.width;
      const preferredSpace = side === "top" || side === "left" ? before : after;
      const alternateSpace = side === "top" || side === "left" ? after : before;
      const slack = settledSide === side ? FLIP_HYSTERESIS : 0;
      if (preferredSpace + slack < mainSize + gap + edge && alternateSpace > preferredSpace) {
        side = oppositeSide(side);
      }
      settledSide = side;
      if (side === "top" || side === "bottom") {
        top = side === "bottom" ? anchor.bottom + gap : anchor.top - box.height - gap;
        left =
          align === "start"
            ? anchor.left
            : align === "end"
              ? anchor.right - box.width
              : anchor.left + (anchor.width - box.width) / 2;
      } else {
        left = side === "right" ? anchor.right + gap : anchor.left - box.width - gap;
        top =
          align === "start"
            ? anchor.top
            : align === "end"
              ? anchor.bottom - box.height
              : anchor.top + (anchor.height - box.height) / 2;
      }
    }
    // The reachability clamp is for a surface the user can see. A hidden
    // surface keeps its unclamped position so it fades back in exactly beside
    // its anchor when the content returns.
    if (anchorVisible) {
      left = clampToViewport(left, viewport.left + edge, viewport.left + viewport.width - edge - box.width);
      top = clampToViewport(top, viewport.top + edge, viewport.top + viewport.height - edge - box.height);
    }
    surface.toggleAttribute("data-anchor-hidden", !anchorVisible);
    if (left !== lastLeft) surface.style.left = left + "px";
    if (top !== lastTop) surface.style.top = top + "px";
    lastLeft = left;
    lastTop = top;
    surface.dataset.placement = side === "center" ? "center" : side + "-" + align;
    updating = false;
  }
  function update() {
    if (!disposed && !frame) frame = requestAnimationFrame(updateNow);
  }
  window.addEventListener("resize", update, { passive: true });
  window.visualViewport?.addEventListener("resize", update, { passive: true });
  window.visualViewport?.addEventListener("scroll", update, { passive: true });
  // Two things move an anchor's screen rect without firing anything an
  // observer can see: the canvas view transform (announced as rh-view-change
  // by applyTransform) and an ordinary DOM scroll — a card body or the reader
  // scrolling under an open surface. Track both, so a surface follows its
  // anchor instead of stranding at a stale screen position.
  document.addEventListener("rh-view-change", update, { passive: true });
  window.addEventListener("scroll", update, { capture: true, passive: true });
  const resizeObserver =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(function () {
          if (!updating) update();
        })
      : null;
  if (!virtual || contextElement) resizeObserver?.observe(observedTrigger);
  resizeObserver?.observe(surface);
  const mutationObserver = typeof MutationObserver === "function" ? new MutationObserver(update) : null;
  mutationObserver?.observe(surface, { childList: true, subtree: true, characterData: true });
  updateNow();
  return {
    update: update,
    dispose: function () {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      document.removeEventListener("rh-view-change", update);
      window.removeEventListener("scroll", update, { capture: true });
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    },
  };
}

/**
 * @param {{ surface: Element, anchor: Element | { getBoundingClientRect: () => DOMRect, contextElement?: Element }, placement?: string, trackAnchorVisibility?: boolean, trigger?: Element, restoreFocus?: boolean, closeOnOutsidePointer?: boolean, preventOutsidePointerDefault?: boolean | ((event: PointerEvent) => boolean), ignoreOutsidePointer?: (event: PointerEvent) => boolean, onClose?: (reason: string) => void }} options
 */
export function openAnchoredSurface(options) {
  const surface = options.surface;
  const anchor = options.anchor;
  setSurfaceOrigin(surface, anchor.getBoundingClientRect());
  const position = anchorSurface(anchor, surface, {
    placement: options.placement,
    trackAnchorVisibility: options.trackAnchorVisibility,
  });
  const unregister = registerLayer({
    element: surface,
    trigger: options.trigger,
    restoreFocus: options.restoreFocus,
    closeOnOutsidePointer: options.closeOnOutsidePointer,
    preventOutsidePointerDefault: options.preventOutsidePointerDefault,
    ignoreOutsidePointer: options.ignoreOutsidePointer,
    onClose: options.onClose,
  });
  return {
    update: position.update,
    dispose: function () {
      position.dispose();
      unregister({ restoreFocus: false });
      surface.classList.remove("visible");
    },
  };
}
