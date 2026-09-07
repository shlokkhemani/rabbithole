import { closeLightbox, disposeLightbox, openLightbox } from "./lightbox.js";

// ===========================================================================
// MARKDOWN IMAGE UX
// ===========================================================================
let imageResizeMemory = {};
let activeImageResizeCleanup = null;
const IMAGE_MIN_WIDTH = 120;

function noop() {}
function noProvenance(_nodeId, _assetName) {
  return null;
}

function imageAssetName(src) {
  try {
    const path = new URL(src, window.location.href).pathname;
    const match = path.match(/\/assets\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch (_error) {
    return null;
  }
}

function imageSurfaceScale(dc) {
  if (!dc || !dc.offsetWidth) return 1;
  const rect = dc.getBoundingClientRect();
  return rect.width ? rect.width / dc.offsetWidth : 1;
}
function imageMemoryKey(dc, img, index, surfaceKey) {
  const nodeId = (dc && dc.dataset && dc.dataset.nodeId) || "doc";
  return String(surfaceKey || "surface") + ":" + nodeId + ":" + index + ":" + (img.getAttribute("src") || "");
}
function clampImageWidth(dc, value) {
  const max = Math.max(IMAGE_MIN_WIDTH, dc ? dc.clientWidth : IMAGE_MIN_WIDTH);
  return Math.max(IMAGE_MIN_WIDTH, Math.min(max, value));
}
function nearestImageScrollContainer(el) {
  let cur = el ? el.parentElement : null;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    const style = window.getComputedStyle(cur);
    const oy = style.overflowY;
    if ((oy === "auto" || oy === "scroll" || oy === "overlay") && cur.scrollHeight > cur.clientHeight + 1) return cur;
    cur = cur.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}
function imageScrollScale(scroller) {
  if (!scroller || !scroller.offsetHeight) return 1;
  const rect = scroller.getBoundingClientRect();
  return rect.height ? rect.height / scroller.offsetHeight : 1;
}
function keepImageHandleAnchored(scroller, beforeRect, afterRect) {
  if (!scroller || !beforeRect || !afterRect) return;
  const delta = afterRect.bottom - beforeRect.bottom;
  if (!delta) return;
  scroller.scrollTop += delta / imageScrollScale(scroller);
}
function applyImageWidth(frame, width) {
  frame.style.width = Math.round(width) + "px";
  frame.dataset.rhResized = "1";
}
function resetImageWidth(frame, key) {
  frame.style.width = "";
  delete frame.dataset.rhResized;
  if (key) delete imageResizeMemory[key];
}
function beginImageResize(e, dc, frame, key, hideAsk, scheduleEdges) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  hideAsk();
  const scale = imageSurfaceScale(dc);
  const startX = e.clientX;
  const startW = frame.getBoundingClientRect().width / scale;
  const scroller = nearestImageScrollContainer(frame);
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch (_e) {}
  function move(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const next = clampImageWidth(dc, startW + (ev.clientX - startX) / scale);
    const before = frame.getBoundingClientRect();
    applyImageWidth(frame, next);
    keepImageHandleAnchored(scroller, before, frame.getBoundingClientRect());
    imageResizeMemory[key] = next;
    scheduleEdges();
  }
  if (activeImageResizeCleanup) activeImageResizeCleanup();
  function done(ev) {
    if (ev) ev.stopPropagation();
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", done, true);
    window.removeEventListener("pointercancel", done, true);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch (_e) {}
    if (activeImageResizeCleanup === done) activeImageResizeCleanup = null;
    scheduleEdges();
  }
  activeImageResizeCleanup = done;
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", done, true);
  window.addEventListener("pointercancel", done, true);
}
export function openImageLightbox(src, alt, trigger, provenance) {
  closeLightbox();
  const img = document.createElement("img");
  img.className = "rh-lightbox-img";
  img.src = src;
  img.alt = alt || "";
  img.draggable = false;
  if (trigger && trigger.dataset && trigger.dataset.rhPasted === "1") img.dataset.rhPasted = "1";
  let caption = null;
  if (provenance) {
    caption = document.createElement("div");
    caption.className = "rh-lightbox-caption";
    if (alt) {
      const altLine = document.createElement("div");
      altLine.className = "rh-lightbox-caption-alt";
      altLine.textContent = alt;
      caption.appendChild(altLine);
    }
    const prompt = provenance.revised_prompt != null ? provenance.revised_prompt : provenance.prompt;
    if (prompt != null) {
      const promptLine = document.createElement("div");
      promptLine.className = "rh-lightbox-caption-prompt";
      promptLine.textContent = prompt;
      caption.appendChild(promptLine);
    }
  }
  return openLightbox({
    content: img,
    caption: caption,
    label: alt || "Image preview",
    trigger: trigger,
    variant: "image",
  });
}
export function disposeImageUx() {
  if (activeImageResizeCleanup) activeImageResizeCleanup();
  disposeLightbox();
  imageResizeMemory = {};
}
export function mountDocImages(
  dc,
  surfaceKey,
  { hideAsk = noop, scheduleEdges = noop, provenanceFor = noProvenance } = {},
) {
  if (!dc || !dc.querySelectorAll) return;
  const imgs = dc.querySelectorAll("img");
  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i];
    if (img.dataset.rhImgReady === "1") continue;
    if (img.closest(".viz, .viz-mounted")) continue;
    let frame =
      img.parentNode && img.parentNode.classList && img.parentNode.classList.contains("rh-img-frame")
        ? img.parentNode
        : null;
    if (!frame) {
      frame = document.createElement("span");
      frame.className = "rh-img-frame";
      img.parentNode.insertBefore(frame, img);
      frame.appendChild(img);
    }
    if (img.dataset.rhPasted === "1") frame.dataset.rhPasted = "1";
    const key = imageMemoryKey(dc, img, i, surfaceKey);
    img.dataset.rhImgReady = "1";
    img.tabIndex = 0;
    img.draggable = false;
    if (imageResizeMemory[key]) applyImageWidth(frame, imageResizeMemory[key]);
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "rh-img-handle";
    handle.setAttribute("aria-label", "Resize image");
    handle.title = "Drag to resize · double-click to reset";
    frame.appendChild(handle);
    frame.addEventListener("pointerdown", function (e) {
      e.stopPropagation();
    });
    img.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      const src = e.currentTarget.currentSrc || e.currentTarget.src;
      const assetName = imageAssetName(src);
      const provenance = assetName ? provenanceFor(dc.dataset.nodeId, assetName) : null;
      openImageLightbox(src, e.currentTarget.alt, e.currentTarget, provenance);
    });
    handle.addEventListener(
      "pointerdown",
      (function (f, k) {
        return function (e) {
          beginImageResize(e, dc, f, k, hideAsk, scheduleEdges);
        };
      })(frame, key),
    );
    handle.addEventListener(
      "dblclick",
      (function (f, k) {
        return function (e) {
          e.preventDefault();
          e.stopPropagation();
          const scroller = nearestImageScrollContainer(f);
          const before = f.getBoundingClientRect();
          resetImageWidth(f, k);
          keepImageHandleAnchored(scroller, before, f.getBoundingClientRect());
          scheduleEdges();
        };
      })(frame, key),
    );
  }
}
