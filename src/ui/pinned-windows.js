import { iconSvg } from "../core/html/icons.js";
import { holdFullLayout, setScrollPlace } from "./scroll-position.js";

const DUPLICATE_REFERENCE_ATTRIBUTES = ["aria-controls", "aria-describedby", "aria-labelledby", "for"];

// Moving an element through the DOM throws away every scroll offset inside
// it. Pinning moves the live card, so the places it is read at travel with
// it: the card keeps reading on exactly where it was. Only those scrollers
// are asked (a code block's sideways offset is not a place), since asking
// every element lays out every block a long document skips; an empty one
// (a card pinned as it is built) has no place and is not laid out to ask.
const READING_SCROLLERS = ".card-body, .rh-pdf-scroll, .structured-note";

/** @returns {Map<Element, number>} the vertical place of each scroller that had one */
function moveKeepingScroll(element, move) {
  const scrolled = [];
  for (const el of element.querySelectorAll(READING_SCROLLERS)) {
    if (el.firstChild && (el.scrollTop || el.scrollLeft)) scrolled.push([el, el.scrollTop, el.scrollLeft]);
  }
  move();
  const places = new Map();
  for (const [el, top, left] of scrolled) {
    setScrollPlace(el, top);
    el.scrollLeft = left;
    places.set(el, top);
  }
  return places;
}

/**
 * Pins the existing interactive card above the camera and leaves an inert
 * canvas proxy behind. Callers continue to own node identity and graph state;
 * this module owns the two presentation surfaces and their independent
 * viewport geometry.
 */
export function createPinnedWindows(options) {
  const layer = options.layer;
  const entries = new Map();
  let nextZ = 1;
  let disposed = false;
  const layerObserver = typeof MutationObserver === "function" ? new MutationObserver(removeDetachedEntries) : null;
  layerObserver?.observe(layer, { childList: true, subtree: true });

  function sync(node, pin) {
    if (disposed || !node?.el || !pin) {
      if (node) remove(node.id);
      return;
    }
    let entry = entries.get(node.id);
    if (!entry) entry = createEntry(node, pin);
    entry.node = node;
    entry.pin = pin;
    normalizePinSize(entry);
    syncPinnedActions(entry);
    scheduleProxyRender(entry);
    positionEntry(entry);
  }

  function createEntry(node, pin) {
    const source = node.el;
    const wrapper = document.createElement("section");
    wrapper.className = "pinned-window";
    wrapper.dataset.pinnedNodeId = node.id;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", "Pinned: " + (node.title || "Untitled card"));
    wrapper.style.zIndex = String(nextZ++);

    const origin = document.createElement("div");
    origin.className = "pinned-origin";
    origin.dataset.pinnedOriginId = node.id;
    source.before(origin);
    layer.appendChild(wrapper);

    const entry = {
      node,
      pin,
      wrapper,
      origin,
      card: source,
      visual: null,
      originBody: null,
      // The proxy is inert: its place changes only when it is rendered.
      originScroll: 0,
      renderFrame: 0,
      movingCard: true,
      pinnedActions: [],
      pinBadge: null,
      graphStyle: {
        height: source.style.height,
        minHeight: source.style.minHeight,
        maxHeight: source.style.maxHeight,
      },
    };
    entries.set(node.id, entry);
    node.canvasEl = origin;
    source.classList.add("pinned-window-card");
    const places = moveKeepingScroll(source, function () {
      wrapper.appendChild(source);
    });
    entry.originScroll = places.get(source.querySelector(":scope > .card-body")) || 0;
    entry.movingCard = false;

    entry.observer =
      typeof MutationObserver === "function"
        ? new MutationObserver(function () {
            scheduleProxyRender(entry);
            positionEntry(entry);
          })
        : null;
    entry.observer?.observe(source, {
      attributes: true,
      attributeFilter: ["class"],
      characterData: true,
      childList: true,
      subtree: true,
    });
    wrapper.addEventListener("pointerdown", function () {
      raise(entry);
    });
    wireDrag(entry, source.querySelector(":scope > .card-head"));
    wireResize(entry, source.querySelector(":scope > .card-resize"));
    renderProxy(entry);
    return entry;
  }

  function normalizePinSize(entry) {
    const scale = entry.pin.scale;
    if (!Number.isFinite(entry.pin.w) || entry.pin.w < 240)
      entry.pin.w = Math.max(240, entry.node.size.w || entry.card.offsetWidth || 240);
    if (!Number.isFinite(entry.pin.h) || entry.pin.h < 160) {
      const rendered = entry.card.getBoundingClientRect().height / Math.max(scale, 0.01);
      entry.pin.h = Math.max(160, rendered || entry.node.size.h || 160);
    }
  }

  function raise(entry) {
    entry.wrapper.style.zIndex = String(nextZ++);
  }

  function syncPinnedActions(entry) {
    const head = entry.card.querySelector(":scope > .card-head");
    const acts = head?.querySelector(":scope > .card-acts");
    if (!head || !acts) return;
    if (!entry.pinBadge) {
      // The filled pin leading the title is the pinned state and the unpin
      // control merged into one element; read-only holes keep the state marker
      // without the affordance.
      const badge = document.createElement(options.readOnly ? "span" : "button");
      badge.className = "pinned-pin";
      badge.innerHTML = iconSvg("pin-active");
      if (options.readOnly) {
        badge.setAttribute("role", "img");
        badge.setAttribute("aria-label", "Pinned to screen");
        badge.title = "Pinned to screen";
      } else {
        const button = /** @type {HTMLButtonElement} */ (badge);
        button.type = "button";
        button.dataset.pinnedAction = "unpin";
        button.setAttribute("aria-label", "Unpin window");
        button.title = "Unpin window";
        button.addEventListener("click", function (event) {
          event.stopPropagation();
          options.onUnpin?.(entry.node, event.detail === 0 ? "keyboard" : "pointer");
        });
      }
      entry.pinBadge = badge;
    }
    if (!entry.pinnedActions.length) {
      const focus = iconButton("locate", "Focus original on canvas", "focus-original");
      focus.addEventListener("click", function (event) {
        event.stopPropagation();
        options.onShowOriginal?.(entry.node, event.detail === 0 ? "keyboard" : "pointer");
      });
      entry.pinnedActions.push(focus);
    }
    head.insertBefore(entry.pinBadge, head.firstChild);
    const divider = entry.node.actDivider;
    for (let i = 0; i < entry.pinnedActions.length; i++)
      acts.insertBefore(entry.pinnedActions[i], divider || acts.firstChild);
  }

  function scheduleProxyRender(entry) {
    if (disposed || !entries.has(entry.node.id) || entry.renderFrame) return;
    entry.renderFrame = requestAnimationFrame(function () {
      entry.renderFrame = 0;
      if (!entry.card?.isConnected || !entries.has(entry.node.id)) return remove(entry.node.id);
      renderProxy(entry);
    });
  }

  function renderProxy(entry) {
    const source = entry.card;
    const visual = source.cloneNode(true);
    visual.classList.remove("card", "current", "flash", "card-enter", "entered", "pinned-window-card", "dragging");
    visual.classList.add("pinned-origin-card");
    visual.removeAttribute("data-id");
    visual.removeAttribute("style");
    visual.style.width = entry.node.size.w + "px";
    visual.style.height = entry.node.collapsed ? "auto" : entry.graphStyle.height;
    visual.style.minHeight = entry.node.collapsed ? "" : entry.graphStyle.minHeight;
    visual.style.maxHeight = entry.node.collapsed ? "" : entry.graphStyle.maxHeight;
    visual.inert = true;
    visual.setAttribute("aria-hidden", "true");
    // The caller restyles the clone as the card lives in the graph (e.g. the
    // authorial text size) while its node ids are still intact to match on.
    options.prepareProxy?.(entry.node, visual);
    visual.querySelectorAll("[id]").forEach(function (el) {
      el.removeAttribute("id");
    });
    visual.querySelectorAll("[data-id]").forEach(function (el) {
      el.removeAttribute("data-id");
    });
    visual.querySelectorAll("[data-node-id]").forEach(function (el) {
      el.removeAttribute("data-node-id");
    });
    visual.querySelectorAll("*").forEach(function (el) {
      for (let i = 0; i < DUPLICATE_REFERENCE_ATTRIBUTES.length; i++)
        el.removeAttribute(DUPLICATE_REFERENCE_ATTRIBUTES[i]);
    });
    // The proxy is the card as it lives in the graph: no pinned chrome.
    visual.querySelectorAll(".pinned-pin, .pinned-window-action").forEach(function (el) {
      el.remove();
    });

    const overlay = document.createElement("button");
    overlay.type = "button";
    overlay.className = "pinned-origin-overlay";
    overlay.setAttribute("aria-label", "Show pinned window: " + (entry.node.title || "Untitled card"));
    overlay.innerHTML =
      '<span class="pinned-origin-label">' + iconSvg("pin-active") + "<span>Pinned to screen</span></span>";
    overlay.addEventListener("click", function () {
      raise(entry);
      entry.node.moreBtn?.focus({ preventScroll: true });
    });

    entry.origin.replaceChildren(visual, overlay);
    entry.visual = visual;
    entry.originBody = visual.querySelector(":scope > .card-body");
    entry.node.canvasBodyEl = entry.originBody;
    if (entry.originBody) {
      // The proxy stands in for the card on the graph: its height, and the
      // edge drawn to it, must come from its real layout, not from estimates
      // of text it has never shown. It is laid out in full once.
      const release = holdFullLayout(entry.originBody);
      if (entry.originScroll > 0) entry.originBody.scrollTop = entry.originScroll;
      release();
    }
    copyCanvasPixels(source, visual);
    positionOrigin(entry);
  }

  function positionOrigin(entry) {
    const origin = entry.origin;
    origin.style.left = entry.node.position.x + "px";
    origin.style.top = entry.node.position.y + "px";
    origin.style.width = entry.node.size.w + "px";
  }

  function positionEntry(entry) {
    if (!entry.pin) return;
    const scale = entry.pin.scale;
    entry.wrapper.setAttribute("aria-label", "Pinned: " + (entry.node.title || "Untitled card"));
    entry.wrapper.style.left = entry.pin.x + "px";
    entry.wrapper.style.top = entry.pin.y + "px";
    entry.wrapper.style.width = entry.pin.w * scale + "px";
    entry.wrapper.style.height =
      (entry.node.collapsed ? entry.card.querySelector(":scope > .card-head")?.offsetHeight || 36 : entry.pin.h) *
        scale +
      "px";
    entry.card.style.left = "0";
    entry.card.style.top = "0";
    entry.card.style.width = entry.pin.w + "px";
    entry.card.style.height = entry.node.collapsed ? "auto" : entry.pin.h + "px";
    entry.card.style.minHeight = "";
    entry.card.style.maxHeight = "";
    entry.card.style.transform = "scale(" + scale + ")";
    positionOrigin(entry);
  }

  function wireDrag(entry, head) {
    if (!head) return;
    let pointerId = null,
      startX = 0,
      startY = 0,
      originX = 0,
      originY = 0,
      moved = false;
    head.addEventListener("pointerdown", function (event) {
      if (event.button !== 0 || event.target.closest("button, a, [contenteditable]")) return;
      event.preventDefault();
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      originX = entry.pin.x;
      originY = entry.pin.y;
      moved = false;
      entry.wrapper.classList.add("dragging");
      try {
        head.setPointerCapture(pointerId);
      } catch (_error) {}
    });
    head.addEventListener("pointermove", function (event) {
      if (pointerId !== event.pointerId) return;
      const dx = event.clientX - startX,
        dy = event.clientY - startY;
      moved = moved || Math.hypot(dx, dy) > 2;
      const visibleGrip = 44;
      entry.pin.x = Math.max(
        visibleGrip - entry.wrapper.offsetWidth,
        Math.min(Math.max(0, layer.clientWidth - visibleGrip), originX + dx),
      );
      entry.pin.y = Math.max(0, Math.min(Math.max(0, layer.clientHeight - visibleGrip), originY + dy));
      positionEntry(entry);
    });
    function finish(event) {
      if (pointerId !== event.pointerId) return;
      try {
        head.releasePointerCapture(pointerId);
      } catch (_error) {}
      pointerId = null;
      entry.wrapper.classList.remove("dragging");
      if (moved) options.onChange?.(entry.node, entry.pin);
    }
    head.addEventListener("pointerup", finish);
    head.addEventListener("pointercancel", finish);
    head.addEventListener("lostpointercapture", function () {
      if (pointerId === null) return;
      pointerId = null;
      entry.wrapper.classList.remove("dragging");
      if (moved) options.onChange?.(entry.node, entry.pin);
    });
  }

  function wireResize(entry, handle) {
    if (!handle || options.readOnly) return;
    let pointerId = null,
      startX = 0,
      startY = 0,
      startW = 0,
      startH = 0,
      moved = false;
    handle.addEventListener("pointerdown", function (event) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startW = entry.pin.w;
      startH = entry.pin.h;
      moved = false;
      try {
        handle.setPointerCapture(pointerId);
      } catch (_error) {}
    });
    handle.addEventListener("pointermove", function (event) {
      if (pointerId !== event.pointerId) return;
      const dx = (event.clientX - startX) / entry.pin.scale;
      const dy = (event.clientY - startY) / entry.pin.scale;
      moved = moved || Math.hypot(dx, dy) > 2;
      entry.pin.w = Math.max(240, startW + dx);
      entry.pin.h = Math.max(160, startH + dy);
      positionEntry(entry);
    });
    function finish(event) {
      if (pointerId !== event.pointerId) return;
      try {
        handle.releasePointerCapture(pointerId);
      } catch (_error) {}
      pointerId = null;
      if (moved) options.onChange?.(entry.node, entry.pin);
    }
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", function () {
      if (pointerId === null) return;
      pointerId = null;
      if (moved) options.onChange?.(entry.node, entry.pin);
    });
  }

  function remove(id) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    if (entry.renderFrame) cancelAnimationFrame(entry.renderFrame);
    entry.observer?.disconnect();
    entry.pinnedActions.forEach(function (action) {
      action.remove();
    });
    entry.pinBadge?.remove();
    if (entry.card?.isConnected) {
      moveKeepingScroll(entry.card, function () {
        entry.origin.before(entry.card);
      });
      entry.card.classList.remove("pinned-window-card");
      entry.card.style.transform = "";
      entry.card.style.left = entry.node.position.x + "px";
      entry.card.style.top = entry.node.position.y + "px";
      entry.card.style.width = entry.node.size.w + "px";
      entry.card.style.height = entry.graphStyle.height;
      entry.card.style.minHeight = entry.graphStyle.minHeight;
      entry.card.style.maxHeight = entry.graphStyle.maxHeight;
    }
    entry.origin.remove();
    entry.wrapper.remove();
    delete entry.node.canvasEl;
    delete entry.node.canvasBodyEl;
  }

  function removeDetachedEntries() {
    entries.forEach(function (entry, id) {
      if (!entry.card?.isConnected && !entry.movingCard) remove(id);
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    layerObserver?.disconnect();
    Array.from(entries.keys()).forEach(remove);
  }

  return { sync, remove, dispose };
}

function iconButton(icon, label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card-btn pinned-window-action";
  button.setAttribute("aria-label", label);
  button.dataset.pinnedAction = action;
  button.title = label;
  button.innerHTML = iconSvg(icon);
  return button;
}

function copyCanvasPixels(source, clone) {
  const sourceCanvases = source.querySelectorAll("canvas");
  const cloneCanvases = clone.querySelectorAll("canvas");
  for (let i = 0; i < Math.min(sourceCanvases.length, cloneCanvases.length); i++) {
    const sourceCanvas = sourceCanvases[i],
      cloneCanvas = cloneCanvases[i];
    cloneCanvas.width = sourceCanvas.width;
    cloneCanvas.height = sourceCanvas.height;
    try {
      cloneCanvas.getContext("2d")?.drawImage(sourceCanvas, 0, 0);
    } catch (_error) {}
  }
}
