import { systemClock } from "../core/clock.js";
import { BRANCH_FOLLOWUP, BRANCH_SELECTION } from "../core/hole/ask.js";
import { truncate } from "../core/hole/lens.js";
import { makeNode } from "../core/hole/node.js";
import {
  DEFAULT_CHILD,
  nodeOrder,
  placeChild as sharedPlaceChild,
  subtreeBounds as sharedSubtreeBounds,
} from "../core/layout.js";
import { presetFor, refreshAskPresetActions, renderAskPresetActions } from "./ask-presets.js";
import {
  autoGrowEl,
  createNodeEl,
  drawEdges,
  effH,
  renderVisibility,
  revealNode,
  scheduleEdges,
} from "./canvas/index.js";
import { applyComposerState, wireComposerActions } from "./composer-state.js";
import {
  ask,
  askText,
  canvasBuilt,
  closed,
  composerActions,
  composerInner,
  composerText,
  currentNodeId,
  flashHint,
  frozen,
  mode,
  motionSourceFromEvent,
  nextOrder,
  nodes,
  postBrowserEvent,
  readerMain,
  registerNode,
  sessionPhase,
  shouldReduceMotion,
  uuid,
} from "./core.js";
import { createDockedNote, createPlacedNote, placedChildrenOf } from "./docked-notes.js";
import { closestEl } from "./dom.js";
import { easeOutMotion } from "./easing.js";
import { cancelFrame, createModuleLifecycle, nextFrame } from "./kit/scope.js";
import { closeLightbox } from "./lightbox.js";
import { teardownNode } from "./node-teardown.js";
import { openAnchoredSurface } from "./overlay/anchor.js";
import { onPreferenceChange, reactionPrompt } from "./preferences.js";
import { renderMarginNotes } from "./reader.js";
import { charOffset, mountPdfRectMark, wrapInContainer } from "./text-marks.js";
import { refreshVisualMarks } from "./visuals.js";

const askLifecycle = createModuleLifecycle({
  defaults: function () {
    return {};
  },
});

// ===========================================================================
// ASK (shared by both views)
// ===========================================================================
export function initAskFollowups() {
  disposeAskFollowupResources(false);
  const askScope = askLifecycle.beginInit();
  // wireComposerActions takes a bare function — keep scope ownership explicit.
  function scopeListen(target, type, handler) {
    askScope.listen(target, type, handler);
  }
  function composerSource(e) {
    return e && e.type === "keydown" ? "keyboard" : motionSourceFromEvent(e);
  }
  renderAskPresetActions(document.getElementById("ask-actions"), "selection");
  renderAskPresetActions(composerActions, "followup");
  askScope.addCleanup(
    onPreferenceChange(function (kind) {
      if (kind === "ask-presets") refreshAskPresetActions();
    }),
  );
  askScope.listen(document, "mouseup", function (e) {
    if (inAsk(e)) return;
    if (usesMobileAskSurface()) queueMobileAsk(80);
    else askScope.timeout(maybeShowAsk, 0);
  });
  askScope.listen(document, "selectionchange", function () {
    if (usesMobileAskSurface()) queueMobileAsk(140);
  });
  askScope.listen(
    document,
    "touchend",
    function (e) {
      if (!inAsk(e) && usesMobileAskSurface()) queueMobileAsk(80);
    },
    { passive: true },
  );
  wireComposerActions({
    text: askText,
    actions: document.getElementById("ask-actions"),
    listen: scopeListen,
    onCommit: function (kind, e) {
      if (kind === "ask") submitAsk(null, composerSource(e));
      else submitNote(composerSource(e), kind === "note-window");
    },
    onLens: function (lens, e) {
      submitAsk(lens, composerSource(e));
    },
    onReaction: function (reaction) {
      submitReaction(reaction);
    },
  });
  askScope.listen(askText, "input", function () {
    autoGrowEl(askText, 110);
    updateSelectionDraftSurface();
  });
  askScope.listen(ask, "transitionend", function (e) {
    if (e.target === ask && askPosition) askPosition.update();
  });
  askScope.listen(composerText, "input", function () {
    autoGrowComposer();
    updateComposerState();
  });
  wireComposerActions({
    text: composerText,
    actions: composerActions,
    listen: scopeListen,
    onCommit: function (kind, e) {
      submitReaderFollowup(kind, composerSource(e));
    },
    onLens: function (lens, e) {
      submitReaderLens(lens, composerSource(e));
    },
  });
  askScope.listen(readerMain, "wheel", interruptScrollAnimation, { passive: true });
  askScope.listen(readerMain, "touchstart", interruptScrollAnimation, { passive: true });
  askScope.listen(readerMain, "pointerdown", interruptScrollAnimation, { passive: true });
  askScope.listen(
    readerMain,
    "scroll",
    function () {
      if (performance.now() > scrollAnimIgnoreUntil) cancelScrollAnimation();
    },
    { passive: true },
  );
  askScope.listen(document, "keydown", interruptScrollAnimation);
  return disposeAskFollowups;
}

function inAsk(e) {
  return e.target && e.target.closest && e.target.closest("#ask");
}

let askPosition = null,
  askTabOwner = null,
  askOwnerCleanup = null;
let mobileSelectionTimer = 0,
  ignoreMobileSelectionUntil = 0;

function usesMobileAskSurface() {
  return !!(
    window.matchMedia &&
    (window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(max-width: 760px)").matches)
  );
}
function queueMobileAsk(delay) {
  if (systemClock.now() < ignoreMobileSelectionUntil || !askLifecycle.scope) return;
  if (mobileSelectionTimer) clearTimeout(mobileSelectionTimer);
  mobileSelectionTimer = askLifecycle.scope.timeout(function () {
    mobileSelectionTimer = 0;
    maybeShowAsk();
  }, delay);
}

function selectionOwner(dc) {
  const card = dc && dc.closest && dc.closest(".card");
  if (card) return card;
  // A .doc-content outside a card or reader (docked-note popover, pinned-origin
  // proxy) is not an askable surface.
  return dc && readerMain && readerMain.contains(dc) ? readerMain : null;
}
function onAskOwnerKeydown(e) {
  if (e.key !== "Tab" || e.shiftKey || !ask.classList.contains("visible")) return;
  const active = document.activeElement;
  if (active !== document.body && active !== askTabOwner && !askTabOwner.contains(active)) return;
  e.preventDefault();
  askText.focus();
}
function focusAskOwner(owner) {
  if (!owner || !owner.isConnected) return;
  if (!owner.hasAttribute("tabindex")) owner.setAttribute("tabindex", "-1");
  try {
    owner.focus({ preventScroll: true });
  } catch (e) {
    owner.focus();
  }
}

function maybeShowAsk() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
  const anchor = sel.anchorNode && sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentNode : sel.anchorNode;
  const dc = closestEl(anchor, ".doc-content");
  if (!dc) return;
  if (dc.classList.contains("rh-pdf")) return;
  const parentId = dc.dataset.nodeId;
  if (!parentId || !nodes[parentId]) return;
  const owner = selectionOwner(dc);
  if (!owner) return;
  // The surface stays open while the agent is merely away — only a fully
  // closed session cannot accept a durable note or queued ask.
  if (closed) {
    flashHint(
      frozen
        ? "This is a read-only snapshot — asking needs the live Rabbithole."
        : "Session ended — reopen this Rabbithole from your terminal to keep asking.",
    );
    return;
  }
  const range = rangeInsideDocument(sel.getRangeAt(0), dc, sel.toString());
  if (!range) return;
  const startOff = charOffset(dc, range.startContainer, range.startOffset);
  const endOff = charOffset(dc, range.endContainer, range.endOffset);
  if (endOff <= startOff) return;
  if (ask.classList.contains("visible")) hideAsk();
  selectionDraft = {
    parentId: parentId,
    container: dc,
    selectedText: sel.toString().trim(),
    startOff: startOff,
    endOff: endOff,
    range: range.cloneRange(),
  };
  askText.value = "";
  updateSelectionDraftSurface();
  paintSelectionHighlight(selectionDraft.range);
  ask.classList.add("visible");
  updateSelectionComposerState();
  const virtualAnchor = {
    getBoundingClientRect: function () {
      return selectionDraft.range.getBoundingClientRect();
    },
    contextElement: dc,
  };
  askTabOwner = owner;
  askOwnerCleanup = askLifecycle.scope
    ? askLifecycle.scope.listen(document, "keydown", onAskOwnerKeydown)
    : function () {
        document.removeEventListener("keydown", onAskOwnerKeydown);
      };
  // The box takes focus on open so the question can be typed immediately —
  // focusing collapses the native selection, so the cloned Range plus the
  // painted highlight carry it, and Escape puts the selection back.
  openAskSurface(virtualAnchor, owner);
}

function rangeInsideDocument(range, dc, selectedText) {
  if (dc.contains(range.startContainer) && dc.contains(range.endContainer)) return range;
  // A browser paragraph-selection gesture includes the following block
  // boundary. For a card's final paragraph that boundary is the card composer,
  // just outside .doc-content. Clip such structural promotion back to the
  // document, but still reject a real selection dragged into another surface.
  if (!range.intersectsNode(dc)) return null;
  const clipped = range.cloneRange();
  try {
    if (!dc.contains(clipped.startContainer)) clipped.setStart(dc, 0);
    if (!dc.contains(clipped.endContainer)) clipped.setEnd(dc, dc.childNodes.length);
  } catch (e) {
    return null;
  }
  return clipped.toString().trim() === selectedText.trim() ? clipped : null;
}
let selectionDraft = null;
function composedClosest(node, selector) {
  let current = node && node.nodeType === 1 ? node : node?.parentElement;
  while (current) {
    if (current.matches?.(selector)) return current;
    current = current.parentElement || current.getRootNode?.().host || null;
  }
  return null;
}
export function showAskFromSelection(options) {
  const parentId = options && options.parentId;
  const parent = parentId && nodes[parentId];
  if (!parent || parent.source?.converting) return false;
  if (closed) {
    flashHint(
      frozen
        ? "This is a read-only snapshot — asking needs the live Rabbithole."
        : "Session ended — reopen this Rabbithole from your terminal to keep asking.",
    );
    return false;
  }
  const anchorEl = options.anchorRectEl;
  // Virtual anchors (a selection range) carry their element as contextElement.
  const anchorNode =
    anchorEl && anchorEl.closest ? anchorEl : anchorEl && anchorEl.contextElement ? anchorEl.contextElement : null;
  const overLightbox = !!composedClosest(anchorNode, ".rh-lightbox");
  selectionDraft = {
    parentId: parentId,
    container: anchorNode && anchorNode.closest ? anchorNode.closest(".doc-content") : null,
    selectedText: String(options.selectedText || "").trim(),
    startOff: options.mdStart,
    endOff: options.mdEnd,
    pdfAnchor: options.pdfAnchor || null,
    blockAnchor: options.blockAnchor || null,
    overLightbox,
    range: options.range || null,
  };
  ask.classList.toggle("over-lightbox", overLightbox);
  askText.value = "";
  updateSelectionDraftSurface();
  if (selectionDraft.range) paintSelectionHighlight(selectionDraft.range);
  ask.classList.add("visible");
  updateSelectionComposerState();
  const owner = selectionOwner(selectionDraft.container) || readerMain;
  askTabOwner = owner;
  askOwnerCleanup = askLifecycle.scope
    ? askLifecycle.scope.listen(document, "keydown", onAskOwnerKeydown)
    : function () {
        document.removeEventListener("keydown", onAskOwnerKeydown);
      };
  openAskSurface(anchorEl, owner);
  return true;
}
function openAskSurface(anchor, owner) {
  const mobile = usesMobileAskSurface();
  ask.classList.toggle("mobile-sheet", mobile);
  const surfaceAnchor = mobile ? mobileViewportAnchor(owner) : anchor;
  askPosition = openAnchoredSurface({
    surface: ask,
    anchor: surfaceAnchor,
    placement: mobile ? "top-center" : "bottom-start",
    // The mobile sheet is anchored to the visual viewport, not to the selected
    // text — the viewport can't scroll away from itself.
    trackAnchorVisibility: !mobile,
    restoreFocus: false,
    preventOutsidePointerDefault: function (event) {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      return !!composedClosest(path[0] || event.target, ".viz-mounted, .rh-lightbox");
    },
    ignoreOutsidePointer: function (event) {
      return !!closestEl(event.target, ".rh-pdf-zoom-control");
    },
    onClose: function (reason) {
      const escapeOwner = reason === "escape" ? owner : null;
      const keepRange = reason === "escape" && selectionDraft ? selectionDraft.range : null;
      hideAsk();
      if (escapeOwner) focusAskOwner(escapeOwner);
      restoreSelectionRange(keepRange);
    },
  });
  autoGrowEl(askText, 110); // Must run after the surface leaves display:none.
  if (!mobile) askText.focus({ preventScroll: true });
}
function mobileViewportAnchor(owner) {
  return {
    contextElement: owner,
    getBoundingClientRect: function () {
      const viewport = window.visualViewport;
      const left = viewport ? viewport.offsetLeft : 0;
      const top = viewport ? viewport.offsetTop : 0;
      const width = viewport ? viewport.width : window.innerWidth;
      const height = viewport ? viewport.height : window.innerHeight;
      const bottom = top + height;
      return {
        left: left,
        right: left + width,
        top: bottom,
        bottom: bottom,
        width: width,
        height: 0,
        x: left,
        y: bottom,
      };
    },
  };
}
function restoreSelectionRange(range) {
  if (!range) return;
  ignoreMobileSelectionUntil = systemClock.now() + 300;
  try {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) {}
}
export function hideAsk() {
  if (askPosition) {
    askPosition.dispose();
    askPosition = null;
  }
  if (askOwnerCleanup) {
    const cleanup = askOwnerCleanup;
    askOwnerCleanup = null;
    cleanup();
  }
  askTabOwner = null;
  ask.classList.remove("visible", "has-draft", "over-lightbox");
  selectionDraft = null;
  clearSelectionHighlight();
}

export function disposeAskFollowups() {
  disposeAskFollowupResources(true);
}

function disposeAskFollowupResources(resetHooks) {
  hideAsk();
  cancelScrollAnimation();
  askLifecycle.dispose(resetHooks);
  selectionDraft = null;
  askTabOwner = null;
  askOwnerCleanup = null;
  if (mobileSelectionTimer) clearTimeout(mobileSelectionTimer);
  mobileSelectionTimer = 0;
  ignoreMobileSelectionUntil = 0;
  scrollAnimId = 0;
  scrollAnimIgnoreUntil = 0;
  askText.value = "";
  composerText.value = "";
}
// Custom Highlight API — keeps the selected text visibly marked while the popup
// has focus. One steady wash for the popup's whole lifetime: the commit
// buttons say what Enter does, so the selection never changes color under
// the typist. Best-effort: browsers without it fall back to today's look.
function paintSelectionHighlight(range) {
  try {
    if (window.Highlight && window.CSS && CSS.highlights) CSS.highlights.set("rh-ask", new Highlight(range));
  } catch (e) {}
}
function clearSelectionHighlight() {
  try {
    if (window.CSS && CSS.highlights) CSS.highlights.delete("rh-ask");
  } catch (e) {}
}
function updateSelectionDraftSurface() {
  ask.classList.toggle("has-draft", !!askText.value.trim());
  updateSelectionComposerState();
}

export function updateSelectionComposerState() {
  if (!ask || !ask.classList.contains("visible") || !selectionDraft) return;
  const parent = nodes[selectionDraft.parentId];
  const parentPending = !!parent && parent.status === "pending";
  const actions = document.getElementById("ask-actions");
  applyComposerState(
    {
      text: askText,
      commits: actions.querySelectorAll(".ask-commit"),
      lenses: actions.querySelectorAll(".lens"),
      wrap: ask,
    },
    { phase: sessionPhase(), pending: parentPending, unavailable: !parent || !!parent.source?.converting },
    {
      frozen: "Read-only snapshot",
      closed: "Session ended",
      pending: "This answer is still being written…",
      away: "Ask or note…",
      live: "Ask or note…",
    },
  );
  const noteCommit = /** @type {HTMLButtonElement | null} */ (actions.querySelector('[data-commit="note"]'));
  if (noteCommit) noteCommit.title = "Save note (Enter)";
  if (selectionDraft.blockAnchor) {
    if (noteCommit) {
      noteCommit.disabled = true;
      noteCommit.dataset.intentBlocked = "true";
      noteCommit.title = "Visual selections can be asked about";
    }
  }
  const noteBlocked = !noteCommit || noteCommit.dataset.intentBlocked === "true";
  /** @type {NodeListOf<HTMLButtonElement>} */ (actions.querySelectorAll(".thumb")).forEach(function (thumb) {
    thumb.disabled = noteBlocked;
    thumb.dataset.intentBlocked = noteBlocked ? "true" : "false";
  });
}

function retirePdfConversionAction(parent) {
  parent?.bodyEl?.querySelector(".rh-pdf-convert")?.remove();
  if (mode === "reader")
    readerMain.querySelector('.doc-content[data-node-id="' + parent.id + '"] .rh-pdf-convert')?.remove();
  // Reader stays mounted while Canvas is visible, so retire its docked action
  // too; otherwise switching modes would resurrect an invalid conversion.
  document
    .querySelector('#tb-document .rh-pdf-reader-toolbar[data-pdf-node-id="' + parent.id + '"] .rh-pdf-convert')
    ?.remove();
}

function submitAsk(lensKey, source) {
  if (!selectionDraft || closed) return;
  const parent = nodes[selectionDraft.parentId];
  if (!parent) {
    hideAsk();
    return;
  }
  if (parent.status === "pending" || parent.source?.converting) return;
  const preset = lensKey ? presetFor("selection", lensKey) : null;
  const lens = preset ? lensKey : null;
  const question = askText.value.trim();
  const instruction = preset?.instruction || null;
  const requestId = uuid(),
    childId = uuid();
  const pos = placeChild(parent, BRANCH_SELECTION);
  const anchor = selectionDraft.blockAnchor
    ? { block: selectionDraft.blockAnchor }
    : { offset_start: selectionDraft.startOff, offset_end: selectionDraft.endOff };
  if (selectionDraft.pdfAnchor) anchor.pdf = selectionDraft.pdfAnchor;
  const node = Object.assign(
    makeNode({
      id: childId,
      parent_id: parent.id,
      title: preset ? preset.label : question ? truncate(question, 48) : "…",
      html: "",
      markdown: "",
      base_url: parent.base_url || null,
      base_url_source: parent.base_url ? "inherited" : null,
      read: false,
      origin: {
        selected_text: selectionDraft.selectedText,
        question: question,
        lens: lens,
        ...(instruction ? { instruction: instruction } : {}),
        anchor: anchor,
        branch_type: BRANCH_SELECTION,
      },
      position: { x: pos.x, y: pos.y },
      size: { w: DEFAULT_CHILD.w, h: DEFAULT_CHILD.h },
      collapsed: false,
      status: "pending",
    }),
    { html: "", _order: nextOrder(), _startTs: systemClock.now() },
  );
  registerNode(node);
  retirePdfConversionAction(parent);
  const isPdfRegion = !!selectionDraft.pdfAnchor;
  function revealCreatedBranch(response) {
    if (response && response.crop_asset) node.origin.crop_asset = response.crop_asset;
    if (canvasBuilt && !node.el) {
      createNodeEl(node, true);
      renderVisibility();
      drawEdges();
    }

    // Mark inline in whichever views currently render the parent doc. Wrap via
    // offsets (always text-node endpoints) — a live Range can end on an element
    // boundary, which the text-walker can't terminate on.
    if (isPdfRegion) {
      if (mode === "reader")
        mountPdfRectMark(
          readerMain.querySelector('.doc-content[data-node-id="' + parent.id + '"]'),
          anchor,
          childId,
          "rh-pdf-mark mark-pending",
        );
      if (parent.bodyEl)
        mountPdfRectMark(parent.bodyEl.querySelector(".doc-content"), anchor, childId, "rh-pdf-mark mark-pending");
      scheduleEdges();
      if (mode === "reader" && currentNodeId === parent.id) renderMarginNotes();
    } else if (mode === "reader") {
      const rdc = readerMain.querySelector('.doc-content[data-node-id="' + parent.id + '"]');
      wrapInContainer(rdc, anchor, childId, "hl mark-pending");
      if (currentNodeId === parent.id) renderMarginNotes();
    }
    if (parent.bodyEl && !isPdfRegion) {
      wrapInContainer(parent.bodyEl.querySelector(".doc-content"), anchor, childId, "hl mark-pending");
      scheduleEdges();
    }
    revealNode(node, source);
    if (anchor.block) refreshVisualMarks(parent.id, anchor.block.block_id);
  }

  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  const closeVisualPreview = selectionDraft.overLightbox;
  hideAsk();
  if (closeVisualPreview) closeLightbox();
  const request = postBrowserEvent({
    type: "branch_request",
    request_id: requestId,
    node_id: childId,
    parent_id: parent.id,
    selected_text: node.origin.selected_text,
    question: question,
    lens: lens,
    ...(instruction ? { instruction: instruction } : {}),
    anchor: anchor,
    branch_type: BRANCH_SELECTION,
    position: { x: node.position.x, y: node.position.y },
    size: { w: node.size.w, h: node.size.h },
  });
  if (isPdfRegion) {
    // The host prepares and persists the crop before acknowledging this ask.
    // Keep the node registered for streamed events, but do not paint an empty
    // card: its first visible frame already contains the durable clip.
    request.then(function (res) {
      if (!res || !res.ok) rollbackBranch(node);
      else revealCreatedBranch(res);
    });
  } else {
    revealCreatedBranch(null);
    request.then(function (res) {
      if (!res || !res.ok) rollbackBranch(node);
    });
  }
}

// An ordinary Note commit docks on the words it marks. The hidden place
// chord takes the same note path but asks the shared placement primitive to
// give it geometry immediately.
function submitNote(source, placed) {
  if (!selectionDraft || closed) return;
  if (selectionDraft.blockAnchor) return;
  const markdown = askText.value.trim();
  if (!markdown) return;
  const draft = selectionDraft,
    parent = nodes[draft.parentId];
  if (!parent) {
    hideAsk();
    return;
  }
  const anchor = { offset_start: draft.startOff, offset_end: draft.endOff };
  if (draft.pdfAnchor) anchor.pdf = draft.pdfAnchor;
  const create = placed ? createPlacedNote : createDockedNote;
  const node = create(parent, markdown, {
    anchor: anchor,
    selectedText: draft.selectedText,
    sourceRect: placed ? ask.getBoundingClientRect() : null,
  });
  if (!node) return;
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  hideAsk();
  revealNode(node, source);
}

function submitReaction(reaction) {
  if (!selectionDraft || closed || selectionDraft.blockAnchor || askText.value !== "") return;
  const draft = selectionDraft,
    parent = nodes[draft.parentId];
  if (!parent) {
    hideAsk();
    return;
  }
  const glyph = reaction === "up" ? "👍" : reaction === "down" ? "👎" : null;
  if (!glyph) return;
  const anchor = { offset_start: draft.startOff, offset_end: draft.endOff };
  if (draft.pdfAnchor) anchor.pdf = draft.pdfAnchor;
  const node = createDockedNote(parent, glyph, {
    anchor: anchor,
    selectedText: draft.selectedText,
    reaction: true,
    instruction: reactionPrompt(reaction)?.instruction,
  });
  if (!node) return;
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  hideAsk();
}

// ---------- follow-up composer ----------
export function updateComposerState() {
  const current = nodes[currentNodeId];
  composerInner.classList.toggle("has-draft", !!composerText.value.trim());
  // A missing agent doesn't disable asking — questions queue server-side and
  // are answered when it returns. Only a closed session (server gone) does.
  applyComposerState(
    {
      text: composerText,
      commits: composerActions.querySelectorAll(".ask-commit"),
      lenses: composerActions.querySelectorAll(".lens"),
      wrap: composerInner,
    },
    {
      phase: sessionPhase(),
      pending: !!current && current.status === "pending",
      unavailable: !current || !!current.source?.converting,
    },
    {
      frozen: "Read-only snapshot — open the live Rabbithole to keep asking",
      closed: "Session ended — reopen this Rabbithole from your terminal; saved questions are answered there",
      pending: "This answer is still being written…",
      away: "The agent is away — questions are saved and answered when it returns…",
      live: "Ask or note…",
    },
  );
}
function autoGrowComposer() {
  autoGrowEl(composerText, 140);
}

// Shared follow-up submission: from the reader composer or a card's docked
// one. Every direct child uses the same Reader branch rail.
export function sendFollowup(parent, question, lens, instruction = null) {
  if (parent?.source?.converting) return null;
  const requestId = uuid(),
    childId = uuid();
  const pos = placeChild(parent, BRANCH_FOLLOWUP);
  const node = Object.assign(
    makeNode({
      id: childId,
      parent_id: parent.id,
      title: lens ? presetFor("followup", lens)?.label || String(lens) : truncate(question, 48),
      html: "",
      markdown: "",
      base_url: parent.base_url || null,
      base_url_source: parent.base_url ? "inherited" : null,
      read: false,
      origin: {
        selected_text: "",
        question: question,
        lens: lens,
        ...(instruction ? { instruction: instruction } : {}),
        anchor: null,
        branch_type: BRANCH_FOLLOWUP,
      },
      position: { x: pos.x, y: pos.y },
      size: { w: DEFAULT_CHILD.w, h: DEFAULT_CHILD.h },
      collapsed: false,
      status: "pending",
    }),
    { html: "", _order: nextOrder(), _startTs: systemClock.now() },
  );
  registerNode(node);
  retirePdfConversionAction(parent);
  if (canvasBuilt) {
    createNodeEl(node, true);
    renderVisibility();
    drawEdges();
  }
  if (currentNodeId === parent.id && mode === "reader") renderMarginNotes();
  const payload = {
    type: "branch_request",
    request_id: requestId,
    node_id: childId,
    parent_id: parent.id,
    selected_text: "",
    question: question,
    lens: lens,
    ...(instruction ? { instruction: instruction } : {}),
    anchor: null,
    branch_type: BRANCH_FOLLOWUP,
    position: { x: node.position.x, y: node.position.y },
    size: { w: node.size.w, h: node.size.h },
  };
  postBrowserEvent(payload).then(function (res) {
    if (!res || !res.ok) rollbackBranch(node);
  });
  return node;
}

// scrollTo({behavior:"smooth"}) proved unreliable here, so the one deliberate
// scroll in the app (submit → your new question) is driven by hand. rAF never
// fires in a hidden window — jump instantly there instead of never arriving.
let scrollAnimId = 0,
  scrollAnimIgnoreUntil = 0,
  scrollFrameCleanup = null;
function cancelScrollAnimation() {
  scrollAnimId++;
  clearScrollFrame();
}
function clearScrollFrame() {
  if (!scrollFrameCleanup) return;
  const cleanup = scrollFrameCleanup;
  scrollFrameCleanup = null;
  cleanup();
}
function scheduleScrollFrame(callback) {
  clearScrollFrame();
  const id = nextFrame(run);
  const cancel = function () {
    cancelFrame(id);
  };
  scrollFrameCleanup = askLifecycle.scope ? askLifecycle.scope.addCleanup(cancel) : cancel;
  function run(timestamp) {
    const cleanup = scrollFrameCleanup;
    scrollFrameCleanup = null;
    if (cleanup) cleanup();
    callback(timestamp);
  }
}
function setAnimatedScrollTop(el, value) {
  scrollAnimIgnoreUntil = performance.now() + 80;
  el.scrollTop = value;
}
export function animateScroll(el, target, source) {
  const myId = ++scrollAnimId;
  if (document.hidden || shouldReduceMotion() || source !== "pointer") {
    el.scrollTop = target;
    return;
  }
  const s = el.scrollTop,
    t0 = performance.now(),
    D = 240;
  function step(t) {
    if (myId !== scrollAnimId) return;
    const p = Math.min(1, (t - t0) / D),
      k = easeOutMotion(p);
    setAnimatedScrollTop(el, s + (target - s) * k);
    if (p < 1) scheduleScrollFrame(step);
  }
  scheduleScrollFrame(step);
}
function interruptScrollAnimation() {
  cancelScrollAnimation();
}
// The reader composer's submit gate: null when the session or the current
// document can't take a new branch (a closed session says so out loud).
function readerComposerParent(needsSettled) {
  if (closed) {
    flashHint(
      frozen
        ? "This is a read-only snapshot."
        : "Session ended — reopen this Rabbithole from your terminal to continue.",
    );
    return null;
  }
  const parent = nodes[currentNodeId];
  if (!parent || parent.source?.converting || (needsSettled && parent.status === "pending")) return null;
  return parent;
}
function submitReaderFollowup(commit, source) {
  const parent = readerComposerParent(commit === "ask");
  const question = composerText.value.trim();
  if (!parent || !question) return;
  const node = commit === "ask" ? sendFollowup(parent, question, null) : createPlacedNote(parent, question);
  if (!node) return;
  composerText.value = "";
  autoGrowComposer();
  updateComposerState();
  scrollReaderRail(source);
}
function submitReaderLens(lens, source) {
  const parent = readerComposerParent(true);
  const preset = presetFor("followup", lens);
  const question = composerText.value.trim();
  if (!parent || !preset || !sendFollowup(parent, question, lens, preset.instruction)) return;
  composerText.value = "";
  autoGrowComposer();
  updateComposerState();
  scrollReaderRail(source);
}
function scrollReaderRail(source) {
  const notes = document.getElementById("margin-notes");
  if (notes) animateScroll(notes, notes.scrollHeight, source);
}

// Undo an optimistic branch whose request the server rejected/never received.
// No-op if the node is already gone, or if an answer raced in ahead of the
// failed-POST callback (don't delete a node the agent actually answered).
export function rollbackBranch(node, restore) {
  const live = nodes[node.id];
  if (!live || live.status === "answered") return;
  const blockId = live.origin?.anchor?.block?.block_id || "";
  const parentId = live.parent_id;
  if (restore) restore(live);
  else teardownNode(node.id);
  if (blockId && parentId) refreshVisualMarks(parentId, blockId);
  if (canvasBuilt) drawEdges();
  if (mode === "reader" && currentNodeId === node.parent_id) renderMarginNotes();
  flashHint("Couldn't reach the agent — that ask was undone.");
}

function subtreeBounds(node) {
  return sharedSubtreeBounds(node, { childrenOf: placedChildrenOf, effH: effH, sort: nodeOrder });
}
// Only cards take up room: a docked note is drawn on its parent and has no
// bounds a new branch could collide with.
function placeChild(parent, branchType) {
  return sharedPlaceChild(parent, branchType, {
    childrenOf: placedChildrenOf,
    effH: effH,
    sort: nodeOrder,
    childSize: DEFAULT_CHILD,
  });
}
