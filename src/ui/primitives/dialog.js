import { registerLayer } from "../overlay/layer-stack.js";

var FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function focus(element) {
  if (!element || !element.isConnected || typeof element.focus !== "function") return false;
  try { element.focus({ preventScroll: true }); } catch (error) { try { element.focus(); } catch (_error) { return false; } }
  return true;
}

function visibleFocusables(dialog) {
  return Array.prototype.slice.call(dialog.querySelectorAll(FOCUSABLE)).filter(function(element) {
    return element.offsetParent !== null || element === document.activeElement;
  });
}

function resolveInitialFocus(dialog, requested) {
  var explicit = typeof requested === "string" ? dialog.querySelector(requested) : requested;
  return explicit?.isConnected ? explicit : visibleFocusables(dialog)[0] || dialog;
}

export function openDialog(options) {
  options = options || {};
  var dialog = options.dialog || options.element;
  var backdrop = options.backdrop || dialog;
  if (!dialog || !backdrop) throw new Error("openDialog requires a dialog element");

  var labelledby = options.labelledby || dialog.getAttribute("aria-labelledby");
  var label = options.label || dialog.getAttribute("aria-label");
  if (!labelledby && !label) throw new Error("openDialog requires label or labelledby");
  if (labelledby && !labelledby.split(/\s+/).every(function(id) { return document.getElementById(id); })) {
    throw new Error("openDialog labelledby must reference existing elements");
  }

  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  if (labelledby) dialog.setAttribute("aria-labelledby", labelledby);
  else dialog.setAttribute("aria-label", label);
  if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");
  backdrop.hidden = false;

  var closed = false;
  var initialTimer = null;
  function onKeydown(event) {
    if (event.key !== "Tab") return;
    var items = visibleFocusables(dialog);
    if (!items.length) {
      event.preventDefault();
      focus(dialog);
      return;
    }
    var first = items[0], last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault();
      focus(last);
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      focus(first);
    }
  }
  dialog.addEventListener("keydown", onKeydown);

  var unregister = registerLayer({
    element: dialog,
    trigger: options.trigger,
    closeOnEscape: options.closeOnEscape,
    closeOnOutsidePointer: options.closeOnBackdrop,
    restoreFocus: options.restoreFocus,
    onClose: function(reason) { close(reason === "outside-pointer" ? "backdrop" : reason); }
  });

  function close(reason, settings) {
    if (closed) return;
    closed = true;
    if (initialTimer !== null) clearTimeout(initialTimer);
    dialog.removeEventListener("keydown", onKeydown);
    backdrop.hidden = true;
    options.onClose?.(reason || "programmatic");
    unregister(settings);
  }

  function dispose(settings) {
    close("programmatic", settings);
    if (options.removeOnDispose) backdrop.remove();
  }

  initialTimer = setTimeout(function() {
    initialTimer = null;
    if (!closed) focus(resolveInitialFocus(dialog, options.initialFocus));
  }, 0);

  return { close: close, dispose: dispose };
}
