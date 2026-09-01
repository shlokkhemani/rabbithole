import { BRANCH_FOLLOWUP, branchTypeOfNode, isDockedNote } from "../core/hole/ask.js";
import { truncate } from "../core/hole/lens.js";
import { lineageNodesFromMap } from "../core/hole/tree.js";
import { iconSvg } from "../core/html/icons.js";
import { escapeHtml } from "../core/utils.js";
import { presetLabelForOrigin } from "./ask-presets.js";
import {
  breadcrumbEl,
  buildDocContent,
  changeNodeFontScale,
  childrenOf,
  currentNodeId,
  goToNode,
  mode,
  motionSourceFromEvent,
  nodes,
  playLandingCue,
  READER_BASE,
  readerMain,
  sessionPhase,
  setCurrentNodeId,
  setModeValue,
  world,
} from "./core.js";
import { createModuleLifecycle } from "./kit/scope.js";
import { flyReaderFromRect } from "./mode-transition.js";
import { appendOriginAttachmentThumbnails, originAttachmentNames } from "./origin-attachments.js";
import { buildOriginCrop } from "./origin-provenance.js";
import { captureContentPosition, restoreContentPosition } from "./scroll-position.js";
import { applyChildHighlights, transitionMarkGroups } from "./text-marks.js";
import { mountVisuals } from "./visuals.js";

function anchorStart(node) {
  return Number.isFinite(node.origin?.anchor?.offset_start) ? node.origin.anchor.offset_start : 1e9;
}

function isFollowup(node) {
  return branchTypeOfNode(node) === BRANCH_FOLLOWUP;
}

function lensBadgeHtml(origin) {
  return '<span class="lens-badge">' + escapeHtml(presetLabelForOrigin(origin)) + "</span>";
}

function defaultReaderHooks() {
  return {
    hideAsk: function () {},
    updateComposerState: function () {},
    scheduleViewSave: function () {},
    setMode: function () {},
    raiseCard: function () {},
    mountDocImages: null,
    animateScroll: function () {},
    // Docked notes belong to the document on screen; the reader gives them its
    // real right margin and asks their module to fill it.
    renderDockedNotes: function () {},
  };
}

const readerLifecycle = createModuleLifecycle({ defaults: defaultReaderHooks });

let breadcrumbNodes = {};
let noteNodes = {};

export function returnToCanvas() {
  if (mode === "canvas") return null;
  const card = nodes[currentNodeId] && nodes[currentNodeId].el;
  if (card) readerLifecycle.hooks.raiseCard(card);
  readerLifecycle.hooks.setMode("canvas");
  return card;
}

function marginNotesLayer() {
  return document.getElementById("margin-notes");
}

// ===========================================================================
// READER
// ===========================================================================
export function openNode(id) {
  if (!nodes[id]) return;
  const fromCanvas = document.body.classList.contains("mode-canvas");
  const transferredPosition = fromCanvas ? captureContentPosition(nodes[id].bodyEl) : null;
  // The reader rises out of the card it came from — capture the card's
  // on-screen rect while the canvas is still up so the flight anchors there.
  let cardRect = null;
  if (fromCanvas && nodes[id].el) {
    const r = nodes[id].el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) cardRect = r;
  }
  // Snapshot the outgoing document's position (belt & braces alongside the
  // scroll listener) so every window keeps its place when you come back.
  // Only while the reader is actually visible — hidden (canvas mode) it
  // reads 0 and would clobber the position saved on the way out.
  const prev = nodes[currentNodeId];
  if (prev && !document.body.classList.contains("mode-canvas")) prev._scrollTop = readerMain.scrollTop;
  setCurrentNodeId(id);
  setModeValue("reader");
  document.body.classList.remove("mode-canvas");
  readerLifecycle.hooks.hideAsk();
  kbdMarkIdx = -1;
  renderBreadcrumb();
  renderReaderBody();
  if (transferredPosition) {
    restoreContentPosition(readerMain, transferredPosition);
    nodes[id]._scrollTop = readerMain.scrollTop;
  }
  renderMarginNotes();
  readerLifecycle.hooks.updateComposerState();
  readerLifecycle.hooks.scheduleViewSave();
  if (fromCanvas) flyReaderFromRect(cardRect);
}

export function renderBreadcrumb() {
  const path = lineageNodesFromMap(nodes, currentNodeId);
  const fragment = document.createDocumentFragment();
  // The trail starts one level above every document: the canvas itself.
  // Spatially the reader sits *on* the map, so "up" from any lineage is out.
  let home = breadcrumbNodes.__canvas;
  if (!home) {
    home = document.createElement("span");
    home.className = "crumb crumb-canvas";
    home.innerHTML = iconSvg("canvas", { size: 13 }) + "Canvas";
    home.title = "Back to canvas";
    home.setAttribute("role", "link");
    home.setAttribute("aria-label", "Back to canvas");
    home.tabIndex = 0;
    home._sep = document.createElement("span");
    home._sep.className = "crumb-sep";
    home._sep.textContent = "›";
    breadcrumbNodes.__canvas = home;
  }
  fragment.appendChild(home);
  fragment.appendChild(home._sep);
  path.forEach(function (n, i) {
    let crumb = breadcrumbNodes[n.id];
    if (!crumb) {
      crumb = document.createElement("span");
      crumb.className = "crumb";
      crumb.dataset.id = n.id;
      crumb._sep = document.createElement("span");
      crumb._sep.className = "crumb-sep";
      crumb._sep.textContent = "›";
      breadcrumbNodes[n.id] = crumb;
    }
    const cur = i === path.length - 1;
    crumb.textContent = n.title || "Untitled";
    crumb.classList.toggle("current", cur);
    if (cur) {
      crumb.removeAttribute("role");
      crumb.removeAttribute("tabindex");
      crumb.setAttribute("aria-current", "page");
    } else {
      crumb.setAttribute("role", "link");
      crumb.tabIndex = 0;
      crumb.removeAttribute("aria-current");
    }
    if (i > 0) fragment.appendChild(crumb._sep);
    fragment.appendChild(crumb);
  });
  breadcrumbEl.replaceChildren(fragment);
}
export function initReader(hooks) {
  readerLifecycle.register(hooks);
  disposeReaderResources(false);
  const readerScope = readerLifecycle.beginInit();
  try {
    readerScope.listen(breadcrumbEl, "click", function (e) {
      const c = e.target.closest(".crumb");
      if (!c || c.classList.contains("current")) return;
      if (c.classList.contains("crumb-canvas")) return returnToCanvas();
      openNode(c.dataset.id);
    });
    readerScope.listen(breadcrumbEl, "keydown", function (e) {
      if (e.key !== "Enter") return;
      const c = e.target.closest && e.target.closest('.crumb[role="link"]');
      if (!c) return;
      e.preventDefault();
      if (c.classList.contains("crumb-canvas")) return returnToCanvas();
      openNode(c.dataset.id);
    });
    readerScope.listen(readerMain, "scroll", onReaderScroll, { passive: true });
    readerScope.listen(readerMain, "click", onMarkClick);
    readerScope.listen(readerMain, "keydown", onMarkKeydown);
    readerScope.listen(readerMain, "mouseover", function (e) {
      transitionMarkGroups(e, true, "mark-hover");
    });
    readerScope.listen(readerMain, "mouseout", function (e) {
      transitionMarkGroups(e, false, "mark-hover");
    });
    readerScope.listen(readerMain, "focusin", function (e) {
      transitionMarkGroups(e, true, "mark-dom-focus");
    });
    readerScope.listen(readerMain, "focusout", function (e) {
      transitionMarkGroups(e, false, "mark-dom-focus");
    });
    // Canvas marks dive to the answer card in place — never yank into the reader.
    readerScope.listen(world, "click", onCanvasMarkClick);
    readerScope.listen(world, "keydown", onCanvasMarkKeydown);
    const notes = marginNotesLayer();
    readerScope.listen(notes, "click", onNoteClick);
    readerScope.listen(notes, "keydown", onNoteKeydown);
    // Hovering a margin note lights its highlight so the pair reads as one.
    readerScope.listen(notes, "mouseover", function (e) {
      syncNoteHover(e, true);
    });
    readerScope.listen(notes, "mouseout", function (e) {
      syncNoteHover(e, false);
    });
    readerScope.listen(document.getElementById("r-textdown"), "click", function () {
      changeNodeFontScale(nodes[currentNodeId], -0.1);
    });
    readerScope.listen(document.getElementById("r-textup"), "click", function () {
      changeNodeFontScale(nodes[currentNodeId], 0.1);
    });
    // Back to canvas lives in the taskbar's session cluster. It collapses the
    // reader back into its card and hands focus to the card's expand button,
    // so keyboard travel round-trips cleanly.
    readerScope.listen(document.getElementById("reader-restore"), "click", function () {
      const card = returnToCanvas();
      const expand = card && card.querySelector('[aria-label="Expand document"]');
      if (expand) {
        try {
          expand.focus({ preventScroll: true });
        } catch (e) {
          expand.focus();
        }
      }
    });
    return disposeReader;
  } catch (error) {
    disposeReader();
    throw error;
  }
}

export function disposeReader() {
  disposeReaderResources(true);
}

function disposeReaderResources(resetHooks) {
  readerLifecycle.dispose(resetHooks);
  breadcrumbNodes = {};
  noteNodes = {};
  kbdMarkIdx = -1;
}

export function renderReaderBody() {
  const node = nodes[currentNodeId];
  const previous = readerMain.querySelector(".doc-content");
  if (previous && previous._rhDispose) previous._rhDispose();
  readerMain.innerHTML = "";
  const col = document.createElement("div");
  col.className = "reader-col";
  // The lineage trail leads the document column and scrolls with it — the
  // floating taskbar above carries no per-document state.
  if (breadcrumbEl) col.appendChild(breadcrumbEl);
  if (node.origin && (node.origin.selected_text || node.origin.question || originAttachmentNames(node).length)) {
    const ctx = document.createElement("div");
    ctx.className = "reader-context";
    if (node.origin.selected_text) {
      const tail = node.origin.lens
        ? " — " + lensBadgeHtml(node.origin)
        : node.origin.question
          ? " — " + escapeHtml(node.origin.question)
          : "";
      ctx.innerHTML =
        '<span class="rc-label">From</span>“' +
        escapeHtml(truncate(node.origin.selected_text, 200)) +
        "”" +
        tail +
        '<span class="rc-go">→</span>';
    } else {
      ctx.innerHTML =
        '<span class="rc-label">Follow-up</span>' +
        (node.origin.lens
          ? lensBadgeHtml(node.origin) + (node.origin.question ? " " + escapeHtml(node.origin.question) : "")
          : escapeHtml(node.origin.question || "Pasted image"));
    }
    appendOriginAttachmentThumbnails(ctx, node);
    // The strip is a live link: click it to land on the exact spot in the
    // parent this branch grew from (flashed so the eye finds it).
    if (node.parent_id && nodes[node.parent_id]) {
      ctx.classList.add("linked");
      ctx.title = "See this in its original context";
      ctx.setAttribute("role", "link");
      ctx.tabIndex = 0;
      ctx.setAttribute("aria-label", "See this in its original context");
      ctx.addEventListener("click", function (e) {
        jumpToOrigin(node, motionSourceFromEvent(e));
      });
      ctx.addEventListener("keydown", function (e) {
        if (e.key !== "Enter") return;
        e.preventDefault();
        jumpToOrigin(node, "keyboard");
      });
    }
    col.appendChild(ctx);
  }
  const crop = buildOriginCrop(node, "reader");
  if (crop) col.appendChild(crop);
  const dc = buildDocContent(node, READER_BASE);
  col.appendChild(dc);
  applyChildHighlights(dc, node);
  const isPdfReader = dc.classList.contains("rh-pdf");
  const isPdfViewport = isPdfReader && !node.parent_id && !crop;
  readerMain.classList.toggle("pdf-reader", isPdfReader);
  readerMain.classList.toggle("pdf-reader-viewport", isPdfViewport);
  col.classList.toggle("pdf-reader-col", isPdfReader);
  col.classList.toggle("pdf-reader-viewport", isPdfViewport);
  readerMain.appendChild(col);
  readerLifecycle.hooks.renderDockedNotes(node);
  // Each document remembers where you were; a first open starts at the top.
  readerMain.scrollTop = node._scrollTop || 0;
}
// Open the parent and land on the exact origin when this branch is anchored.
export function jumpToOrigin(node, source) {
  const parent = nodes[node.parent_id];
  if (!parent) return;
  openNode(parent.id);
  const target = readerMain.querySelector(
    '[data-child="' + node.id + '"].rh-pdf-mark, mark[data-child="' + node.id + '"]',
  );
  if (!target) return;
  scrollMarkIntoView(target, 0.38, source);
  const marks = readerMain.querySelectorAll(
    '[data-child="' + node.id + '"].rh-pdf-mark, mark[data-child="' + node.id + '"]',
  );
  for (let i = 0; i < marks.length; i++) playLandingCue(marks[i], "mark-flash");
}

function scrollMarkIntoView(mark, viewportRatio, source) {
  let scroller = mark.closest && mark.closest(".rh-pdf-scroll");
  if (!scroller) scroller = readerMain;
  const top = mark.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  readerLifecycle.hooks.animateScroll(scroller, Math.max(0, top - scroller.clientHeight * viewportRatio), source);
}
function onReaderScroll() {
  const n = nodes[currentNodeId];
  if (n) n._scrollTop = readerMain.scrollTop;
  readerLifecycle.hooks.scheduleViewSave();
}

// A mark takes you to its branch — unless the branch is a docked note, whose
// whole point is that there is nowhere to go: its own module opens it in place.
function onMarkClick(e) {
  const m = e.target.closest("[data-child].rh-pdf-mark, mark[data-child]");
  if (!m) return;
  if (!window.getSelection().isCollapsed) return; // user was selecting, not clicking
  const k = nodes[m.dataset.child];
  // Pending branches open too — the reader shows the answer streaming in live.
  if (k && !isDockedNote(k)) openNode(k.id);
}
function onMarkKeydown(e) {
  if (e.key !== "Enter") return;
  const m = e.target.closest && e.target.closest("[data-child].rh-pdf-mark, mark[data-child]");
  if (!m) return;
  const k = nodes[m.dataset.child];
  if (!k || isDockedNote(k)) return;
  e.preventDefault();
  openNode(k.id);
}
function onCanvasMarkClick(e) {
  const m = e.target.closest && e.target.closest("mark[data-child]");
  if (!m) return;
  if (!window.getSelection().isCollapsed) return; // the human was selecting, not clicking
  const k = nodes[m.dataset.child];
  if (k && !isDockedNote(k)) goToNode(k, motionSourceFromEvent(e));
}
function onCanvasMarkKeydown(e) {
  if (e.key !== "Enter") return;
  const m = e.target.closest && e.target.closest("mark[data-child]");
  if (!m) return;
  const k = nodes[m.dataset.child];
  if (!k || isDockedNote(k)) return;
  e.preventDefault();
  goToNode(k, motionSourceFromEvent(e));
}
// Every direct branch has one stable card in the Reader rail. Anchored
// comments lead, in document order; general follow-ups follow in creation
// order. Keeping one surface for both is especially important for PDFs,
// whose own scroller cannot share an old absolute text margin.
export function renderMarginNotes() {
  const layer = marginNotesLayer();
  if (!layer) return;
  // Docked notes are not branches: they already show themselves in the
  // margin beside the very words they mark.
  const kids = childrenOf(currentNodeId)
    .filter(function (k) {
      return !isDockedNote(k);
    })
    .sort(function (a, b) {
      const aAnchored = !!(a.origin && a.origin.anchor),
        bAnchored = !!(b.origin && b.origin.anchor);
      if (aAnchored !== bAnchored) return aAnchored ? -1 : 1;
      return (aAnchored ? anchorStart(a) - anchorStart(b) : 0) || (a._order || 0) - (b._order || 0);
    });
  const fragment = document.createDocumentFragment();
  const newLivePanes = [];
  kids.forEach(function (k) {
    const pending = k.status !== "answered";
    const qHtml =
      k.origin && k.origin.lens
        ? lensBadgeHtml(k.origin) + (k.origin.question ? " " + escapeHtml(k.origin.question) : "")
        : escapeHtml(k.origin && k.origin.question ? k.origin.question : k.title || "Untitled");
    const quote = k.origin && k.origin.selected_text ? k.origin.selected_text : "";
    const status = pending ? pendingStatusHtml(k) : "open →";
    let tile = noteNodes[k.id];
    if (!tile) {
      tile = document.createElement("div");
      tile.className = "side-item";
      tile.dataset.child = k.id;
      tile.setAttribute("role", "link");
      tile.tabIndex = 0;
      tile._question = document.createElement("div");
      tile._question.className = "si-q";
      tile._quote = document.createElement("div");
      tile._quote.className = "si-quote";
      tile._status = document.createElement("div");
      tile._status.className = "si-status";
      tile.append(tile._question, tile._quote, tile._status);
      noteNodes[k.id] = tile;
    }
    tile.classList.toggle("pending", pending);
    tile.classList.toggle("followup", isFollowup(k));
    tile._question.innerHTML = qHtml;
    appendOriginAttachmentThumbnails(tile._question, k);
    tile._quote.textContent = quote ? "“" + truncate(quote, 80) + "”" : "";
    tile._quote.hidden = !quote;
    tile._status.innerHTML = status;
    const name = (k.origin && k.origin.question) || k.title || "Untitled";
    tile.setAttribute("aria-label", "Open branch: " + name + (pending ? ", pending" : ""));
    // A streaming answer is watchable right here: its last lines render live
    // inside the note (and the whole note opens the full streaming view).
    if (pending && k.html) {
      if (!tile._live) {
        tile._live = document.createElement("div");
        tile._live.className = "si-live";
        tile._livePane = document.createElement("div");
        tile._livePane.className = "md";
        tile._live.appendChild(tile._livePane);
        tile.appendChild(tile._live);
        newLivePanes.push({ pane: tile._livePane, node: k });
      }
      tile._livePane.innerHTML = k.html;
    } else if (tile._live) {
      tile._live.remove();
      tile._live = null;
      tile._livePane = null;
    }
    fragment.appendChild(tile);
  });
  if (!kids.length) {
    const empty = document.createElement("div");
    empty.className = "reader-rail-empty";
    empty.textContent = "No branches yet";
    fragment.appendChild(empty);
  }
  layer.replaceChildren(fragment);
  const count = document.getElementById("reader-rail-count");
  if (count) count.textContent = String(kids.length);
  const rail = document.getElementById("reader-rail");
  if (rail) rail.classList.toggle("empty", !kids.length);
  mountNoteVisuals(newLivePanes);
}
function onNoteClick(e) {
  const it = e.target.closest && e.target.closest("#margin-notes .side-item");
  if (!it) return;
  openNode(it.dataset.child); // pending notes open too — the answer streams there
}
function onNoteKeydown(e) {
  if (e.key !== "Enter") return;
  const it = e.target.closest && e.target.closest('#margin-notes .side-item[role="link"]');
  if (!it) return;
  e.preventDefault();
  openNode(it.dataset.child);
}
function syncNoteHover(e, on) {
  const tile = e.target.closest && e.target.closest("#margin-notes .side-item");
  if (!tile) return;
  const related = e.relatedTarget;
  if (related && tile.contains(related)) return;
  const marks = readerMain.querySelectorAll(
    '[data-child="' + tile.dataset.child + '"].rh-pdf-mark, mark[data-child="' + tile.dataset.child + '"]',
  );
  for (let i = 0; i < marks.length; i++) marks[i].classList.toggle("mark-focus", on);
}
function mountNoteVisuals(panes) {
  for (let i = 0; i < panes.length; i++) {
    const key = "margin-notes:" + panes[i].node.id;
    mountVisuals(panes[i].pane, key);
    if (typeof readerLifecycle.hooks.mountDocImages === "function")
      readerLifecycle.hooks.mountDocImages(panes[i].pane, key);
  }
}
function pendingStatusHtml(k) {
  const copy = {
    frozen: '<span class="si-muted">unanswered in this snapshot</span>',
    closed: '<span class="si-muted">saved — answered when you reopen</span>',
    away: '<span class="si-muted">saved — waiting for the agent</span>',
    live:
      k && k.queued
        ? '<span class="shimmer-text">Waiting for previous answer</span>'
        : k && k.delegated
          ? '<span class="shimmer-text">Working in sub-agent…</span>'
          : k && k.html
            ? '<span class="shimmer-text">Writing…</span>'
            : '<span class="shimmer-text">Thinking…</span>',
  };
  return copy[sessionPhase()];
}
// j/k focus ring over the current document's anchored branches.
let kbdMarkIdx = -1;
function allMarks() {
  return readerMain.querySelectorAll("[data-child].rh-pdf-mark, mark[data-child]");
}
export function focusedMark() {
  const marks = allMarks();
  return kbdMarkIdx >= 0 && kbdMarkIdx < marks.length ? marks[kbdMarkIdx] : null;
}
export function stepMark(delta) {
  const marks = allMarks();
  if (!marks.length) return;
  const prev = focusedMark();
  if (prev) prev.classList.remove("mark-focus");
  kbdMarkIdx =
    kbdMarkIdx < 0 ? (delta > 0 ? 0 : marks.length - 1) : Math.max(0, Math.min(marks.length - 1, kbdMarkIdx + delta));
  const m = marks[kbdMarkIdx];
  m.classList.add("mark-focus");
  scrollMarkIntoView(m, 0.42, "keyboard");
}
