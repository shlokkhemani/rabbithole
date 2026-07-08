var FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function activateFocusTrap(root, options) {
  if (!root) return function(){};
  options = options || {};
  var previous = document.activeElement;
  if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");

  function focusables() {
    var all = root.querySelectorAll ? Array.prototype.slice.call(root.querySelectorAll(FOCUSABLE)) : [];
    return all.filter(function(el){
      return el.offsetParent !== null || el === document.activeElement || el === options.initialFocus;
    });
  }

  function focusInitial() {
    var target = options.initialFocus || focusables()[0] || root;
    try { target.focus({ preventScroll: true }); } catch(e) { try { target.focus(); } catch(_e){} }
  }

  function onKeydown(e) {
    if (e.key === "Escape" && typeof options.onEscape === "function") {
      e.preventDefault();
      e.stopPropagation();
      options.onEscape(e);
      return;
    }
    if (e.key !== "Tab") return;
    var items = focusables();
    if (!items.length) {
      e.preventDefault();
      root.focus();
      return;
    }
    var first = items[0];
    var last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  document.addEventListener("keydown", onKeydown, true);
  setTimeout(focusInitial, 0);

  return function deactivateFocusTrap() {
    document.removeEventListener("keydown", onKeydown, true);
    if (options.restoreFocus !== false && previous && previous.focus) {
      try { previous.focus({ preventScroll: true }); } catch(e) { try { previous.focus(); } catch(_e){} }
    }
  };
}
