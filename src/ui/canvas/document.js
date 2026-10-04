import { composerActionsMarkup } from "../../core/html/markup.js";
import { displayQuestionForOrigin } from "../ask-presets.js";
import { applyComposerState } from "../composer-state.js";
import { buildDocContent, CANVAS_BASE, nodes, READER_BASE, rootId, sessionPhase } from "../core.js";
import { isCommandEnter } from "../input-intent.js";
import { appendOriginAttachmentThumbnails, originAttachmentNames } from "../origin-attachments.js";
import { buildOriginCrop } from "../origin-provenance.js";
import { applyChildHighlights } from "../text-marks.js";
import { autoGrowEl, cardButton } from "./card-composer.js";
import { r } from "./runtime.js";

export function fillBody(node) {
  const body = node.bodyEl;
  if (!body) return;
  if (node._noteEditor) return;
  const previous = body.querySelector(".doc-content");
  if (previous && previous._rhDispose) previous._rhDispose();
  body.classList.remove("pdf-body");
  body.innerHTML = "";
  const originQuestion = displayQuestionForOrigin(node.origin);
  if (node.origin && node.origin.kind !== "note" && (originQuestion || originAttachmentNames(node).length)) {
    const q = document.createElement("div");
    q.className = "origin-quote";
    q.textContent = originQuestion ? "“" + originQuestion + "”" : "Pasted image";
    appendOriginAttachmentThumbnails(q, node);
    body.appendChild(q);
  }
  const crop = buildOriginCrop(node, "card");
  if (crop) body.appendChild(crop);
  const dc = buildDocContent(node, CANVAS_BASE);
  body.appendChild(dc);
  body.classList.toggle("pdf-body", dc.classList.contains("rh-pdf"));
  applyChildHighlights(dc, node, false);
  r.lifecycle.hooks.watchDocumentLayout(dc);
  // The marks exist now, so the margin column that points at them can be built.
  r.lifecycle.hooks.renderDockedNotes(node);
}

export function noteSurface(node, surface) {
  const dc = buildDocContent(node, surface === "reader" ? READER_BASE : CANVAS_BASE);
  applyChildHighlights(dc, node);
  return dc;
}

export function replaceNoteSurface(node, surface, current) {
  const dc = noteSurface(node, surface);
  current.replaceWith(dc);
  return dc;
}

export function cssPixels(style, property) {
  return parseFloat(style[property]) || 0;
}

// One bar for every note surface — the composer's own Note/Ask pair, built
// and keyed the same way whether the note is being written for the first time
// or edited afterwards. Note commits the text, Ask branches it, ⌘↵ asks.
export function noteComposerActions() {
  return cardButton(composerActionsMarkup({ includeLenses: false }));
}

export function noteCommitFromEnter(e) {
  if (e.altKey || !isCommandEnter(e) || e.shiftKey) return null;
  return e.metaKey || e.ctrlKey ? "ask" : "note";
}

// Whatever the editor sits under inside the card body — an origin quote, an
// origin crop — belongs to the body, not to the surface, so its height comes
// off the ceiling before the textarea takes its share.
export function leadingBodyHeight(surface) {
  let total = 0;
  for (let el = surface.previousElementSibling; el; el = el.previousElementSibling) {
    const style = getComputedStyle(el);
    total += el.offsetHeight + cssPixels(style, "marginTop") + cssPixels(style, "marginBottom");
  }
  return total;
}

// The textarea and card share one ceiling. Derive the text allowance from
// the card's saved cap and the live composer chrome so neither can stop
// growing while the other still has unused room. Both flush-footer note
// surfaces — the fresh composer and the editor over an existing note — are
// the same box, so they measure themselves the same way.
export function noteEditorCap(node, input, actions, attachmentStrip) {
  const cardStyle = getComputedStyle(node.el);
  const inputStyle = getComputedStyle(input);
  const surfaceStyle = getComputedStyle(input.parentNode);
  return Math.max(
    1,
    node.size.h -
      node.el.querySelector(".card-head").offsetHeight -
      actions.offsetHeight -
      (attachmentStrip ? attachmentStrip.offsetHeight : 0) -
      leadingBodyHeight(input.parentNode) -
      cssPixels(cardStyle, "borderTopWidth") -
      cssPixels(cardStyle, "borderBottomWidth") -
      cssPixels(inputStyle, "paddingTop") -
      cssPixels(inputStyle, "paddingBottom") -
      cssPixels(surfaceStyle, "borderTopWidth") -
      cssPixels(surfaceStyle, "borderBottomWidth") -
      cssPixels(surfaceStyle, "paddingTop") -
      cssPixels(surfaceStyle, "paddingBottom"),
  );
}

export function growStandaloneNoteComposer(node) {
  if (!node._noteEditor || !node._noteComposer) return;
  autoGrowEl(node._noteEditor, noteEditorCap(node, node._noteInput, node._noteActions, node._noteAttachmentStrip));
}

export function updateStandaloneNoteComposer(node) {
  if (!node._noteEditor || !node._noteComposer) return;
  const parent = nodes[rootId];
  const hasDraft = !!node._noteEditor.value.trim() || !!node._noteAttachments?.length || !!node._notePastePending;
  node._noteComposer.classList.toggle("has-draft", hasDraft);
  applyComposerState(
    {
      text: node._noteEditor,
      commits: node._noteActions.querySelectorAll(".ask-commit"),
      wrap: node._noteComposer,
      hasDraft: hasDraft,
    },
    {
      phase: sessionPhase(),
      pending: !!parent && parent.status === "pending",
      unavailable: !parent || !!parent.source?.converting,
      disabled: !!node._noteUploading || !!node._noteNormalizing,
    },
    r.STANDALONE_COMPOSER_COPY,
  );
}
