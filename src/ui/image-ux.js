import { visualSurfaceKey } from "./core.js";
import { scheduleEdges } from "./canvas-view.js";
import { hideAsk } from "./ask-followups.js";
import { openDialog } from "./primitives/dialog.js";

  // ===========================================================================
  // MARKDOWN IMAGE UX
  // ===========================================================================
  var imageResizeMemory = {};
  var activeLightbox = null;
  var IMAGE_MIN_WIDTH = 120;
  var LIGHTBOX_MIN_ZOOM = 0.25;
  var LIGHTBOX_MAX_ZOOM = 6;

  function imageSurfaceScale(dc){
    if (!dc || !dc.offsetWidth) return 1;
    var rect = dc.getBoundingClientRect();
    return rect.width ? rect.width / dc.offsetWidth : 1;
  }
  function imageMemoryKey(dc, img, index, surfaceKey){
    var nodeId = (dc && dc.dataset && dc.dataset.nodeId) || "doc";
    return String(surfaceKey || "surface") + ":" + nodeId + ":" + index + ":" + (img.getAttribute("src") || "");
  }
  function clampImageWidth(dc, value){
    var max = Math.max(IMAGE_MIN_WIDTH, dc ? dc.clientWidth : IMAGE_MIN_WIDTH);
    return Math.max(IMAGE_MIN_WIDTH, Math.min(max, value));
  }
export function nearestImageScrollContainer(el){
    var cur = el ? el.parentElement : null;
    while (cur && cur !== document.body && cur !== document.documentElement){
      var style = window.getComputedStyle(cur);
      var oy = style.overflowY;
      if ((oy === "auto" || oy === "scroll" || oy === "overlay") && cur.scrollHeight > cur.clientHeight + 1) return cur;
      cur = cur.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }
  function imageScrollScale(scroller){
    if (!scroller || !scroller.offsetHeight) return 1;
    var rect = scroller.getBoundingClientRect();
    return rect.height ? rect.height / scroller.offsetHeight : 1;
  }
export function keepImageHandleAnchored(scroller, beforeRect, afterRect){
    if (!scroller || !beforeRect || !afterRect) return;
    var delta = afterRect.bottom - beforeRect.bottom;
    if (!delta) return;
    scroller.scrollTop += delta / imageScrollScale(scroller);
  }
  function applyImageWidth(frame, width){
    frame.style.width = Math.round(width) + "px";
    frame.dataset.rhResized = "1";
  }
  function resetImageWidth(frame, key){
    frame.style.width = "";
    delete frame.dataset.rhResized;
    if (key) delete imageResizeMemory[key];
  }
export function beginImageResize(e, dc, frame, key){
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    hideAsk();
    var scale = imageSurfaceScale(dc);
    var startX = e.clientX;
    var startW = frame.getBoundingClientRect().width / scale;
    var scroller = nearestImageScrollContainer(frame);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch(_e){}
    function move(ev){
      ev.preventDefault();
      ev.stopPropagation();
      var next = clampImageWidth(dc, startW + (ev.clientX - startX) / scale);
      var before = frame.getBoundingClientRect();
      applyImageWidth(frame, next);
      keepImageHandleAnchored(scroller, before, frame.getBoundingClientRect());
      imageResizeMemory[key] = next;
      scheduleEdges();
    }
    function done(ev){
      if (ev) ev.stopPropagation();
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", done, true);
      window.removeEventListener("pointercancel", done, true);
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch(_e){}
      scheduleEdges();
    }
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", done, true);
    window.addEventListener("pointercancel", done, true);
  }
  function setLightboxTransform(img, state){
    img.style.setProperty("--rh-zoom", state.scale);
    img.style.setProperty("--rh-pan-x", Math.round(state.x) + "px");
    img.style.setProperty("--rh-pan-y", Math.round(state.y) + "px");
  }
  function clampLightboxZoom(value){
    return Math.max(LIGHTBOX_MIN_ZOOM, Math.min(LIGHTBOX_MAX_ZOOM, value));
  }
  function pointerDistance(a, b){
    var dx = a.clientX - b.clientX;
    var dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }
export function openImageLightbox(src, alt, trigger){
    closeImageLightbox();
    var overlay = document.createElement("div");
    overlay.className = "rh-lightbox";
    overlay.hidden = true;
    var dialog = document.createElement("div");
    dialog.className = "rh-lightbox-dialog";
    var img = document.createElement("img");
    img.className = "rh-lightbox-img";
    img.src = src;
    img.alt = alt || "";
    img.draggable = false;
    dialog.appendChild(img);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    var state = { scale: 1, x: 0, y: 0 };
    var drag = null;
    var pointers = {};
    var pinch = null;
    setLightboxTransform(img, state);
    activeLightbox = openDialog({
      dialog: dialog,
      backdrop: overlay,
      label: alt || "Image preview",
      initialFocus: dialog,
      trigger: trigger,
      removeOnDispose: true,
      onClose: function(){ overlay.remove(); activeLightbox = null; }
    });
    function clearPointer(id){
      delete pointers[id];
      var keys = Object.keys(pointers);
      if (keys.length < 2) pinch = null;
      if (!keys.length) drag = null;
    }
    overlay.addEventListener("wheel", function(e){
      e.preventDefault();
      e.stopPropagation();
      var next = clampLightboxZoom(state.scale * (e.deltaY < 0 ? 1.12 : 0.88));
      state.scale = next;
      if (state.scale <= 1){
        state.x = 0;
        state.y = 0;
      }
      setLightboxTransform(img, state);
    }, { passive: false });
    overlay.addEventListener("pointerdown", function(e){
      e.preventDefault();
      e.stopPropagation();
      pointers[e.pointerId] = { clientX: e.clientX, clientY: e.clientY };
      try { overlay.setPointerCapture(e.pointerId); } catch(_e){}
      var ids = Object.keys(pointers);
      if (ids.length >= 2){
        pinch = { dist: pointerDistance(pointers[ids[0]], pointers[ids[1]]), scale: state.scale };
        drag = null;
      } else if (e.target === img && state.scale > 1){
        drag = { x: e.clientX, y: e.clientY, ox: state.x, oy: state.y };
      }
    });
    overlay.addEventListener("pointermove", function(e){
      if (!pointers[e.pointerId]) return;
      e.preventDefault();
      e.stopPropagation();
      pointers[e.pointerId] = { clientX: e.clientX, clientY: e.clientY };
      var ids = Object.keys(pointers);
      if (pinch && ids.length >= 2){
        var dist = pointerDistance(pointers[ids[0]], pointers[ids[1]]);
        if (pinch.dist > 0) state.scale = clampLightboxZoom(pinch.scale * dist / pinch.dist);
        if (state.scale <= 1){ state.x = 0; state.y = 0; }
        setLightboxTransform(img, state);
      } else if (drag && state.scale > 1){
        state.x = drag.ox + e.clientX - drag.x;
        state.y = drag.oy + e.clientY - drag.y;
        setLightboxTransform(img, state);
      }
    });
    overlay.addEventListener("pointerup", function(e){ clearPointer(e.pointerId); });
    overlay.addEventListener("pointercancel", function(e){ clearPointer(e.pointerId); });
  }
export function closeImageLightbox(){
    if (!activeLightbox) return;
    var dialog = activeLightbox;
    activeLightbox = null;
    dialog.dispose();
  }
export function mountDocImages(dc, node, base, surfaceKey){
    if (!dc || !dc.querySelectorAll) return;
    var imgs = dc.querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++){
      var img = imgs[i];
      if (img.dataset.rhImgReady === "1") continue;
      if (img.closest(".viz, .viz-mounted")) continue;
      var frame = img.parentNode && img.parentNode.classList && img.parentNode.classList.contains("rh-img-frame")
        ? img.parentNode
        : null;
      if (!frame){
        frame = document.createElement("span");
        frame.className = "rh-img-frame";
        img.parentNode.insertBefore(frame, img);
        frame.appendChild(img);
      }
      var key = imageMemoryKey(dc, img, i, surfaceKey || visualSurfaceKey(node, base));
      img.dataset.rhImgReady = "1";
      img.tabIndex = 0;
      img.draggable = false;
      if (imageResizeMemory[key]) applyImageWidth(frame, imageResizeMemory[key]);
      var handle = document.createElement("button");
      handle.type = "button";
      handle.className = "rh-img-handle";
      handle.setAttribute("aria-label", "Resize image");
      handle.title = "Drag to resize · double-click to reset";
      frame.appendChild(handle);
      frame.addEventListener("pointerdown", function(e){ e.stopPropagation(); });
      img.addEventListener("click", function(e){
        e.preventDefault();
        e.stopPropagation();
        openImageLightbox(e.currentTarget.currentSrc || e.currentTarget.src, e.currentTarget.alt, e.currentTarget);
      });
      handle.addEventListener("pointerdown", (function(f, k){ return function(e){ beginImageResize(e, dc, f, k); }; })(frame, key));
      handle.addEventListener("dblclick", (function(f, k){ return function(e){
        e.preventDefault();
        e.stopPropagation();
        var scroller = nearestImageScrollContainer(f);
        var before = f.getBoundingClientRect();
        resetImageWidth(f, k);
        keepImageHandleAnchored(scroller, before, f.getBoundingClientRect());
        scheduleEdges();
      }; })(frame, key));
    }
  }
