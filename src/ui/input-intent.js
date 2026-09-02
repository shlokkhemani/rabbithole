export function isComposingText(event) {
  return !!event?.isComposing || event?.keyCode === 229;
}

const BUTTON_INPUT_TYPES = new Set(["button", "image", "reset", "submit"]);

/** @param {{ target?: unknown, composedPath?: () => unknown[] } | null | undefined} event */
export function isTypingTarget(event) {
  const path = typeof event?.composedPath === "function" ? event.composedPath() : [];
  const target = /** @type {HTMLElement | null} */ (path[0] || event?.target);
  if (!target) return false;
  if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  if (target.tagName === "INPUT") {
    const type = /** @type {HTMLInputElement} */ (target).type;
    return !BUTTON_INPUT_TYPES.has(String(type || "").toLowerCase());
  }
  return target.isContentEditable === true;
}

export function isCommandEnter(event) {
  return event?.key === "Enter" && !isComposingText(event);
}

export function isSubmitEnter(event) {
  return isCommandEnter(event) && !event.shiftKey;
}

export function followupCommitFromEnter(event) {
  if (!isCommandEnter(event) || event.altKey) return null;
  if ((event.metaKey || event.ctrlKey) && event.shiftKey) return "note-window";
  if (event.shiftKey) return null;
  return event.metaKey || event.ctrlKey ? "ask" : "note";
}
