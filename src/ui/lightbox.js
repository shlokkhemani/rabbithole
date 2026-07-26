import { iconSvg } from "../core/html/icons.js";
import { openDialog } from "./primitives/dialog.js";

var activeLightbox = null;
var LIGHTBOX_MIN_ZOOM = 0.25;
var LIGHTBOX_MAX_ZOOM = 6;

function setLightboxTransform(content, state){
  content.style.setProperty("--rh-zoom", state.scale);
  content.style.setProperty("--rh-pan-x", Math.round(state.x) + "px");
  content.style.setProperty("--rh-pan-y", Math.round(state.y) + "px");
}

function clampLightboxZoom(value){
  return Math.max(LIGHTBOX_MIN_ZOOM, Math.min(LIGHTBOX_MAX_ZOOM, value));
}

function pointerDistance(a, b){
  var dx = a.clientX - b.clientX;
  var dy = a.clientY - b.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function containsContent(entry, target){
  return entry.content === target || entry.content.contains(target);
}

function diagramAspect(content){
  var viewBox = content.viewBox && content.viewBox.baseVal;
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) return viewBox.width / viewBox.height;
  var values = String(content.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  if (values.length === 4 && values[2] > 0 && values[3] > 0) return values[2] / values[3];
  return 1;
}

function diagramPlateInset(style, start, end){
  return (parseFloat(style[start]) || 0) + (parseFloat(style[end]) || 0);
}

function sizeDiagramPlate(content, viewport){
  if (!content.classList.contains("rh-lightbox-diagram")) return;
  var style = getComputedStyle(viewport);
  var insetWidth = diagramPlateInset(style, "paddingLeft", "paddingRight") + diagramPlateInset(style, "borderLeftWidth", "borderRightWidth");
  var insetHeight = diagramPlateInset(style, "paddingTop", "paddingBottom") + diagramPlateInset(style, "borderTopWidth", "borderBottomWidth");
  var maxWidth = Math.max(1, Math.min(innerWidth * 0.96, innerWidth - 112));
  var maxHeight = Math.max(1, Math.min(innerHeight * 0.92, innerHeight - 32));
  var availableWidth = Math.max(1, maxWidth - insetWidth);
  var availableHeight = Math.max(1, maxHeight - insetHeight);
  var aspect = diagramAspect(content);
  var width = availableWidth;
  var height = width / aspect;
  if (height > availableHeight){
    height = availableHeight;
    width = height * aspect;
  }
  viewport.style.width = width + insetWidth + "px";
  viewport.style.height = height + insetHeight + "px";
}

export function openLightbox(options){
  options = options || {};
  if (!options.content || !options.content.nodeType) throw new Error("openLightbox requires content");
  closeLightbox();

  var diagram = options.variant === "diagram";
  var overlay = document.createElement("div");
  overlay.className = "rh-lightbox rh-lightbox-variant-" + (diagram ? "diagram" : "image");
  overlay.hidden = true;
  var dialog = document.createElement("div");
  dialog.className = "rh-lightbox-dialog";
  var close = document.createElement("button");
  close.type = "button";
  close.className = "rh-lightbox-close";
  close.setAttribute("aria-label", "Close");
  close.innerHTML = iconSvg("close");
  var viewport = document.createElement("div");
  viewport.className = "rh-lightbox-viewport" + (diagram ? " rh-lightbox-plate" : "");
  var content = options.content;
  content.classList.add("rh-lightbox-content");
  viewport.appendChild(content);
  dialog.appendChild(close);
  dialog.appendChild(viewport);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  var state = { scale: 1, x: 0, y: 0 };
  var drag = null;
  var pointers = {};
  var pinch = null;
  var recentContentPointer = false;
  var disposed = false;
  var dialogHandle = null;
  var entry = {
    content: content,
    state: state,
    isOpen: function(){ return activeLightbox === entry && !disposed; },
    replaceContent: function(nextContent){
      if (!entry.isOpen() || !nextContent || !nextContent.nodeType) return false;
      nextContent.classList.add("rh-lightbox-content");
      viewport.replaceChild(nextContent, entry.content);
      entry.content = nextContent;
      pointers = {};
      pinch = null;
      drag = null;
      recentContentPointer = false;
      setLightboxTransform(nextContent, state);
      sizeDiagramPlate(nextContent, viewport);
      return true;
    },
    close: function(){ if (activeLightbox === entry) closeLightbox(); },
    dispose: function(){ if (activeLightbox === entry) closeLightbox(); }
  };

  function clearPointer(id){
    delete pointers[id];
    var keys = Object.keys(pointers);
    if (keys.length < 2) pinch = null;
    if (!keys.length) drag = null;
  }

  function onWheel(e){
    e.preventDefault();
    e.stopPropagation();
    state.scale = clampLightboxZoom(state.scale * (e.deltaY < 0 ? 1.12 : 0.88));
    if (state.scale <= 1){
      state.x = 0;
      state.y = 0;
    }
    setLightboxTransform(entry.content, state);
  }

  function onPointerdown(e){
    if (close.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    recentContentPointer = containsContent(entry, e.target);
    pointers[e.pointerId] = { clientX: e.clientX, clientY: e.clientY };
    try { overlay.setPointerCapture(e.pointerId); } catch(_e){}
    var ids = Object.keys(pointers);
    if (ids.length >= 2){
      pinch = { dist: pointerDistance(pointers[ids[0]], pointers[ids[1]]), scale: state.scale };
      drag = null;
    } else if (recentContentPointer && state.scale > 1){
      drag = { x: e.clientX, y: e.clientY, ox: state.x, oy: state.y };
    }
  }

  function onPointermove(e){
    if (!pointers[e.pointerId]) return;
    e.preventDefault();
    e.stopPropagation();
    pointers[e.pointerId] = { clientX: e.clientX, clientY: e.clientY };
    var ids = Object.keys(pointers);
    if (pinch && ids.length >= 2){
      var dist = pointerDistance(pointers[ids[0]], pointers[ids[1]]);
      if (pinch.dist > 0) state.scale = clampLightboxZoom(pinch.scale * dist / pinch.dist);
      if (state.scale <= 1){ state.x = 0; state.y = 0; }
      setLightboxTransform(entry.content, state);
    } else if (drag && state.scale > 1){
      state.x = drag.ox + e.clientX - drag.x;
      state.y = drag.oy + e.clientY - drag.y;
      setLightboxTransform(entry.content, state);
    }
  }

  function onDoubleClick(e){
    if (!containsContent(entry, e.target) && !recentContentPointer) return;
    e.preventDefault();
    e.stopPropagation();
    recentContentPointer = false;
    state.scale = state.scale === 1 ? 2 : 1;
    state.x = 0;
    state.y = 0;
    setLightboxTransform(entry.content, state);
  }

  function onCloseClick(e){
    e.preventDefault();
    e.stopPropagation();
    closeLightbox();
  }

  function onResize(){
    sizeDiagramPlate(entry.content, viewport);
  }

  function cleanup(){
    if (disposed) return;
    disposed = true;
    overlay.removeEventListener("wheel", onWheel);
    overlay.removeEventListener("pointerdown", onPointerdown);
    overlay.removeEventListener("pointermove", onPointermove);
    overlay.removeEventListener("pointerup", onPointerup);
    overlay.removeEventListener("pointercancel", onPointercancel);
    overlay.removeEventListener("dblclick", onDoubleClick);
    close.removeEventListener("click", onCloseClick);
    if (diagram) window.removeEventListener("resize", onResize);
    overlay.remove();
    if (activeLightbox === entry) activeLightbox = null;
  }

  function onPointerup(e){ clearPointer(e.pointerId); }
  function onPointercancel(e){ clearPointer(e.pointerId); }

  setLightboxTransform(content, state);
  overlay.addEventListener("wheel", onWheel, { passive: false });
  overlay.addEventListener("pointerdown", onPointerdown);
  overlay.addEventListener("pointermove", onPointermove);
  overlay.addEventListener("pointerup", onPointerup);
  overlay.addEventListener("pointercancel", onPointercancel);
  overlay.addEventListener("dblclick", onDoubleClick);
  close.addEventListener("click", onCloseClick);
  if (diagram) window.addEventListener("resize", onResize);
  activeLightbox = entry;
  dialogHandle = openDialog({
    dialog: dialog,
    backdrop: overlay,
    label: options.label || (options.variant === "diagram" ? "Mermaid diagram" : "Image preview"),
    initialFocus: dialog,
    trigger: options.trigger,
    removeOnDispose: true,
    onClose: cleanup
  });
  sizeDiagramPlate(content, viewport);
  entry.dialog = dialogHandle;
  return entry;
}

export function closeLightbox(){
  if (!activeLightbox) return;
  var entry = activeLightbox;
  activeLightbox = null;
  entry.dialog.dispose();
}

export function disposeLightbox(){
  closeLightbox();
}
