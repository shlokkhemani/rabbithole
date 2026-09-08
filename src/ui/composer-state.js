import { followupCommitFromEnter, isComposingText } from "./input-intent.js";

/** @param {{ text: HTMLTextAreaElement, hasDraft?: boolean | (() => boolean) }} elements */
export function composerHasDraft(elements) {
  return typeof elements.hasDraft === "function"
    ? elements.hasDraft()
    : typeof elements.hasDraft === "boolean"
      ? elements.hasDraft
      : !!elements.text.value.trim();
}

/**
 * @param {{ text: HTMLTextAreaElement, commits: Iterable<HTMLButtonElement>, lenses?: Iterable<HTMLButtonElement>, wrap: Element, hasDraft?: boolean | (() => boolean) }} elements
 * @param {{ phase: "frozen" | "closed" | "away" | "live", pending: boolean, disabled?: boolean, unavailable?: boolean }} state
 * @param {{ frozen: string, closed: string, pending: string, away: string, live: string }} copy
 */
export function applyComposerState(elements, state, copy) {
  // Must be a real boolean: an undefined tail would make classList.toggle
  // flip the class on every call instead of setting it.
  // Parent readiness is intent-specific: notes can be saved against the text
  // already on screen, while asks need the parent answer to settle first.
  const down = !!(state.phase === "frozen" || state.phase === "closed" || state.unavailable);
  const commitsDown = down || !!state.disabled;
  const hasDraft = composerHasDraft(elements);
  elements.text.disabled = down;
  elements.wrap.classList.toggle("disabled", down);
  const placeholderPhase =
    state.pending && state.phase !== "frozen" && state.phase !== "closed" ? "pending" : state.phase;
  elements.text.placeholder = copy[placeholderPhase];
  for (const commit of elements.commits) {
    const intentBlocked = commitsDown || (state.pending && commit.dataset.commit === "ask");
    commit.dataset.intentBlocked = intentBlocked ? "true" : "false";
    commit.disabled = intentBlocked || !hasDraft;
  }
  for (const lens of elements.lenses || []) lens.disabled = down || state.pending;
}

// The one interaction contract for every composer surface: commit buttons and
// each surface's configured Enter gestures act on a draft, while presets can
// submit either an implicit subject or a typed question. Number keys remain
// shortcuts only while the editor is empty. Callbacks receive the raw event; sources and submit guards stay
// with the mount, as does listener lifetime — pass the mount's scope.listen
// when the surface outlives its module (raw addEventListener otherwise).
/** @param {{ text: HTMLTextAreaElement, actions: Element,
 *   listen?: (target: EventTarget, type: string, handler: (event: any) => void) => void,
 *   hasDraft?: () => boolean,
 *   commitFromEnter?: (event: KeyboardEvent) => string | null,
 *   onCommit: (kind: string, event: Event) => void,
 *   onLens: (lens: string, event: Event) => void,
 *   onReaction?: (reaction: "up" | "down", event: Event) => void }} surface */
export function wireComposerActions(surface) {
  const listen =
    surface.listen ||
    function (target, type, handler) {
      target.addEventListener(type, handler);
    };
  const hasDraft =
    surface.hasDraft ||
    function () {
      return !!surface.text.value.trim();
    };
  const commitFromEnter = surface.commitFromEnter || followupCommitFromEnter;
  listen(surface.actions, "click", function (e) {
    const target = /** @type {Element} */ (e.target);
    const button = target.closest ? /** @type {HTMLButtonElement | null} */ (target.closest("button")) : null;
    if (!button || button.disabled) return;
    if (button.dataset.commit && hasDraft()) surface.onCommit(button.dataset.commit, e);
    else if (button.dataset.lens) surface.onLens(button.dataset.lens, e);
    else if ((button.dataset.react === "up" || button.dataset.react === "down") && surface.onReaction) {
      surface.onReaction(button.dataset.react, e);
    }
  });
  listen(surface.text, "keydown", function (e) {
    const commit = commitFromEnter(e);
    if (commit) {
      e.preventDefault();
      // note-window is a placement variant of the Note intent, not a third
      // availability class in the action bar.
      const commitButton = /** @type {HTMLButtonElement | null} */ (
        surface.actions.querySelector('[data-commit="' + (commit === "ask" ? "ask" : "note") + '"]')
      );
      const available =
        commitButton &&
        (commitButton.hasAttribute("data-intent-blocked")
          ? commitButton.dataset.intentBlocked !== "true"
          : !commitButton.disabled);
      if (available && (commit === "ask" || hasDraft())) surface.onCommit(commit, e);
      return;
    }
    // Digits address the row positionally — "2" is whatever pill sits second —
    // so hints stay truthful when the user has removed presets. A digit past
    // the row's end is ordinary typing, not a dead shortcut.
    if (
      !isComposingText(e) &&
      surface.text.value === "" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      /^[1-3]$/.test(e.key)
    ) {
      const lens = /** @type {HTMLButtonElement | undefined} */ (
        surface.actions.querySelectorAll(".lens[data-lens]")[Number(e.key) - 1]
      );
      if (!lens) return;
      e.preventDefault();
      if (!lens.disabled) surface.onLens(lens.dataset.lens || "", e);
      return;
    }
    if (
      surface.onReaction &&
      !isComposingText(e) &&
      surface.text.value === "" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      (e.key === "ArrowUp" || e.key === "ArrowDown")
    ) {
      const reaction = e.key === "ArrowUp" ? "up" : "down";
      const thumb = /** @type {HTMLButtonElement | null} */ (
        surface.actions.querySelector('.thumb[data-react="' + reaction + '"]')
      );
      if (!thumb) return;
      e.preventDefault();
      if (!thumb.disabled) surface.onReaction(reaction, e);
    }
  });
}
