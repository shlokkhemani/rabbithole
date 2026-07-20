import { activateFocusTrap } from "../focus-trap.js";
import { anchorSurface } from "../overlay/anchor.js";
import { registerLayer } from "../overlay/layer-stack.js";

export function openPopover(options) {
  var trigger = options.trigger, surface = options.surface, closed = false;
  trigger?.setAttribute("aria-expanded", "true");
  var position = anchorSurface(trigger, surface, { placement: options.placement });
  var trap = activateFocusTrap(options.trapRoot || surface, {
    initialFocus: options.initialFocus,
    restoreFocus: false
  });
  var unregister = registerLayer({
    element: surface,
    trigger: trigger,
    onClose: function(reason) { options.onClose?.(reason); },
    closeOnEscape: options.closeOnEscape,
    closeOnOutsidePointer: options.closeOnOutsidePointer,
    restoreFocus: options.restoreFocus
  });

  function close(settings) {
    if (closed) return;
    closed = true;
    trigger?.setAttribute("aria-expanded", "false");
    trap();
    position.dispose();
    unregister(settings);
  }

  return { close: close, dispose: close, update: position.update };
}
