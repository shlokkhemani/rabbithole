/**
 * @param {{ text: HTMLTextAreaElement, send: HTMLButtonElement, wrap: Element }} elements
 * @param {{ phase: "frozen" | "closed" | "away" | "live", pending: boolean }} state
 * @param {{ frozen: string, closed: string, pending: string, away: string, live: string }} copy
 */
export function applyComposerState(elements, state, copy) {
  var down = state.phase === "frozen" || state.phase === "closed" || state.pending;
  elements.text.disabled = down;
  elements.wrap.classList.toggle("disabled", down);
  var placeholderPhase = state.pending && state.phase !== "frozen" && state.phase !== "closed"
    ? "pending" : state.phase;
  elements.text.placeholder = copy[placeholderPhase];
  elements.send.disabled = down || !elements.text.value.trim();
}
