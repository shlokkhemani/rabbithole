const WIRED = new WeakMap();
const VARIANTS = new Set(["banner", "hint", "toast"]);
const TIMED = new Set(["hint", "toast"]);

/**
 * Wires an existing notice shell without replacing it or its children.
 * Timed notices pause while hovered or while keyboard focus remains inside.
 */
export function wireNotice(element, { variant } = {}) {
  if (!element) throw new Error("Notice requires an element");
  if (!VARIANTS.has(variant)) throw new Error("Unknown Notice variant: " + variant);
  const existing = WIRED.get(element);
  if (existing) {
    if (existing.variant !== variant) throw new Error("Notice shell is already wired as " + existing.variant);
    return existing.handle;
  }

  const messageEl = element.querySelector("[data-notice-message]") || element;
  const titleEl = element.querySelector("[data-notice-title]");
  const actionEl = element.querySelector("[data-notice-action]");
  const dismissEl = element.querySelector("[data-notice-dismiss]");
  let timer = 0;
  let deadline = 0;
  let remaining = 0;
  let action = null;
  let dismiss = null;
  let run = 0;
  let hovered = false;
  let focused = false;

  if (variant === "hint" || variant === "toast") {
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    element.setAttribute("aria-atomic", "true");
  } else if (!element.hasAttribute("aria-live") && !element.hasAttribute("role")) {
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    element.setAttribute("aria-atomic", "true");
  }

  function visibleClass(on) {
    element.classList.toggle(variant === "hint" ? "flash" : "visible", on);
  }
  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = 0;
  }
  function hide() {
    run += 1;
    clearTimer();
    remaining = 0;
    action = null;
    dismiss = null;
    visibleClass(false);
  }
  function startTimer(token) {
    clearTimer();
    if (!TIMED.has(variant) || remaining <= 0) return;
    deadline = Date.now() + remaining;
    timer = setTimeout(function() {
      timer = 0;
      if (token === run) hide();
    }, remaining);
  }
  function pauseTimer() {
    if (!timer) return;
    remaining = Math.max(0, deadline - Date.now());
    clearTimer();
  }
  function resumeTimer() {
    if (!isVisible() || timer || hovered || focused || !TIMED.has(variant)) return;
    startTimer(run);
  }
  function isVisible() {
    return element.classList.contains(variant === "hint" ? "flash" : "visible");
  }
  function show({ title = "", message = "", actionLabel = "", onAction = null, onDismiss = null, duration } = {}) {
    run += 1;
    clearTimer();
    titleEl && (titleEl.textContent = String(title));
    messageEl.textContent = String(message);
    action = typeof onAction === "function" ? onAction : null;
    dismiss = typeof onDismiss === "function" ? onDismiss : null;
    if (actionEl) {
      actionEl.textContent = String(actionLabel || "");
      actionEl.hidden = !actionLabel;
    }
    visibleClass(true);
    remaining = TIMED.has(variant) ? Math.max(0, Number(duration ?? 4000)) : 0;
    if (!hovered && !focused) startTimer(run);
  }

  element.addEventListener("mouseenter", function() { hovered = true; pauseTimer(); });
  element.addEventListener("mouseleave", function() {
    hovered = false;
    resumeTimer();
  });
  element.addEventListener("focusin", function() { focused = true; pauseTimer(); });
  element.addEventListener("focusout", function(event) {
    focused = element.contains(event.relatedTarget);
    resumeTimer();
  });
  actionEl?.addEventListener("click", async function() {
    const callback = action;
    const token = run;
    clearTimer();
    if (callback) await callback();
    if (token === run) hide();
  });
  dismissEl?.addEventListener("click", function() {
    const callback = dismiss;
    hide();
    callback?.();
  });

  const handle = { show, hide, isVisible };
  WIRED.set(element, { variant, handle });
  return handle;
}
