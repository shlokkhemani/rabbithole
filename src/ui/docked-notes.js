import { BRANCH_SELECTION, branchTypeOfNode, isDockedNote, isReactionNote } from "../core/hole/ask.js";
import { makeNode } from "../core/hole/node.js";
import { iconSvg } from "../core/html/icons.js";
import { DEFAULT_CHILD, nodeOrder, placeChild as sharedPlaceChild } from "../core/layout.js";
import { removeBranch } from "./branch-surfaces.js";
import {
  canConvertNote,
  cancelViewAnimation,
  convertNoteToAsk,
  createNodeEl,
  drawEdges,
  effH,
  noteCommitFromEnter,
  noteComposerActions,
  raiseCard,
  renderVisibility,
  scheduleEdges,
} from "./canvas/index.js";
import { wireComposerActions } from "./composer-state.js";
import {
  buildDocContent,
  CANVAS_BASE,
  canvasBuilt,
  childrenOf,
  closed,
  flashHint,
  frozen,
  goToNode,
  mode,
  nextOrder,
  nodes,
  playLandingCue,
  postBrowserEvent,
  readerMain,
  registerNode,
  shouldReduceMotion,
  uuid,
  view,
  world,
} from "./core.js";
import { createCleanupScope, createModuleLifecycle } from "./kit/scope.js";
import { detachNode, teardownNode } from "./node-teardown.js";
import { anchorClipBounds, viewportRect } from "./overlay/anchor.js";
import { openPopover } from "./primitives/popover.js";
import { openBranchBeside } from "./reader.js";
import { refreshNodeHtml } from "./renderer.js";
import { structuredNoteController } from "./structured-note.js";
import { mountPdfRectMark, syncTextOverlayMarks, wrapInContainer } from "./text-marks.js";

/*
 * DOCKED NOTES — a note written about a card stays on that card.
 *
 * Nothing here is a new kind of thing: a docked note is an ordinary note node
 * whose extensions bag says it has no place on the canvas yet. It renders as
 * the wash on the words it marks plus a graphite dot in the card's own right
 * padding, and it reads and edits inside one anchored dialog. "Place on canvas"
 * clears the flag and hands the same node a position — same id, same lineage,
 * same MCP payload; only its shape on the page ever changed.
 *
 * The grammar is the product's existing one: single click reads, double click
 * edits — on the wash, on the dot, or on the note's own text in the popover.
 */

const DOT_STACK_GAP = 14; // minimum vertical rhythm between two dots
const DOT_RADIUS = 3.5;
const WHOLE_CARD_TOP = 2; // the ring leads the column, level with the first line

const dockedLifecycle = createModuleLifecycle({
  defaults: function () {
    return {};
  },
});
// One popover, one open note. Everything the surface needs to answer for
// itself — which note, which card, which state — lives in this record.
let popSession = null;
const reactionHideTimers = new Map();

export function initDockedNotes() {
  disposeDockedNoteResources(false);
  const scope = dockedLifecycle.beginInit();
  try {
    [world, readerMain].forEach(function (surface) {
      scope.listen(surface, "click", onSurfaceClick);
      scope.listen(surface, "dblclick", onSurfaceDblClick);
      scope.listen(surface, "keydown", onSurfaceKeydown);
      scope.listen(surface, "pointerover", onReactionPointerOver);
      scope.listen(surface, "pointerout", onReactionPointerOut);
      scope.listen(surface, "pointerup", onReactionPointerUp);
      scope.listen(surface, "focusin", onReactionFocusIn);
      scope.listen(surface, "focusout", onReactionFocusOut);
      scope.listen(surface, "mouseover", function (e) {
        syncPartnerHighlight(e, true);
      });
      scope.listen(surface, "mouseout", function (e) {
        syncPartnerHighlight(e, false);
      });
      // A card's own body carries its dots along as it scrolls, but an inner
      // scroller (a native PDF) moves the marks underneath them. Scroll does
      // not bubble, so the reposition is caught on the way down.
      scope.listen(surface, "scroll", scheduleEdges, true);
    });
    // Reader line breaks can change with the viewport. Repaint the empty note
    // overlays and move their dots after that reflow; neither pass can affect
    // the prose that caused it.
    scope.listen(window, "resize", positionDockedNotes);
    const surface = popEl();
    scope.listen(surface, "click", onPopoverClick);
    scope.listen(surface, "dblclick", onPopoverDblClick);
    scope.listen(surface, "keydown", onPopoverKeydown);
    scope.addCleanup(function () {
      clearReactionTooltips();
      closeNotePopover({ restoreFocus: false, commit: false });
    });
    return disposeDockedNotes;
  } catch (error) {
    disposeDockedNotes();
    throw error;
  }
}

export function disposeDockedNotes() {
  disposeDockedNoteResources(true);
}

function disposeDockedNoteResources(resetHooks) {
  closeNotePopover({ restoreFocus: false, commit: false });
  dockedLifecycle.dispose(resetHooks);
  popSession = null;
}

function popEl() {
  return document.getElementById("notepop");
}

// ---------------------------------------------------------------------------
// THE MODEL SIDE — creating, placing, removing
// ---------------------------------------------------------------------------

/* One optimistic note path serves anchored selection notes and anchor-less
   whole-card notes. The anchor alone decides whether there is a wash to mark;
   the durable origin stays the reducer's canonical {kind:"note"}. */
function createNoteChild(parent, markdown, options) {
  options = options || {};
  markdown = String(markdown || "").trim();
  if (!parent || !markdown || closed || parent.source?.converting) return null;
  const anchor = options.anchor || null;
  const placed = options.placed === true;
  const reaction = !placed && options.reaction === true;
  const reactionInstruction = reaction
    ? String(options.instruction || "")
        .trim()
        .slice(0, 4000)
    : "";
  const origin = anchor
    ? {
        kind: "note",
        selected_text: options.selectedText || "",
        anchor: anchor,
        branch_type: BRANCH_SELECTION,
        ...(reactionInstruction ? { instruction: reactionInstruction } : {}),
      }
    : { kind: "note" };
  const node = Object.assign(
    makeNode({
      id: uuid(),
      parent_id: parent.id,
      title: "Note",
      html: "",
      markdown,
      base_url: null,
      base_url_source: null,
      read: true,
      origin: origin,
      position: { x: 0, y: 0 },
      size: { w: DEFAULT_CHILD.w, h: DEFAULT_CHILD.h },
      collapsed: false,
      status: "answered",
      view: placed ? {} : { docked: true, ...(reaction ? { reaction: true } : {}) },
    }),
    { html: "", _order: nextOrder(), _startTs: 0 },
  );
  if (placed) {
    const pos = placeNoteChild(parent, branchTypeOfNode(node));
    node.position.x = pos.x;
    node.position.y = pos.y;
  }
  registerNode(node);
  paintNoteMarks(parent, node, anchor);
  if (placed) presentPlacedNote(node, parent, options.sourceRect);
  else {
    renderDockedNotes(parent);
    scheduleEdges();
  }
  const payload = placed
    ? {
        type: "node_create",
        id: node.id,
        parent_id: parent.id,
        markdown: markdown,
        origin: origin,
        position: { x: node.position.x, y: node.position.y },
        size: { w: node.size.w, h: node.size.h },
      }
    : { type: "node_create", id: node.id, parent_id: parent.id, markdown: markdown, origin: origin, docked: true };
  postBrowserEvent(payload).then(function (res) {
    if (!res || !res.ok) {
      rollbackCreatedNote(node);
      return;
    }
    if (reaction) {
      postBrowserEvent({
        type: "node_extensions_patch",
        node_id: node.id,
        namespace: "note",
        value: { docked: true, reaction: true },
      }).then(function (patchResult) {
        if (patchResult && patchResult.ok) return;
        postBrowserEvent({ type: "delete_node", node_id: node.id });
        rollbackCreatedNote(node);
      });
    }
  });
  return node;
}

export function createDockedNote(parent, markdown, options) {
  return createNoteChild(parent, markdown, options);
}

export function createPlacedNote(parent, markdown, options) {
  return createNoteChild(parent, markdown, Object.assign({}, options, { placed: true }));
}

function paintNoteMarks(parent, node, anchor) {
  if (!anchor) return;
  const reactionClass = isReactionNote(node) ? " mark-reaction" : "";
  const readerDoc = readerMain.querySelector('.doc-content[data-node-id="' + parent.id + '"]');
  const cardDoc = parent.bodyEl ? parent.bodyEl.querySelector(".doc-content") : null;
  if (anchor.pdf) {
    if (mode === "reader")
      mountPdfRectMark(readerDoc, anchor, node.id, "rh-pdf-mark mark-ready mark-note" + reactionClass);
    mountPdfRectMark(cardDoc, anchor, node.id, "rh-pdf-mark mark-ready mark-note" + reactionClass);
    return;
  }
  if (mode === "reader") wrapInContainer(readerDoc, anchor, node.id, "hl mark-ready mark-note" + reactionClass);
  wrapInContainer(cardDoc, anchor, node.id, "hl mark-ready mark-note" + reactionClass);
}

// Undo brings a removed docked note back as what it always was: a wash on its
// parent's words and a dot beside them. The parent's body is never rebuilt.
export function paintDockedNote(node) {
  const parent = node && nodes[node.parent_id];
  if (!parent) return;
  paintNoteMarks(parent, node, node.origin && node.origin.anchor);
  renderDockedNotes(parent);
}

function rollbackCreatedNote(node) {
  if (nodes[node.id] !== node) return;
  const parent = nodes[node.parent_id];
  teardownNode(node.id);
  renderDockedNotes(parent);
  if (canvasBuilt) drawEdges();
  flashHint("Couldn't save that note — it was undone.");
}

/* Placement is spatial, never a change of identity: the note keeps its id and
   its words and gains a position, using the same free-spot search a new branch
   uses. Docked siblings are invisible to that search — they have no place to
   collide with. */
function placeNoteChild(parent, branchType) {
  return sharedPlaceChild(parent, branchType, {
    childrenOf: placedChildrenOf,
    effH: effH,
    sort: nodeOrder,
    childSize: DEFAULT_CHILD,
  });
}

/** Children that actually occupy canvas space. */
export function placedChildrenOf(id) {
  return childrenOf(id).filter(function (node) {
    return !isDockedNote(node);
  });
}

function presentPlacedNote(node, parent, sourceRect) {
  if (canvasBuilt && !node.el) createNodeEl(node, false);
  if (node.el) raiseCard(node.el);
  renderVisibility();
  renderDockedNotes(parent);
  drawEdges();
  flyNoteToCard(sourceRect, node);
}

export function placeDockedNote(node, sourceRect, options = {}) {
  const parent = node && node.parent_id != null ? nodes[node.parent_id] : null;
  if (!parent || frozen || closed || !isDockedNote(node)) return false;
  const pos = placeNoteChild(parent, branchTypeOfNode(node));
  node.position.x = pos.x;
  node.position.y = pos.y;
  node.view = Object.assign({}, node.view);
  delete node.view.docked;
  presentPlacedNote(node, parent, sourceRect);
  if (options.persist !== false) {
    postBrowserEvent({ type: "node_extensions_patch", node_id: node.id, namespace: "note", value: {} });
    postBrowserEvent({
      type: "node_update",
      node_id: node.id,
      position: { x: node.position.x, y: node.position.y },
      size: { w: node.size.w, h: node.size.h },
    });
  }
  return true;
}

// The one moment a note travels: a FLIP on the real card. The card is created
// at its destination, an initial transform maps it back onto the dot or dialog
// it came from, and one composited transition carries it to identity — no
// ghost, no per-frame layout, no second copy of the text.
function flyNoteToCard(sourceRect, node) {
  const card = node.el;
  if (!card) return;
  if (mode !== "canvas" || !sourceRect || document.hidden || shouldReduceMotion()) {
    playLandingCue(card, "flash");
    return;
  }
  const target = card.getBoundingClientRect();
  if (!target.width || !target.height) {
    playLandingCue(card, "flash");
    return;
  }
  // The card lives in the zoomed world, so screen deltas divide by the camera.
  const scale = view.scale || 1;
  const dx = (sourceRect.left - target.left) / scale;
  const dy = (sourceRect.top - target.top) / scale;
  const sx = Math.max(0.05, sourceRect.width / target.width);
  const sy = Math.max(0.05, sourceRect.height / target.height);
  card.style.transformOrigin = "top left";
  card.style.transform = "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")";
  card.style.opacity = "0.05";
  card.style.willChange = "transform, opacity";
  const scope = dockedLifecycle.scope;
  let settled = false;
  function settle() {
    if (settled) return;
    settled = true;
    card.removeEventListener("transitionend", onTransitionEnd);
    card.style.transition = "";
    card.style.transform = "";
    card.style.opacity = "";
    card.style.willChange = "";
    card.style.transformOrigin = "";
  }
  function onTransitionEnd(e) {
    if (e.target === card && e.propertyName === "transform") settle();
  }
  function launch() {
    if (!card.isConnected) {
      settle();
      return;
    }
    card.style.transition =
      "transform var(--duration-slow) var(--ease-out), opacity var(--duration-slow) var(--ease-out)";
    card.style.transform = "";
    card.style.opacity = "";
    card.addEventListener("transitionend", onTransitionEnd);
    if (scope) scope.timeout(settle, 520);
    else setTimeout(settle, 520);
  }
  if (scope) scope.raf(launch);
  else requestAnimationFrame(launch);
}

// ---------------------------------------------------------------------------
// THE MARGIN — dots that live in the card's own right padding
// ---------------------------------------------------------------------------

function noteAnchorOf(node) {
  return (node.origin && node.origin.anchor) || null;
}

/* Whole-card notes lead the column; anchored notes follow in document order. */
function dockedNotesOf(parent) {
  return childrenOf(parent.id)
    .filter(function (node) {
      return isDockedNote(node) && !isReactionNote(node);
    })
    .sort(function (a, b) {
      const aAnchor = noteAnchorOf(a),
        bAnchor = noteAnchorOf(b);
      if (!aAnchor !== !bAnchor) return aAnchor ? 1 : -1;
      if (aAnchor && bAnchor) return aAnchor.offset_start - bAnchor.offset_start;
      return nodeOrder(a, b);
    });
}

function dotLabel(node) {
  const words = String(node.markdown || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 8)
    .join(" ");
  return noteAnchorOf(node) ? "Note: " + (words || "empty") : "Note on this card";
}

/* In the reader the margin also carries the document's branches — every answer
   and placed note that grew from it — so the whole shape of a document reads
   down its right edge: graphite for your notes, accent for the answers. On the
   canvas a branch has its own card and edge, so only docked notes get a dot. */
function branchesOf(parent) {
  return childrenOf(parent.id)
    .filter(function (node) {
      return !isDockedNote(node) && !node._pendingDelete;
    })
    .sort(function (a, b) {
      const aAnchor = noteAnchorOf(a),
        bAnchor = noteAnchorOf(b);
      if (!aAnchor !== !bAnchor) return aAnchor ? 1 : -1;
      if (aAnchor && bAnchor) return aAnchor.offset_start - bAnchor.offset_start;
      return nodeOrder(a, b);
    });
}

function marginItemsOf(parent) {
  const notes = dockedNotesOf(parent);
  const items = notes.concat(branchesOf(parent));
  // Whole-document items lead the column; anchored ones follow the text.
  return items.sort(function (a, b) {
    const aAnchor = noteAnchorOf(a),
      bAnchor = noteAnchorOf(b);
    if (!aAnchor !== !bAnchor) return aAnchor ? 1 : -1;
    if (aAnchor && bAnchor) return aAnchor.offset_start - bAnchor.offset_start;
    return nodeOrder(a, b);
  });
}

function branchLabel(node) {
  const question = (node.origin && node.origin.question) || node.title || "Untitled";
  const kind = node.origin && node.origin.kind === "note" ? "Note" : "Answer";
  return kind + ": " + question + (node.status === "answered" ? "" : " (writing)");
}

function canvasDotHost(parent) {
  return parent.el && !parent.collapsed ? parent.bodyEl : null;
}
function readerDotHosts(parent) {
  if (mode !== "reader" || !readerMain) return [];
  return Array.from(
    readerMain.querySelectorAll('.reader-pane:not(.pane-leaving)[data-node-id="' + parent.id + '"] .reader-col'),
  );
}

/* Rebuild every dot column for one card. Cheap enough to call from every place
   that rebuilds the card's body; positioning is a separate, measure-only pass
   because the card's width is only final after layout. */
export function renderDockedNotes(parent) {
  if (!parent) return;
  syncDotColumn(canvasDotHost(parent), dockedNotesOf(parent), false);
  const hosts = readerDotHosts(parent);
  if (hosts.length) {
    const items = marginItemsOf(parent);
    for (let i = 0; i < hosts.length; i++) syncDotColumn(hosts[i], items, true);
  }
  positionDockedNotes();
  if (dockedLifecycle.scope) dockedLifecycle.scope.raf(positionDockedNotes);
}

function syncDotColumn(host, notes, reader) {
  if (!host) return;
  let layer = host.querySelector(":scope > .note-dots");
  if (!notes.length) {
    if (layer) layer.remove();
    return;
  }
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "note-dots";
    host.appendChild(layer);
  }
  layer.classList.toggle("note-dots-reader", !!reader);
  // Dots keep their identity across re-renders: an open popover is anchored to
  // its dot element, so a rebuild must update in place, never replace. A
  // destroyed trigger would strand the dialog — anchoring bails on a
  // disconnected anchor and never recovers.
  const existing = {};
  for (let i = layer.children.length - 1; i >= 0; i--) {
    const child = layer.children[i];
    existing[child.dataset.note] = child;
  }
  notes.forEach(function (note, index) {
    const branch = !isDockedNote(note);
    let dot = existing[note.id];
    if (dot && dot.classList.contains("branch-dot") !== branch) {
      dot.remove();
      dot = null;
    }
    if (!dot) {
      dot = document.createElement("button");
      dot.type = "button";
      dot.dataset.note = note.id;
      if (!branch) {
        dot.setAttribute("aria-haspopup", "dialog");
        dot.setAttribute("aria-expanded", "false");
      }
    }
    if (branch) paintBranchDot(dot, note);
    else {
      dot.className = "note-dot" + (noteAnchorOf(note) ? "" : " note-dot-whole");
      dot.setAttribute("aria-label", dotLabel(note));
    }
    if (layer.children[index] !== dot) layer.insertBefore(dot, layer.children[index] || null);
  });
  // Every wanted dot now sits at its own index; anything beyond them is stale.
  while (layer.children.length > notes.length) layer.lastChild.remove();
}

// A branch dot is the answer's handle in its parent's margin: pending ones
// breathe, answered ones are solid, and the one whose answer is open beside
// its document wears a ring. Hovering it names the question.
function paintBranchDot(dot, node) {
  const note = node.origin && node.origin.kind === "note";
  const open = !!(
    readerMain && readerMain.querySelector('.reader-pane:not(.pane-leaving)[data-node-id="' + node.id + '"]')
  );
  dot.className =
    "branch-dot" +
    (noteAnchorOf(node) ? "" : " branch-dot-whole") +
    (note ? " branch-dot-note" : "") +
    (note || node.status === "answered" ? "" : " branch-dot-pending") +
    (open ? " branch-dot-open" : "");
  dot.setAttribute("aria-label", "Open " + branchLabel(node));
  let tip = dot.querySelector(".branch-dot-tip");
  if (!tip) {
    tip = document.createElement("span");
    tip.className = "branch-dot-tip";
    tip.setAttribute("aria-hidden", "true");
    dot.appendChild(tip);
  }
  tip.textContent = (node.origin && node.origin.question) || node.title || "Untitled";
}

/* Each dot sits on its anchor's line box, nudging off the exact line only when
   a neighbour is already there. Canvas rects arrive scaled by the camera; the
   column's own coordinates never are. */
export function positionDockedNotes(root) {
  root = root && root.querySelectorAll ? root : document;
  syncTextOverlayMarks(root);
  const layers = root.matches && root.matches(".note-dots") ? [root] : root.querySelectorAll(".note-dots");
  for (let i = 0; i < layers.length; i++) positionDotColumn(layers[i]);
}

function positionDotColumn(layer) {
  const host = layer.parentElement;
  const reader = layer.classList.contains("note-dots-reader");
  // The reader keeps its DOM while the canvas is up, but its margin column
  // belongs to the document being read: it retires with the mode.
  if (!host || (reader && mode !== "reader")) {
    layer.remove();
    return;
  }
  const scale = reader ? 1 : view.scale || 1;
  const hostRect = host.getBoundingClientRect();
  const scrollTop = reader ? 0 : host.scrollTop;
  // The reader's margin is only a margin while there is room for it; a column
  // that fills the window (a native PDF) keeps its dots inside its own edge.
  if (reader) {
    const pane = host.closest(".reader-pane");
    const edge = pane ? pane.getBoundingClientRect().right : window.innerWidth || 0;
    layer.classList.toggle("note-dots-inside", hostRect.right + 26 > edge);
  }
  let previous = -Infinity;
  const dots = layer.children;
  for (let i = 0; i < dots.length; i++) {
    const dot = dots[i];
    const mark = markElement(host, dot.dataset.note);
    // An inline mark can wrap: its dot belongs on the line where it starts.
    const markRect = mark ? mark.getClientRects()[0] || mark.getBoundingClientRect() : null;
    let top =
      markRect && markRect.height
        ? (markRect.top - hostRect.top) / scale + scrollTop + markRect.height / scale / 2 - DOT_RADIUS
        : WHOLE_CARD_TOP;
    if (top < previous + DOT_STACK_GAP) top = previous + DOT_STACK_GAP;
    previous = top;
    dot.style.top = top + "px";
  }
}

function markElement(scope, noteId) {
  if (!scope || !noteId) return null;
  return scope.querySelector('mark[data-child="' + noteId + '"], [data-child="' + noteId + '"].rh-pdf-mark');
}

function visibleElement(selector) {
  const found = document.querySelectorAll(selector);
  for (let i = 0; i < found.length; i++) {
    if (found[i].isConnected && found[i].getClientRects().length) return found[i];
  }
  return found[0] || null;
}

function affordanceFor(node) {
  return (
    visibleElement('.note-dot[data-note="' + node.id + '"]') ||
    visibleElement('mark[data-child="' + node.id + '"], [data-child="' + node.id + '"].rh-pdf-mark')
  );
}

// Hovering either half of a note lights the other: the wash and its dot are one
// object seen twice.
function syncPartnerHighlight(event, on) {
  const target = event.target;
  if (!target || !target.closest) return;
  const dot = target.closest(".note-dot, .branch-dot");
  if (dot) {
    if (!on && dot.contains(event.relatedTarget)) return;
    setMarkHighlight(dot.dataset.note, on);
    return;
  }
  const mark = target.closest("[data-child]");
  if (!mark || !nodes[mark.dataset.child]) return;
  if (!on && mark.contains(event.relatedTarget)) return;
  const id = mark.dataset.child;
  const partner = visibleElement('.note-dot[data-note="' + id + '"], .branch-dot[data-note="' + id + '"]');
  if (partner) partner.classList.toggle("note-dot-partner", on);
}

function setMarkHighlight(noteId, on) {
  const marks = document.querySelectorAll('[data-child="' + noteId + '"]');
  for (let i = 0; i < marks.length; i++) marks[i].classList.toggle("mark-focus", on);
}

// ---------------------------------------------------------------------------
// REACTIONS — one tooltip per reaction, pinned to the start of its first line
// ---------------------------------------------------------------------------
// A wash is one absolute fragment per line box, but a reaction is one object:
// the tooltip lives on the first fragment and stays put while the pointer
// wanders across any of its lines.

function reactionMarkFromTarget(target) {
  const mark = target?.closest?.(".mark-reaction[data-child]");
  return mark && isReactionNote(nodes[mark.dataset.child]) ? mark : null;
}

function reactionFragments(mark) {
  const root = mark.closest(".doc-content");
  return root ? Array.from(root.querySelectorAll('.mark-reaction[data-child="' + mark.dataset.child + '"]')) : [mark];
}

// Fragments are painted in range order, so the first is the first line.
function reactionHost(mark) {
  return reactionFragments(mark)[0] || mark;
}

function clearReactionHide(mark) {
  const host = reactionHost(mark);
  const timer = reactionHideTimers.get(host);
  if (timer) clearTimeout(timer);
  reactionHideTimers.delete(host);
}

function reactionTooltip(mark) {
  return mark ? reactionHost(mark).querySelector(":scope > .reaction-tip-wrap") : null;
}

function removeReactionTooltip(mark) {
  if (!mark) return;
  clearReactionHide(mark);
  reactionTooltip(mark)?.remove();
}

function clearReactionTooltips() {
  reactionHideTimers.forEach(function (timer) {
    clearTimeout(timer);
  });
  reactionHideTimers.clear();
  document.querySelectorAll(".reaction-tip-wrap").forEach(function (tip) {
    tip.remove();
  });
}

function reactionTooltipContent(node) {
  const tip = document.createElement("span");
  tip.className = "reaction-tooltip";
  const glyph = document.createElement("span");
  glyph.className = "reaction-tooltip-glyph";
  glyph.textContent = node.markdown;
  tip.appendChild(glyph);
  if (!frozen) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "reaction-delete";
    remove.setAttribute("aria-label", "Remove reaction");
    // The product's close icon, not a text ×: glyph ink never centers in its
    // em box, an SVG centers exactly. Rendered small so it reads as
    // punctuation beside the emoji, never a peer control.
    remove.innerHTML = iconSvg("close", { size: 10 });
    tip.appendChild(remove);
  }
  return tip;
}

// The side is chosen once, at open: above the first line unless that would
// clip, then below it. The tooltip never re-decides while it is showing.
function appendHtmlReactionTooltip(host, node) {
  const wrap = document.createElement("span");
  wrap.className = "reaction-tip-wrap";
  wrap.appendChild(reactionTooltipContent(node));
  host.appendChild(wrap);
  const clip = anchorClipBounds(host, viewportRect());
  const lineRect = host.getBoundingClientRect(),
    tipRect = wrap.getBoundingClientRect();
  if (lineRect.top - tipRect.height < clip.top) wrap.classList.add("reaction-tip-below");
  const overflow = tipRect.right - clip.right;
  if (overflow > 0) wrap.style.left = -overflow / (wrap.offsetWidth ? tipRect.width / wrap.offsetWidth : 1) + "px";
}

function appendPdfReactionTooltip(host, node) {
  const svg = host.ownerSVGElement;
  const svgRect = svg?.getBoundingClientRect();
  const box = svg?.viewBox?.baseVal;
  if (!svg || !svgRect?.width || !svgRect.height || !box?.width || !box.height) return;
  const scaleX = box.width / svgRect.width,
    scaleY = box.height / svgRect.height;
  const lineRect = (host.querySelector("polygon") || host).getBoundingClientRect();
  const clip = anchorClipBounds(svg, viewportRect());
  const below = lineRect.top - 34 < clip.top;
  const left = Math.min(lineRect.left, clip.right - 76);
  const width = 76 * scaleX,
    height = 34 * scaleY;
  const wrap = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
  wrap.setAttribute("class", "reaction-tip-wrap reaction-tip-svg" + (below ? " reaction-tip-below" : ""));
  wrap.setAttribute("x", String((left - svgRect.left) * scaleX));
  const top = below ? (lineRect.bottom - svgRect.top) * scaleY : (lineRect.top - svgRect.top) * scaleY - height;
  wrap.setAttribute("y", String(top));
  wrap.setAttribute("width", String(width));
  wrap.setAttribute("height", String(height));
  const html = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
  html.className = "reaction-tip-svg-inner";
  html.appendChild(reactionTooltipContent(node));
  wrap.appendChild(html);
  host.appendChild(wrap);
}

function showReactionTooltip(mark) {
  const node = mark && nodes[mark.dataset.child];
  if (!mark || !isReactionNote(node)) return;
  clearReactionHide(mark);
  if (reactionTooltip(mark)) return; // already open: it stays exactly where it is
  document.querySelectorAll('.mark-reaction[data-child="' + mark.dataset.child + '"]').forEach(removeReactionTooltip);
  const host = reactionHost(mark);
  if (host.namespaceURI === "http://www.w3.org/2000/svg") appendPdfReactionTooltip(host, node);
  else appendHtmlReactionTooltip(host, node);
}

function scheduleReactionTooltipHide(mark) {
  clearReactionHide(mark);
  const host = reactionHost(mark);
  const timer = setTimeout(function () {
    reactionHideTimers.delete(host);
    const engaged = reactionFragments(host).some(function (fragment) {
      return fragment.matches?.(":hover") || fragment.contains(document.activeElement);
    });
    if (!engaged) removeReactionTooltip(host);
  }, 180);
  reactionHideTimers.set(host, timer);
}

function onReactionPointerOver(event) {
  if (event.pointerType && event.pointerType !== "mouse") return;
  const mark = reactionMarkFromTarget(event.target);
  if (mark) showReactionTooltip(mark);
}

function onReactionPointerOut(event) {
  if (event.pointerType && event.pointerType !== "mouse") return;
  const mark = reactionMarkFromTarget(event.target);
  if (!mark || mark.contains(event.relatedTarget)) return;
  scheduleReactionTooltipHide(mark);
}

function onReactionPointerUp(event) {
  if (!event.pointerType || event.pointerType === "mouse" || event.target?.closest?.(".reaction-tip-wrap")) return;
  const mark = reactionMarkFromTarget(event.target);
  if (!mark) return;
  event.preventDefault();
  event.stopPropagation();
  if (reactionTooltip(mark)) removeReactionTooltip(mark);
  else showReactionTooltip(mark);
}

function onReactionFocusIn(event) {
  const mark = reactionMarkFromTarget(event.target);
  if (!mark) return;
  clearReactionHide(mark);
  if (event.target === mark) showReactionTooltip(mark);
}

function onReactionFocusOut(event) {
  const mark = reactionMarkFromTarget(event.target);
  if (!mark || mark.contains(event.relatedTarget)) return;
  scheduleReactionTooltipHide(mark);
}

// ---------------------------------------------------------------------------
// GESTURES — click reads, double click edits, wherever the note shows itself
// ---------------------------------------------------------------------------

function dockedNoteFromEvent(event) {
  const target = event.target;
  if (!target || !target.closest) return null;
  const dot = target.closest(".note-dot");
  if (dot) return { node: nodes[dot.dataset.note], trigger: dot, placement: "bottom-end" };
  const mark = target.closest("[data-child]");
  if (!mark) return null;
  const node = nodes[mark.dataset.child];
  return isDockedNote(node) && !isReactionNote(node) ? { node: node, trigger: mark, placement: "bottom-start" } : null;
}

function onSurfaceClick(event) {
  const remove = event.target?.closest?.(".reaction-delete");
  if (remove) {
    const mark = reactionMarkFromTarget(remove);
    const node = mark && nodes[mark.dataset.child];
    if (!mark || !node || frozen) return;
    event.preventDefault();
    event.stopPropagation();
    removeReactionTooltip(mark);
    removeBranch(node);
    return;
  }
  const reaction = reactionMarkFromTarget(event.target);
  if (reaction) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const hit = dockedNoteFromEvent(event);
  if (!hit || !hit.node) return;
  if (!window.getSelection().isCollapsed) return; // the human was selecting, not clicking
  event.preventDefault();
  event.stopPropagation();
  openDockedNote(hit.node, hit.trigger, "read", hit.placement);
}

function onSurfaceDblClick(event) {
  if (reactionMarkFromTarget(event.target)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const hit = dockedNoteFromEvent(event);
  if (!hit || !hit.node) return;
  event.preventDefault();
  event.stopPropagation();
  openDockedNote(hit.node, hit.trigger, editingAllowed() ? "edit" : "read", hit.placement);
}

function onSurfaceKeydown(event) {
  const reaction = reactionMarkFromTarget(event.target);
  if (reaction) {
    if (event.target?.closest?.(".reaction-delete")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      removeReactionTooltip(reaction);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (reactionTooltip(reaction)) removeReactionTooltip(reaction);
      else showReactionTooltip(reaction);
    }
    return;
  }
  if (event.key !== "Enter" && event.key !== "F2") return;
  const hit = dockedNoteFromEvent(event);
  if (!hit || !hit.node) return;
  event.preventDefault();
  event.stopPropagation();
  const wantsEdit = event.key === "F2" || (popSession && popSession.node === hit.node);
  openDockedNote(hit.node, hit.trigger, wantsEdit && editingAllowed() ? "edit" : "read", hit.placement);
}

function editingAllowed() {
  return !frozen && !closed;
}

// ---------------------------------------------------------------------------
// THE POPOVER — read state, edit state, one anchored dialog
// ---------------------------------------------------------------------------

/** Open a note the human already has on screen (dot, wash, or ⌘K result). */
export function openDockedNote(node, trigger, state, placement) {
  if (!node) return;
  // No affordance, no dialog: a popover must never anchor to itself.
  const anchor = trigger || affordanceFor(node);
  if (!anchor) return;
  openNotePopover({
    node: node,
    trigger: anchor,
    state: state === "edit" && editingAllowed() ? "edit" : "read",
    placement: placement,
  });
}

/* A ⌘K hit on a docked note: it has no card of its own, so travel to the card
   it lives on and open it there. */
export function revealDockedNote(node, source) {
  if (!isDockedNote(node)) return false;
  const parent = nodes[node.parent_id];
  if (!parent) return false;
  if (isReactionNote(node)) {
    if (!affordanceFor(node)) goToNode(parent, source);
    return true;
  }
  function show() {
    const affordance = affordanceFor(node);
    if (affordance) openDockedNote(node, affordance, "read");
  }
  if (affordanceFor(node)) {
    show();
    return true;
  }
  goToNode(parent, source);
  if (dockedLifecycle.scope) dockedLifecycle.scope.raf(show);
  else show();
  return true;
}

export function closeDockedNotePopover(settings) {
  closeNotePopover(settings || { restoreFocus: false, commit: true });
}

function openNotePopover(options) {
  const surface = popEl();
  if (!surface || !options.trigger) return;
  closeNotePopover({ restoreFocus: false, commit: true });
  // The dialog is pinned to a card's screen rect and applyTransform dismisses
  // anything anchored there, so an in-flight glide would close it on its very
  // next frame. Reaching for a note yields the glide, exactly as the ⋯ menu does.
  cancelViewAnimation();
  popSession = {
    node: options.node,
    trigger: options.trigger,
    state: "read",
    editor: null,
    controller: null,
    document: null,
    editorCleanup: null,
    draft: options.node.markdown || "",
    popover: null,
    readFooter: null,
  };
  surface.classList.add("visible");
  renderPopoverState("read");
  if (options.state === "edit") renderPopoverState("edit");
  popSession.popover = openPopover({
    trigger: options.trigger,
    surface: surface,
    placement: options.placement || "bottom-end",
    // Escape walks one level at a time here (edit → read → closed), so the
    // layer stack must not swallow the whole dialog on the first press.
    closeOnEscape: false,
    onEscape: onPopoverEscape,
    initialFocus: popSession.editor || surface.querySelector(".note-pop-view"),
    onClose: function () {
      closeNotePopover({ commit: true });
    },
  });
}

function closeNotePopover(settings) {
  const session = popSession;
  if (!session) return;
  popSession = null;
  settings = settings || {};
  if (settings.commit !== false && session.state === "edit") commitEditor(session, "close");
  const surface = popEl();
  if (surface) {
    surface.classList.remove("visible");
    if (session.editorCleanup) session.editorCleanup();
    if (session.document && session.document._rhDispose) session.document._rhDispose();
    surface.querySelector(".note-pop-body").replaceChildren();
    // The edit state borrowed the footer's slot for the commit pair; hand the
    // read bar back so the next open starts from the surface's own markup.
    if (session.readFooter) surface.querySelector(".note-pop-actions").replaceWith(session.readFooter);
  }
  if (session.popover) session.popover.close(settings);
}

function renderPopoverState(state) {
  const session = popSession,
    surface = popEl();
  if (!session || !surface) return;
  const body = surface.querySelector(".note-pop-body");
  let footer = /** @type {HTMLElement} */ (surface.querySelector(".note-pop-actions"));
  if (!session.document) {
    const view = document.createElement("div");
    view.className = "note-pop-view";
    view.tabIndex = 0;
    const documentSurface = buildDocContent(session.node, CANVAS_BASE);
    view.appendChild(documentSurface);
    body.replaceChildren(view);
    session.view = view;
    session.document = documentSurface;
    session.controller = structuredNoteController(documentSurface);
  }
  if (state === "edit") {
    session.state = "edit";
    session.draft = session.node.markdown || "";
    const editor = buildNoteEditor(session);
    if (!session.readFooter) {
      session.readFooter = footer;
    }
    footer.replaceWith(editor.actions);
    session.view.classList.add("editing");
    session.view.title = "";
    session.controller.setEditable(true);
    return;
  }
  session.state = "read";
  if (session.editorCleanup) session.editorCleanup();
  session.editor = null;
  session.controller.setOnChange(null);
  session.controller.setEditable(false);
  session.view.classList.remove("editing");
  if (session.readFooter && footer !== session.readFooter) {
    footer.replaceWith(session.readFooter);
    footer = session.readFooter;
  }
  session.readFooter = null;
  session.view.title = editingAllowed() ? "Double-click to edit" : "";
  // A snapshot reads and nothing more — the whole bar stands down with its verbs.
  footer.style.display = editingAllowed() ? "" : "none";
  const showPlace = isDockedNote(session.node);
  const showAsk = showPlace && canAskFromNote(session);
  const place = /** @type {HTMLElement} */ (surface.querySelector(".note-pop-place"));
  place.style.display = showPlace ? "" : "none";
  const ask = /** @type {HTMLButtonElement} */ (surface.querySelector(".note-pop-ask"));
  ask.style.display = showAsk ? "" : "none";
  // A pair's seam only makes sense between two standing verbs.
  footer.classList.toggle("note-only", !(showPlace && showAsk));
}

/* The edit state is the read state with a caret — same inset, same face — and
   the composer's own bar: the same Note / Ask pair, the same keys, because a
   note being written for the first time and a note being rewritten are the
   same act. */
function buildNoteEditor(session) {
  const editor = session.document;
  const actions = noteComposerActions();
  actions.classList.add("note-pop-actions", "has-draft");
  // A note that cannot become an ask keeps the bar with Note alone — one
  // button, so no divider down the middle.
  if (!canAskFromNote(session)) {
    actions.querySelector('[data-commit="ask"]').remove();
    actions.classList.add("note-only");
  }
  session.editor = editor;
  const editorScope = createCleanupScope();
  const listen = editorScope.listen;
  editorScope.addCleanup(function () {
    session.controller.setOnChange(null);
    session.editorCleanup = null;
  });
  function syncCommits() {
    const disabled = !session.draft.trim();
    /** @type {NodeListOf<HTMLButtonElement>} */
    const commits = actions.querySelectorAll(".ask-commit");
    for (let i = 0; i < commits.length; i++) commits[i].disabled = disabled;
  }
  session.controller.setOnChange(function (markdown) {
    session.draft = markdown;
    syncCommits();
  });
  wireComposerActions({
    text: editor,
    actions: actions,
    listen: listen,
    hasDraft: function () {
      return !!session.draft.trim();
    },
    commitFromEnter: noteCommitFromEnter,
    onCommit: function (kind, e) {
      e.stopPropagation();
      commitEditor(popSession, kind);
    },
    onLens: function () {},
  });
  session.editorCleanup = function () {
    editorScope.dispose();
  };
  syncCommits();
  return { actions: actions };
}

/* Asking from a docked note is one motion: the note gains a place and then
   becomes the question, so the answer has something to hang from. */
function canAskFromNote(session) {
  return editingAllowed() && canConvertNote(session.node);
}

function commitEditor(session, kind) {
  if (!session || session.state !== "edit" || !session.editor) return;
  const text = String(session.draft || "").trim();
  const node = session.node;
  if (!text) {
    // An empty note is no note: the note keeps the words it already had.
    if (kind !== "close") renderPopoverState("read");
    return;
  }
  if (text !== (node.markdown || "")) {
    node.markdown = text;
    refreshNodeHtml(node);
    persistNoteText(node);
    document.querySelectorAll('.doc-content[data-node-id="' + node.id + '"]').forEach(function (surface) {
      if (surface === session.document) return;
      const controller = structuredNoteController(surface);
      if (controller) controller.replaceMarkdown(text);
    });
    renderDockedNotes(nodes[node.parent_id]);
  }
  if (kind === "ask" && placeDockedNote(node, affordanceRect(node)) && convertNoteToAsk(node, text)) {
    closeNotePopover({ commit: false });
    return;
  }
  if (kind === "note-window" && placeDockedNote(node, affordanceRect(node))) {
    closeNotePopover({ restoreFocus: false, commit: false });
    return;
  }
  if (kind === "close") {
    session.state = "read";
    return;
  }
  // Saving re-renders in place to the read state — you see what you wrote,
  // in the same dialog, with nothing torn down to blink or jump.
  renderPopoverState("read");
  if (session.popover) session.popover.update();
  focusPopover();
}

function persistNoteText(node) {
  postBrowserEvent({ type: "node_update", node_id: node.id, title: node.title, markdown: node.markdown });
}

/* A keyboard save (or Escape out of the editor) puts focus on the dialog
   surface, not the prose: the surface keeps every popover shortcut alive —
   Esc, ⌫, ⌘↵, double-click — but wears no focus ring by design, so the note
   never comes back from a save outlined. */
function focusPopover() {
  const surface = popEl();
  if (!surface) return;
  try {
    surface.focus({ preventScroll: true });
  } catch (_e) {}
}

function affordanceRect(node) {
  const affordance = affordanceFor(node);
  return affordance ? affordance.getBoundingClientRect() : null;
}

function placePopoverNote(session) {
  const node = session && session.node,
    rect = affordanceRect(node);
  if (!node || !isDockedNote(node)) return;
  closeNotePopover({ restoreFocus: false, commit: false });
  placeDockedNote(node, rect);
}

/* The read-state Ask is deliberately one optimistic transaction. Placement is
   local-only: the branch request itself persists the pending card geometry.
   If that request cannot be posted, the conversion restores the note and this
   callback removes the temporary card so its original margin dot returns. */
function askFromPopoverNote(session) {
  const node = session && session.node,
    rect = affordanceRect(node);
  if (!node || !isDockedNote(node) || !canAskFromNote(session)) return;
  const docked = {
    position: { x: node.position.x, y: node.position.y },
    view: Object.assign({}, node.view),
  };
  const question = String(node.markdown || "").trim();
  closeNotePopover({ restoreFocus: false, commit: false });
  if (!question || !placeDockedNote(node, rect, { persist: false })) return;
  const converted = convertNoteToAsk(node, question, {
    onRollback: function (restored) {
      restored.position.x = docked.position.x;
      restored.position.y = docked.position.y;
      restored.view = docked.view;
      detachNode(restored);
      const parent = nodes[restored.parent_id];
      renderDockedNotes(parent);
      drawEdges();
    },
  });
  if (!converted) {
    node.position.x = docked.position.x;
    node.position.y = docked.position.y;
    node.view = docked.view;
    detachNode(node);
    renderDockedNotes(nodes[node.parent_id]);
    drawEdges();
    return;
  }
  // A note turned question is an ask like any other: its answer opens beside.
  openBranchBeside(node.id);
}

function deletePopoverNote(session) {
  const doomed = session && session.node;
  if (!doomed) return;
  closeNotePopover({ restoreFocus: false, commit: false });
  removeBranch(doomed);
  renderDockedNotes(nodes[doomed.parent_id]);
}

function onPopoverClick(event) {
  const session = popSession;
  const button = event.target.closest ? event.target.closest("button") : null;
  if (!session || !button) return;
  if (button.classList.contains("note-pop-place")) {
    event.stopPropagation();
    placePopoverNote(session);
  } else if (button.classList.contains("note-pop-ask")) {
    event.stopPropagation();
    askFromPopoverNote(session);
  } else if (button.classList.contains("note-pop-delete")) {
    event.stopPropagation();
    deletePopoverNote(session);
  }
}

function onPopoverKeydown(event) {
  const session = popSession,
    surface = popEl();
  if (!session || session.state !== "read" || !surface.contains(document.activeElement) || !editingAllowed()) return;
  const commandEnter =
    event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && !event.isComposing;
  const deleteKey =
    (event.key === "Backspace" || event.key === "Delete") &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey;
  if (!commandEnter && !deleteKey) return;
  event.preventDefault();
  event.stopPropagation();
  if (commandEnter) placePopoverNote(session);
  else deletePopoverNote(session);
}

function onPopoverDblClick(event) {
  if (!popSession || popSession.state === "edit" || !editingAllowed()) return;
  if (!event.target.closest || !event.target.closest(".note-pop-view")) return;
  event.preventDefault();
  event.stopPropagation();
  renderPopoverState("edit");
}

/* Escape gives back one level at a time: an edit reverts to the note as saved,
   the read state closes the dialog. */
function onPopoverEscape() {
  if (!popSession) return;
  if (popSession.state === "edit") {
    popSession.controller.replaceMarkdown(popSession.node.markdown || "");
    renderPopoverState("read");
    focusPopover();
    return;
  }
  closeNotePopover({ commit: false });
}
