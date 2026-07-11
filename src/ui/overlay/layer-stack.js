var layers = [];

function focus(element) {
  if (!element || !element.isConnected || typeof element.focus !== "function") return false;
  try { element.focus({ preventScroll: true }); } catch (error) { try { element.focus(); } catch (_error) { return false; } }
  return true;
}
function onKeydown(event) {
  if (event.key !== "Escape") return;
  var layer = layers[layers.length - 1];
  if (!layer || !layer.closeOnEscape) return;
  event.preventDefault(); event.stopPropagation(); layer.onClose("escape");
}
function onPointerdown(event) {
  var layer = layers[layers.length - 1];
  if (!layer || !layer.closeOnOutsidePointer) return;
  var path = typeof event.composedPath === "function" ? event.composedPath() : [];
  if (path.includes(layer.element) || path.includes(layer.trigger) || layer.element.contains(event.target) || layer.trigger?.contains(event.target)) return;
  if (layer.preventOutsidePointerDefault) event.preventDefault();
  layer.onClose("outside-pointer");
  if (layer.restoreFocus) layer.focusTimer = setTimeout(function(){
    layer.focusTimer = 0;
    if (!focus(layer.trigger)) focus(layer.previousFocus);
  }, 0);
}
function syncListeners() {
  var method = layers.length ? "addEventListener" : "removeEventListener";
  document[method]("keydown", onKeydown, true); document[method]("pointerdown", onPointerdown, true);
}

export function registerLayer(options) {
  var layer = { element: options.element, trigger: options.trigger || null, onClose: options.onClose,
    closeOnEscape: options.closeOnEscape !== false, closeOnOutsidePointer: options.closeOnOutsidePointer !== false,
    preventOutsidePointerDefault: options.preventOutsidePointerDefault !== false,
    restoreFocus: options.restoreFocus !== false, previousFocus: document.activeElement, focusTimer: 0 };
  layers.push(layer); if (layers.length === 1) syncListeners();
  var active = true;
  return function unregisterLayer(settings) {
    if (!active) return; active = false;
    var index = layers.indexOf(layer); if (index !== -1) layers.splice(index, 1);
    if (!layers.length) syncListeners();
    if (layer.focusTimer){ clearTimeout(layer.focusTimer); layer.focusTimer = 0; }
    if (layer.restoreFocus && (!settings || settings.restoreFocus !== false)) {
      if (!focus(layer.trigger)) focus(layer.previousFocus);
    }
  };
}
