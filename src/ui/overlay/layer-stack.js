const layers = [];
const consumedPointers = new Set();

function onConsumedPointerEnd(event) {
  if (!consumedPointers.has(event.pointerId)) return;
  consumedPointers.delete(event.pointerId);
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!consumedPointers.size) {
    document.removeEventListener("pointerup", onConsumedPointerEnd, true);
    document.removeEventListener("pointercancel", onConsumedPointerEnd, true);
  }
}

function consumePointerGesture(event) {
  if (!consumedPointers.size) {
    document.addEventListener("pointerup", onConsumedPointerEnd, true);
    document.addEventListener("pointercancel", onConsumedPointerEnd, true);
  }
  consumedPointers.add(event.pointerId);
  event.preventDefault();
  event.stopImmediatePropagation();
}

export function focusElement(element) {
  if (!element || !element.isConnected || typeof element.focus !== "function") return false;
  try {
    element.focus({ preventScroll: true });
  } catch (error) {
    try {
      element.focus();
    } catch (_error) {
      return false;
    }
  }
  return true;
}
function onKeydown(event) {
  if (event.key !== "Escape") return;
  const layer = layers[layers.length - 1];
  if (!layer || !layer.closeOnEscape) return;
  event.preventDefault();
  event.stopPropagation();
  layer.onClose("escape");
}
function onPointerdown(event) {
  const layer = layers[layers.length - 1];
  if (!layer || !layer.closeOnOutsidePointer) return;
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  if (
    path.includes(layer.element) ||
    path.includes(layer.trigger) ||
    layer.element.contains(event.target) ||
    layer.trigger?.contains(event.target)
  )
    return;
  if (layer.ignoreOutsidePointer?.(event)) return;
  const preventOutsidePointerDefault = layer.preventOutsidePointerDefault;
  if (
    typeof preventOutsidePointerDefault === "function"
      ? preventOutsidePointerDefault(event)
      : preventOutsidePointerDefault
  )
    consumePointerGesture(event);
  layer.onClose("outside-pointer");
  if (layer.restoreFocus)
    layer.focusTimer = setTimeout(function () {
      layer.focusTimer = 0;
      if (!focusElement(layer.trigger)) focusElement(layer.previousFocus);
    }, 0);
}
function syncListeners() {
  const method = layers.length ? "addEventListener" : "removeEventListener";
  document[method]("keydown", onKeydown, true);
  document[method]("pointerdown", onPointerdown, true);
}

/**
 * @param {{ element: Element, trigger?: Element | null, onClose: (reason: string) => void, ignoreOutsidePointer?: ((event: PointerEvent) => boolean) | null, closeOnEscape?: boolean, closeOnOutsidePointer?: boolean, preventOutsidePointerDefault?: boolean | ((event: PointerEvent) => boolean), restoreFocus?: boolean }} options
 */
export function registerLayer(options) {
  const layer = {
    element: options.element,
    trigger: options.trigger || null,
    onClose: options.onClose,
    ignoreOutsidePointer: options.ignoreOutsidePointer || null,
    closeOnEscape: options.closeOnEscape !== false,
    closeOnOutsidePointer: options.closeOnOutsidePointer !== false,
    preventOutsidePointerDefault:
      options.preventOutsidePointerDefault === undefined ? true : options.preventOutsidePointerDefault,
    restoreFocus: options.restoreFocus !== false,
    previousFocus: document.activeElement,
    focusTimer: 0,
  };
  layers.push(layer);
  if (layers.length === 1) syncListeners();
  let active = true;
  return function unregisterLayer(settings) {
    if (!active) return;
    active = false;
    const index = layers.indexOf(layer);
    if (index !== -1) layers.splice(index, 1);
    if (!layers.length) syncListeners();
    if (layer.focusTimer) {
      clearTimeout(layer.focusTimer);
      layer.focusTimer = 0;
    }
    if (layer.restoreFocus && (!settings || settings.restoreFocus !== false)) {
      if (!focusElement(layer.trigger)) focusElement(layer.previousFocus);
    }
  };
}
