import { isDockedNote } from "../../core/hole/ask.js";
import { CANVAS_BASE, fontPx, frozen, MAX_SCALE, MIN_SCALE, normalizeFontScale, postBrowserEvent } from "../core.js";
import { reflowKeepingPlace } from "../scroll-position.js";
import { r } from "./runtime.js";

export function canPinWindow(node) {
  return !!node && !node._ephemeral && !isDockedNote(node);
}

export function nodePin(node) {
  if (!canPinWindow(node)) return null;
  const pin = node.view && node.view.pin;
  if (
    !pin ||
    !Number.isFinite(pin.x) ||
    !Number.isFinite(pin.y) ||
    !Number.isFinite(pin.scale) ||
    pin.scale < MIN_SCALE ||
    pin.scale > MAX_SCALE
  )
    return null;
  return pin;
}

export function persistCanvasExtension(node) {
  postBrowserEvent({ type: "node_extensions_patch", node_id: node.id, namespace: "canvas", value: node.view });
}

export function pinnedFontScale(node) {
  const pin = nodePin(node);
  return pin && Number.isFinite(pin.fontScale) ? pin.fontScale : (node && node.font_scale) || 1;
}

export function setPinnedFontScale(node, value) {
  const pin = nodePin(node);
  if (!pin) return (node && node.font_scale) || 1;
  pin.fontScale = normalizeFontScale(value);
  reflowKeepingPlace(node.bodyEl ? [node.bodyEl] : [], function () {
    applyCardFontSize(node);
  });
  if (!frozen) persistCanvasExtension(node);
  return pin.fontScale;
}

function applyCardFontSize(node) {
  if (!node.el) return;
  const surfaces = node.el.querySelectorAll(".doc-content, .note-editor");
  for (let i = 0; i < surfaces.length; i++) {
    if (surfaces[i].dataset.nodeId !== node.id) continue;
    surfaces[i].style.fontSize = fontPx(CANVAS_BASE, pinnedFontScale(node)) + "px";
  }
}

export function syncNodePinPresentation(node) {
  if (!node || !node.el) return;
  const pin = nodePin(node);
  applyCardFontSize(node);
  r.pinnedWindows?.sync(node, pin);
}
