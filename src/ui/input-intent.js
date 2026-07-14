export function isComposingText(event) {
  return !!event?.isComposing || event?.keyCode === 229;
}

export function isCommandEnter(event) {
  return event?.key === "Enter" && !isComposingText(event);
}

export function isSubmitEnter(event) {
  return isCommandEnter(event) && !event.shiftKey;
}

export const ENTER_SEND_HINT = "Send (Enter) · New line (Shift+Enter)";
