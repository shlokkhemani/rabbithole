import { composerActionsMarkup } from "../../core/html/markup.js";
import { presetFor, renderAskPresetActions } from "../ask-presets.js";
import { applyComposerState, wireComposerActions } from "../composer-state.js";
import { closed, flashHint, motionSourceFromEvent, sessionPhase, view, viewport } from "../core.js";
import { updateStandaloneNoteComposer } from "./document.js";
import { effH } from "./edges.js";
import { canConvertNote } from "./menu.js";
import { r } from "./runtime.js";

// A card's on-screen rect under a given camera pose (defaults to the live one).
export function cardScreenRect(node, v) {
  v = v || view;
  return {
    left: node.position.x * v.scale + v.x,
    top: node.position.y * v.scale + v.y,
    width: node.size.w * v.scale,
    height: effH(node) * v.scale,
  };
}

export function rectMostlyVisible(rect) {
  const vw = viewport.clientWidth,
    vh = viewport.clientHeight;
  const w = Math.min(rect.left + rect.width, vw) - Math.max(rect.left, 0);
  const h = Math.min(rect.top + rect.height, vh) - Math.max(rect.top, 0);
  if (w <= 0 || h <= 0) return false;
  return (w * h) / (rect.width * rect.height) >= 0.3;
}

export function cardButton(markup) {
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template.content.firstElementChild;
}

// ---------- per-card follow-up composer ----------
// The scrollbar only appears once the textarea is actually at its cap —
// otherwise sub-pixel rounding paints a stray thumb next to the commit row.
export function autoGrowEl(ta, max) {
  ta.style.height = "auto";
  ta.style.height = Math.min(max, ta.scrollHeight) + "px";
  ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
}

export function buildCardComposer(node) {
  const comp = document.createElement("div");
  comp.className = "card-composer";
  const clip = document.createElement("div");
  clip.className = "nc-clip";
  clip.id = cardDrawerId(node);
  const inner = document.createElement("div");
  inner.className = "nc-inner followup-composer";
  const input = document.createElement("div");
  input.className = "ask-input";
  const ta = document.createElement("textarea");
  ta.rows = 1;
  const actions = cardButton(composerActionsMarkup());
  renderAskPresetActions(actions, "followup");
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "nc-handle";
  handle.title = "Ask or note about this document";
  handle.setAttribute("aria-expanded", "false");
  handle.setAttribute("aria-controls", clip.id);
  const plus = document.createElement("span");
  plus.className = "nc-plus";
  plus.textContent = "+";
  handle.appendChild(plus);
  handle.appendChild(document.createTextNode(" Ask or note"));
  input.appendChild(ta);
  inner.appendChild(input);
  inner.appendChild(actions);
  clip.appendChild(inner);
  comp.appendChild(clip);
  comp.appendChild(handle);
  node.ncComp = comp;
  node.ncInner = inner;
  node.ncText = ta;
  node.ncActions = actions;
  node.ncHandle = handle;
  handle.addEventListener("click", function (e) {
    e.stopPropagation();
    openCardDrawer(node);
  });
  ta.addEventListener("input", function () {
    autoGrowEl(ta, 90);
    updateCardComposer(node);
  });
  ta.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeCardDrawer(node);
      handle.focus({ preventScroll: true });
    }
  });
  wireComposerActions({
    text: ta,
    actions: actions,
    onCommit: function (kind, e) {
      e.stopPropagation();
      submitCardFollowup(node, kind, cardComposerSource(e));
    },
    onLens: function (lens, e) {
      e.stopPropagation();
      submitCardLens(node, lens, cardComposerSource(e));
    },
  });
  // Click-away with an empty drawer tucks it back in (a draft keeps it out).
  ta.addEventListener("blur", function () {
    if (!ta.value.trim() && !(node.el && node.el.matches(":hover"))) closeCardDrawer(node);
  });
  return comp;
}

export function cardComposerSource(e) {
  return e && e.type === "keydown" ? "keyboard" : motionSourceFromEvent(e);
}

export function cardDrawerId(node) {
  return (
    "card-followup-" +
    String(node.id).replace(/[^A-Za-z0-9_-]/g, function (ch) {
      return "-" + ch.charCodeAt(0).toString(16) + "-";
    })
  );
}

// preventScroll matters: a plain focus() would yank the overflow-hidden
// viewport around to reveal the textarea, fighting the canvas transform.
export function openCardDrawer(node) {
  // This is a card-embedded disclosure, not a floating surface: its
  // hover/draft lifecycle owns dismissal, so it does not join the layer stack.
  node.ncComp.classList.add("open");
  node.ncHandle.setAttribute("aria-expanded", "true");
  node.ncText.focus({ preventScroll: true });
}

export function closeCardDrawer(node) {
  node.ncComp.classList.remove("open");
  node.ncHandle.setAttribute("aria-expanded", "false");
}

// Same intent split as every other composer: a pending doc can take notes,
// while asks wait for the answer to settle.
export function updateCardComposer(node) {
  if (node._noteComposer) {
    updateStandaloneNoteComposer(node);
    return;
  }
  if (node._noteEditor && !canConvertNote(node)) {
    const convert = node._noteEditSurface && node._noteEditSurface.querySelector('[data-commit="ask"]');
    if (convert) {
      convert.remove();
      node._noteEditSurface.querySelector(".ask-actions")?.classList.add("note-only");
    }
  }
  if (!node.ncText) return;
  // A draft in progress keeps the drawer out even when the pointer wanders off.
  const hasDraft = !!node.ncText.value.trim();
  node.ncComp.classList.toggle("nc-draft", hasDraft);
  node.ncInner.classList.toggle("has-draft", hasDraft);
  applyComposerState(
    {
      text: node.ncText,
      commits: node.ncActions.querySelectorAll(".ask-commit"),
      lenses: node.ncActions.querySelectorAll(".lens"),
      wrap: node.ncInner,
    },
    { phase: sessionPhase(), pending: node.status === "pending", unavailable: !!node.source?.converting },
    r.CARD_COMPOSER_COPY,
  );
}

// The card composer's submit gate (a closed session says so out loud), and
// the shared landing: retract the drawer and refresh the composer.
export function cardComposerBlocked(node, needsSettled) {
  if (closed) {
    flashHint("Session ended — reopen this Rabbithole from your terminal to continue.");
    return true;
  }
  return !node || !!node.source?.converting || (needsSettled && node.status === "pending");
}

export function settleCardSubmit(node) {
  closeCardDrawer(node);
  updateCardComposer(node);
}

export function submitCardLens(node, lens, source) {
  if (cardComposerBlocked(node, true)) return;
  const preset = presetFor("followup", lens);
  if (!preset) return;
  const kid = r.lifecycle.hooks.sendFollowup(node, node.ncText.value.trim(), lens, preset.instruction);
  if (!kid) return;
  node.ncText.value = "";
  autoGrowEl(node.ncText, 90);
  settleCardSubmit(node);
}

export function submitCardFollowup(node, commit, source) {
  if (cardComposerBlocked(node, commit === "ask")) return;
  const question = node.ncText.value.trim();
  if (!question) return;
  const kid =
    commit === "ask"
      ? r.lifecycle.hooks.sendFollowup(node, question, null)
      : r.lifecycle.hooks.sendPlacedNote(node, question);
  if (!kid) return;
  node.ncText.value = "";
  autoGrowEl(node.ncText, 90);
  settleCardSubmit(node);
}
