import { isDockedNote, isReactionNote } from "../core/hole/ask.js";
import { truncate } from "../core/hole/lens.js";
import { lineageNodesFromMap } from "../core/hole/tree.js";
import { iconSvg } from "../core/html/icons.js";
import { escapeHtml } from "../core/utils.js";
import { presetLabelForOrigin } from "./ask-presets.js";
import {
  buildDocContent,
  changeNodeFontScale,
  childrenOf,
  composerInner,
  currentNodeId,
  goToNode,
  mode,
  motionSourceFromEvent,
  nodes,
  playLandingCue,
  READER_BASE,
  readerMain,
  setCurrentNodeId,
  setModeValue,
  surfaceFontScale,
  world,
} from "./core.js";
import { createModuleLifecycle } from "./kit/scope.js";
import { flyReaderFromRect } from "./mode-transition.js";
import { appendOriginAttachmentThumbnails, originAttachmentNames } from "./origin-attachments.js";
import { buildOriginCrop } from "./origin-provenance.js";
import { holdFullLayout, putPlaces, readPlaces, reflowKeepingPlace, setScrollPlace } from "./scroll-position.js";
import { applyChildHighlights, transitionMarkGroups } from "./text-marks.js";
import { revealPosition } from "./trail/layout.js";
import { createTrailStage } from "./trail/stage.js";

/*
 * The reader is a trail. Reading one document and asking about it opens the
 * answer beside it; asking inside the answer opens the next one beside that.
 * The trail is always one lineage — root to the deepest open answer — and
 * opening a branch from any pane replaces everything to its right. Panes
 * slide and fold into spines; they never resize, so the words you are reading
 * never move. See trail/layout.js for the geometry and trail/stage.js for the
 * motion.
 */

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
    // Docked notes and branch dots belong to the document on screen; the
    // reader gives each pane a real right margin and asks their module to
    // fill it — and to keep them on their marks as the document re-flows.
    renderDockedNotes: function () {},
    /** @param {Element} _doc */
    watchDocumentLayout: function (_doc) {},
  };
}

const readerLifecycle = createModuleLifecycle({ defaults: defaultReaderHooks });
const COMPACT_QUERY = "(hover: none), (pointer: coarse), (max-width: 760px)";

/** @type {string[]} */
let trail = [];
/**
 * @typedef {{ id: string, el: HTMLElement, scroll: HTMLElement, col: HTMLElement, foot: HTMLElement,
 *   spine: HTMLButtonElement, title: HTMLElement, spineTitle: HTMLElement, back: HTMLButtonElement,
 *   focus: HTMLButtonElement, close: HTMLButtonElement, margin: number, html: string, renderedFrom: string }} ReaderPane
 */
/** @type {Map<string, ReaderPane>} */
let panes = new Map();
/** @type {ReturnType<typeof createTrailStage> | null} */
let stage = null;
// The composer's height: every pane's foot keeps that much room, so moving
// the composer to another document never shifts the one it left.
let composerRoom = 0;
// How much wider than its core every pane is right now (see fitPage).
let lastExtra = 0;
// The pane a click or key walked to: the keyboard follows once it stands open.
let focusOnSettle = "";

export function returnToCanvas() {
  if (mode === "canvas") return null;
  const card = nodes[currentNodeId] && nodes[currentNodeId].el;
  if (card) readerLifecycle.hooks.raiseCard(card);
  readerLifecycle.hooks.setMode("canvas");
  return card;
}

// ---------------------------------------------------------------------------
// Queries other modules use to route live updates to every pane on screen
// ---------------------------------------------------------------------------
export function readerShows(id) {
  return mode === "reader" && panes.has(id);
}
/** The vertical scroller of the pane showing `id` (the current one by default). */
export function readerScroller(id = currentNodeId) {
  const pane = panes.get(id);
  return pane ? pane.scroll : null;
}

// ===========================================================================
// OPENING
// ===========================================================================
/**
 * Bring `id` in front of the reader and make it the document you are in. It
 * joins the trail at its place in the lineage: already on the trail, the
 * trail slides to it; otherwise the trail becomes its lineage.
 */
export function openNode(id) {
  if (!nodes[id] || !stage) return;
  const fromCanvas = document.body.classList.contains("mode-canvas");
  // Every document the reader is about to show opens where its card was
  // read to, read while the canvas still shows it.
  const places = fromCanvas ? readPlaces(trailCandidates(id).map((cid) => [cid, nodes[cid].bodyEl])) : null;
  // The reader rises out of the card it came from — capture the card's
  // on-screen rect while the canvas is still up so the flight anchors there.
  let cardRect = null;
  if (fromCanvas && nodes[id].el) {
    const r = nodes[id].el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) cardRect = r;
  }
  setModeValue("reader");
  document.body.classList.remove("mode-canvas");
  readerLifecycle.hooks.hideAsk();
  if (fromCanvas) {
    // The reader kept every pane while the canvas was up. Only a document
    // that changed meanwhile — an edit, a new mark, an answer landing — is
    // rendered again.
    stage.relayout();
    pruneTrail();
    panes.forEach(function (pane) {
      const node = nodes[pane.id];
      if (node && (pane.html !== node.html || pane.renderedFrom !== renderedFrom(node))) renderPaneBody(pane);
    });
  }
  showWholeTrail();
  showInTrail(id, { focus: true, instant: fromCanvas });
  if (places) {
    putPlaces(places, readerScroller);
    panes.forEach(function (pane) {
      const node = nodes[pane.id];
      if (!node) return;
      // A document with no card to read from keeps its own last place.
      if (!places.has(pane.id) && Math.abs(pane.scroll.scrollTop - (node._scrollTop || 0)) > 1)
        setScrollPlace(pane.scroll, node._scrollTop || 0);
      node._scrollTop = pane.scroll.scrollTop;
      syncBarState(pane);
    });
  }
  readerLifecycle.hooks.scheduleViewSave();
  if (fromCanvas) flyReaderFromRect(cardRect);
}

// The documents a reader opened on `id` can show: the trail it keeps, or
// the lineage it becomes.
function trailCandidates(id) {
  const ids = new Set(trail);
  for (const node of lineageNodesFromMap(nodes, id)) ids.add(node.id);
  return [...ids].filter((cid) => nodes[cid]);
}

/**
 * A new answer opens beside the document it was asked from, without moving
 * that document: it streams in to its right and becomes the pane you are in.
 * Reading alone ends — an answer is read beside its source. A window with
 * room for one pane keeps you where you are, the answer waiting as a tab at
 * the right edge; a phone has no "beside" — its dot in the margin carries it.
 */
export function openBranchBeside(childId) {
  const child = nodes[childId];
  if (!stage || mode !== "reader" || !child || isDockedNote(child) || !panes.has(child.parent_id)) return;
  if (!stage.metrics().spine) {
    syncReaderPanes();
    return;
  }
  showWholeTrail();
  showInTrail(childId, { focus: false, instant: false, keep: child.parent_id });
  setCurrentPane(stage.openCount() > 1 ? childId : child.parent_id);
}

// Opening any answer shows it the default way: beside its source, never alone.
function showWholeTrail() {
  if (stage && stage.focused()) stage.setFocused(false, -1);
}

/** @param {string} id @param {{ focus: boolean, instant: boolean, keep?: string }} options */
function showInTrail(id, { focus, instant, keep: keepId }) {
  pruneTrail();
  const known = trail.indexOf(id);
  if (known < 0) setTrail(lineageNodesFromMap(nodes, id).map((n) => n.id));
  const index = trail.indexOf(id);
  const open = stage.openCount();
  // A document new to the trail lands as its rightmost pane, its source to
  // its left; one already on it is revealed with the least movement.
  const keep = trail.indexOf(keepId || currentNodeId);
  let p = known < 0 ? Math.max(0, index - open + 1) : revealPosition(index, stage.position(), trail.length, open);
  // Opening beside must never slide the asking pane out of view.
  if (!focus && keep >= 0 && keep < p) p = keep;
  stage.moveTo(p, { instant: instant });
  if (focus) setCurrentPane(id);
  syncReaderPanes();
}

/** Close the pane showing `id` and everything deeper. */
export function closePane(id) {
  const index = trail.indexOf(id);
  if (index <= 0 || !stage) return false;
  const currentIndex = trail.indexOf(currentNodeId);
  setTrail(trail.slice(0, index));
  if (currentIndex >= index) setCurrentPane(trail[index - 1]);
  stage.moveTo(Math.min(stage.position(), Math.max(0, trail.length - stage.openCount())));
  syncReaderPanes();
  return true;
}

/**
 * Read one document alone: everything before and after it folds into tabs,
 * and its text keeps its measure. Asking again (or Esc) brings the trail back.
 */
export function toggleFocus(id = currentNodeId) {
  if (!stage || mode !== "reader" || !panes.has(id)) return;
  const focusing = !stage.focused();
  if (focusing && trail.length < 2) return;
  setCurrentPane(id);
  stage.setFocused(focusing, trail.indexOf(id));
  panes.forEach(paintPaneChrome);
}

/** Esc, first: a focused document rejoins its trail. */
export function leaveFocus() {
  if (!stage || mode !== "reader" || !stage.focused()) return false;
  toggleFocus();
  return true;
}

/** Esc: the deepest pane closes first; with one left, there is nothing to close. */
export function closeTipPane() {
  if (mode !== "reader" || trail.length < 2) return false;
  return closePane(trail[trail.length - 1]);
}

/** ← / →: walk the trail one document at a time. */
export function stepPane(delta) {
  if (!stage || mode !== "reader") return;
  const index = trail.indexOf(currentNodeId) + delta;
  if (index < 0 || index >= trail.length) return;
  revealPane(trail[index], true);
}

function revealPane(id, focus) {
  const index = trail.indexOf(id);
  if (index < 0 || !stage) return;
  stage.moveTo(revealPosition(index, stage.position(), trail.length, stage.openCount()));
  if (focus) {
    setCurrentPane(id);
    // A pane opening is inert until it stands open: the keys follow it there.
    focusOnSettle = id;
  }
}

// ===========================================================================
// TRAIL + PANES
// ===========================================================================
function setTrail(ids) {
  let shared = 0;
  while (shared < ids.length && shared < trail.length && ids[shared] === trail[shared]) shared++;
  for (let i = shared; i < trail.length; i++) retirePane(trail[i]);
  for (let i = shared; i < ids.length; i++) {
    const pane = createPane(ids[i]);
    panes.set(ids[i], pane);
    readerMain.appendChild(pane.el);
    renderPaneBody(pane);
  }
  trail = ids.slice();
}

// Drop anything no longer in the document (deleted, undone) from the trail.
function pruneTrail() {
  const gone = trail.findIndex((id) => !nodes[id] || nodes[id]._pendingDelete);
  if (gone < 0) return false;
  setTrail(trail.slice(0, gone));
  if (!panes.has(currentNodeId) && trail.length) setCurrentPane(trail[trail.length - 1]);
  if (stage) stage.moveTo(Math.min(stage.position(), Math.max(0, trail.length - stage.openCount())));
  return true;
}

function retirePane(id) {
  const pane = panes.get(id);
  panes.delete(id);
  if (!pane) return;
  const el = pane.el;
  // The composer belongs to whichever document stays; never let it fade out
  // with this one.
  const shell = composerShell();
  if (shell && pane.foot.contains(shell)) readerMain.parentElement?.appendChild(shell);
  el.inert = true;
  el.classList.remove("current");
  el.classList.add("pane-leaving");
  let done = false;
  const finish = function () {
    if (done) return;
    done = true;
    disposeDoc(pane.col);
    el.remove();
  };
  el.addEventListener("animationend", finish, { once: true });
  // Reduced motion (or a hidden window) never fires animationend.
  readerLifecycle.scope?.timeout(finish, 400);
}

function disposeDoc(col) {
  const doc = /** @type {(HTMLElement & { _rhDispose?: () => void }) | null} */ (col.querySelector(".doc-content"));
  if (doc && doc._rhDispose) doc._rhDispose();
}

/** @returns {ReaderPane} */
function createPane(id) {
  const node = nodes[id];
  const el = document.createElement("section");
  el.className = "reader-pane pane-entering";
  el.dataset.nodeId = id;
  el.setAttribute("aria-label", node.title || "Untitled");
  el.addEventListener(
    "animationend",
    function () {
      el.classList.remove("pane-entering");
    },
    { once: true },
  );

  const scroll = document.createElement("div");
  scroll.className = "pane-scroll";
  scroll.tabIndex = -1;

  const bar = document.createElement("header");
  bar.className = "pane-bar";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "pane-back";
  back.innerHTML = iconSvg("chevron", { size: 16 });
  const title = document.createElement("span");
  title.className = "pane-title";
  const focus = document.createElement("button");
  focus.type = "button";
  focus.className = "pane-focus";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "pane-close";
  close.innerHTML = iconSvg("close", { size: 16 });
  bar.append(back, title, focus, close);

  const col = document.createElement("div");
  col.className = "reader-col";
  // Where the composer rests when this is the document you are in: after
  // the last line, never over it.
  const foot = document.createElement("div");
  foot.className = "pane-foot";
  scroll.append(bar, col, foot);

  const spine = document.createElement("button");
  spine.type = "button";
  spine.className = "pane-spine";
  spine.tabIndex = -1;
  const spineTitle = document.createElement("span");
  spineTitle.className = "pane-spine-title";
  spine.appendChild(spineTitle);

  el.append(scroll, spine);
  const pane = {
    id,
    el,
    scroll,
    col,
    foot,
    spine,
    title,
    spineTitle,
    back,
    focus,
    close,
    margin: -1,
    html: "",
    renderedFrom: "",
  };
  sizeFoot(pane);
  return pane;
}

// A document never reads narrower than two side by side do (base.css widens
// it with its pane from there): the window alone decides that floor.
function setMeasure(metrics) {
  readerMain.style.setProperty("--trail-floor", Math.max(0, metrics.column).toFixed(2) + "px");
}

// A pane changing width may re-wrap its text: everyone keeps reading the line
// they were on, frame by frame.
function keepPlaces(resize) {
  const scrollers = [];
  panes.forEach(function (pane) {
    if (pane.scroll.scrollTop > 0) scrollers.push(pane.scroll);
  });
  reflowKeepingPlace(scrollers, resize, { full: false });
}

function isPageViewport(pane) {
  return pane.el.classList.contains("pdf-reader-viewport");
}

// A page fits its width, so every change of width re-renders it. While the
// trail moves, a page keeps the width it was fitted to (centred, or clipped
// at its edges for a moment); it refits once, when the trail comes to rest.
function fitPage(pane, extra, settled) {
  const col = pane.col.style;
  if (settled || pane.margin < 0 || !stage) {
    pane.margin = extra;
    col.width = col.marginLeft = col.flexShrink = "";
    return;
  }
  col.width = (stage.metrics().paneWidth + pane.margin).toFixed(2) + "px";
  col.marginLeft = ((extra - pane.margin) / 2).toFixed(2) + "px";
  col.flexShrink = "0";
}

function sizeFoot(pane) {
  pane.foot.style.minHeight = composerRoom ? composerRoom + "px" : "";
}

// Everything a pane's rendering depends on besides the document's HTML.
function renderedFrom(node) {
  const marks = childrenOf(node.id)
    .map(function (child) {
      return child.id + ":" + child.status + (isReactionNote(child) ? ":r" : "") + (child.origin?.anchor ? ":a" : "");
    })
    .join(",");
  return [
    node.status,
    node.error?.message || "",
    node.source?.converting ? 1 : 0,
    surfaceFontScale(node, "reader"),
    marks,
  ].join("|");
}

function renderPaneBody(pane) {
  const node = nodes[pane.id];
  if (!node) return;
  const col = pane.col;
  disposeDoc(col);
  col.replaceChildren();
  const context = buildContextStrip(node);
  if (context) col.appendChild(context);
  const crop = buildOriginCrop(node, "reader");
  if (crop) col.appendChild(crop);
  const dc = buildDocContent(node, READER_BASE);
  pane.html = node.html;
  pane.renderedFrom = renderedFrom(node);
  col.appendChild(dc);
  applyChildHighlights(dc, node, false);
  readerLifecycle.hooks.watchDocumentLayout(dc);
  const isPdfReader = dc.classList.contains("rh-pdf");
  // A root PDF is already a complete reading surface: its own scroller fills
  // the pane. Threaded PDFs keep the normal flow so their origin stays visible.
  const isPdfViewport = isPdfReader && !node.parent_id && !crop;
  pane.el.classList.toggle("pdf-reader", isPdfReader);
  pane.el.classList.toggle("pdf-reader-viewport", isPdfViewport);
  col.classList.toggle("pdf-reader-col", isPdfReader);
  col.classList.toggle("pdf-reader-viewport", isPdfViewport);
  pane.margin = -1;
  if (isPdfViewport) fitPage(pane, lastExtra, false);
  else pane.col.style.width = pane.col.style.marginLeft = pane.col.style.flexShrink = "";
  readerLifecycle.hooks.renderDockedNotes(node);
  paintPaneChrome(pane);
  // Each document remembers where you were; a first open starts at the top.
  // A place is set only where it can be laid out: a pane built behind the
  // canvas takes its place (and its bar follows) when the reader opens.
  if (mode === "reader") {
    setScrollPlace(pane.scroll, node._scrollTop || 0);
    syncBarState(pane);
  }
}

// Asks whose whole strip the reader chose to see. Kept across re-renders: an
// answer re-renders as it streams and when a new ask marks it.
const openedStrips = new Set();

function buildContextStrip(node) {
  if (!node.origin || !(node.origin.selected_text || node.origin.question || originAttachmentNames(node).length))
    return null;
  const ctx = document.createElement("div");
  ctx.className = "reader-context";
  const text = document.createElement("div");
  text.className = "rc-text";
  if (node.origin.selected_text) {
    const tail = node.origin.lens
      ? " — " + lensBadgeHtml(node.origin)
      : node.origin.question
        ? " — " + escapeHtml(node.origin.question)
        : "";
    text.innerHTML =
      '<span class="rc-label">From</span>“' +
      escapeHtml(truncate(node.origin.selected_text, 200)) +
      "”" +
      tail +
      '<span class="rc-go">→</span>';
  } else {
    text.innerHTML =
      '<span class="rc-label">Follow-up</span>' +
      (node.origin.lens
        ? lensBadgeHtml(node.origin) + (node.origin.question ? " " + escapeHtml(node.origin.question) : "")
        : escapeHtml(node.origin.question || "Pasted image"));
  }
  ctx.appendChild(text);
  // A long ask shows its first lines; the rest is a click away. The toggle
  // shows only while there is more than the clamp holds.
  const more = document.createElement("button");
  more.type = "button";
  more.className = "rc-more";
  const paintMore = function () {
    const open = openedStrips.has(node.id);
    ctx.classList.toggle("open", open);
    more.setAttribute("aria-expanded", String(open));
    more.innerHTML = (open ? "Less" : "More") + iconSvg("chevron", { size: 12 });
    if (!open) more.hidden = text.scrollHeight <= text.clientHeight + 1;
  };
  more.addEventListener("click", function (e) {
    e.stopPropagation();
    if (openedStrips.has(node.id)) openedStrips.delete(node.id);
    else openedStrips.add(node.id);
    paintMore();
  });
  new ResizeObserver(paintMore).observe(text);
  paintMore();
  ctx.appendChild(more);
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
      if (e.key !== "Enter" || e.target !== ctx) return;
      e.preventDefault();
      jumpToOrigin(node, "keyboard");
    });
  }
  return ctx;
}

/** Re-render the document in the pane showing `id` (the current one by default). */
export function renderReaderBody(id = currentNodeId) {
  const pane = panes.get(id);
  if (!pane) return;
  const scroll = pane.scroll;
  const keep = scroll.scrollTop;
  renderPaneBody(pane);
  // A rebuild briefly collapses the scroll height; the reader's place holds.
  if (keep) setScrollPlace(scroll, keep);
  markOpenBranches();
}

// Titles, controls and open-branch marks for every pane: cheap, idempotent,
// and safe to call after any change to the tree.
export function syncReaderPanes() {
  if (!stage) return;
  pruneTrail();
  panes.forEach(function (pane, id) {
    const node = nodes[id];
    if (!node) return;
    readerLifecycle.hooks.renderDockedNotes(node);
    paintPaneChrome(pane);
  });
  markOpenBranches();
}

function paintPaneChrome(pane) {
  const node = nodes[pane.id];
  const index = trail.indexOf(pane.id);
  const name = (node && node.title) || "Untitled";
  pane.title.textContent = name;
  pane.spineTitle.textContent = name;
  pane.el.setAttribute("aria-label", name);
  pane.spine.setAttribute("aria-label", "Show " + name);
  pane.close.setAttribute("aria-label", "Close " + name);
  pane.close.title = "Close · Esc";
  pane.close.hidden = index <= 0;
  const focused = !!stage && stage.focused();
  pane.focus.hidden = !stage || !stage.metrics().spine || (!focused && trail.length < 2);
  pane.focus.innerHTML = iconSvg(focused ? "contract" : "expand", { size: 14 });
  pane.focus.setAttribute("aria-label", focused ? "Show the whole trail" : "Read " + name + " alone");
  pane.focus.title = focused ? "Show the trail · F" : "Read alone · F";
  pane.focus.setAttribute("aria-pressed", String(focused));
  const parent = node && nodes[node.parent_id];
  pane.back.hidden = !parent;
  pane.back.setAttribute("aria-label", "Back to " + ((parent && parent.title) || "Untitled"));
  pane.el.classList.toggle("current", pane.id === currentNodeId);
}

// The mark a branch grew from stays lit while its answer is open beside it.
function markOpenBranches() {
  for (let i = 0; i < trail.length; i++) {
    const pane = panes.get(trail[i]);
    if (!pane) continue;
    const open = trail[i + 1] || "";
    /** @type {NodeListOf<HTMLElement>} */
    const marks = pane.col.querySelectorAll("[data-child].rh-pdf-mark, mark[data-child]");
    for (let j = 0; j < marks.length; j++) marks[j].classList.toggle("mark-open", marks[j].dataset.child === open);
  }
}

// The document you are in: its pane carries the composer, the text size
// controls and the keyboard. Pointing at or focusing a pane makes it current.
function setCurrentPane(id) {
  if (!panes.has(id)) return;
  const changed = id !== currentNodeId;
  setCurrentNodeId(id);
  if (changed) kbdMarkIdx = -1;
  panes.forEach(function (pane) {
    pane.el.classList.toggle("current", pane.id === id);
  });
  placeComposer();
  readerLifecycle.hooks.updateComposerState();
  readerLifecycle.hooks.scheduleViewSave();
}

function composerShell() {
  return composerInner ? composerInner.parentElement : null;
}

// The composer asks about the current document, so it rests at that
// document's end — where a reader who has finished it arrives — and moves
// with the document you are in. Every foot keeps its room, so the documents
// it leaves never shift.
function placeComposer() {
  const shell = composerShell();
  const pane = panes.get(currentNodeId);
  if (!shell || !pane || pane.foot.contains(shell)) return;
  pane.foot.appendChild(shell);
}

// Every frame: prose follows its pane (see keepPlaces); a page holds the width
// it was fitted to until the trail rests.
function onStageFrame(_frames, _metrics, extra) {
  lastExtra = extra;
  panes.forEach(function (pane) {
    if (isPageViewport(pane)) fitPage(pane, extra, false);
  });
}

function onStageSettle() {
  panes.forEach(function (pane) {
    if (isPageViewport(pane)) fitPage(pane, lastExtra, true);
  });
  // A swipe may have carried the current pane out of view: the pane now in
  // front of you becomes the one you are in.
  const frames = stage.frames();
  const index = trail.indexOf(currentNodeId);
  const open = frames.map((f) => f.exposed >= f.box - 1);
  if (index < 0 || !open[index]) {
    let best = -1;
    for (let i = 0; i < open.length; i++) {
      if (open[i] && (best < 0 || Math.abs(i - index) < Math.abs(best - index))) best = i;
    }
    if (best >= 0) setCurrentPane(trail[best]);
  }
  const keys = focusOnSettle;
  focusOnSettle = "";
  const scroller = keys === currentNodeId ? readerScroller(keys) : null;
  const active = document.activeElement;
  if (scroller && (!active || active === document.body || readerMain.contains(active))) focusQuietly(scroller);
  document.dispatchEvent(new CustomEvent("rh-reader-layout"));
}

function onStageMetrics(metrics) {
  setMeasure(metrics);
  panes.forEach(function (pane) {
    pane.margin = -1;
    if (isPageViewport(pane)) fitPage(pane, lastExtra, false);
    paintPaneChrome(pane);
  });
}

// The bar is quiet over the document's own title and becomes a title bar only
// once that title has scrolled away.
function syncBarState(pane) {
  const top = pane.scroll.scrollTop;
  pane.el.classList.toggle("pane-scrolled", top > 4);
  pane.el.classList.toggle("pane-titled", top > 64);
}

// ===========================================================================
// INIT
// ===========================================================================
export function initReader(hooks) {
  readerLifecycle.register(hooks);
  disposeReaderResources(false);
  const readerScope = readerLifecycle.beginInit();
  try {
    readerMain.replaceChildren();
    const compactQuery = window.matchMedia ? window.matchMedia(COMPACT_QUERY) : null;
    stage = createTrailStage({
      stage: readerMain,
      panes: function () {
        return trail.map((id) => panes.get(id)).filter(Boolean);
      },
      compact: function () {
        return !!(compactQuery && compactQuery.matches);
      },
      focusIndex: function () {
        return trail.indexOf(currentNodeId);
      },
      onFrame: onStageFrame,
      onSettle: onStageSettle,
      onMetrics: onStageMetrics,
      keepPlace: keepPlaces,
    });
    setMeasure(stage.metrics());
    readerScope.addCleanup(function () {
      if (stage) stage.dispose();
      stage = null;
    });
    const shell = composerShell();
    if (shell && typeof ResizeObserver === "function") {
      const room = new ResizeObserver(function () {
        const next = Math.round(shell.offsetHeight);
        if (!next || next === composerRoom) return;
        composerRoom = next;
        panes.forEach(sizeFoot);
      });
      room.observe(shell);
      readerScope.addCleanup(function () {
        room.disconnect();
      });
    }
    // Scroll does not bubble: every pane's scroll is caught on the way down.
    readerScope.listen(readerMain, "scroll", onPaneScroll, { passive: true, capture: true });
    readerScope.listen(readerMain, "pointerdown", onPanePointer, true);
    readerScope.listen(readerMain, "focusin", onPanePointer);
    readerScope.listen(readerMain, "click", onReaderClick);
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
      if (expand) focusQuietly(expand);
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
  // The composer is the shell's, lent to a pane: hand it back before the
  // panes go.
  const shell = composerShell();
  if (shell && readerMain.contains(shell)) readerMain.parentElement?.appendChild(shell);
  panes.forEach(function (pane) {
    disposeDoc(pane.col);
  });
  readerLifecycle.dispose(resetHooks);
  trail = [];
  panes = new Map();
  stage = null;
  kbdMarkIdx = -1;
}

function focusQuietly(el) {
  try {
    el.focus({ preventScroll: true });
  } catch (e) {
    el.focus();
  }
}

/** The live pane an event happened in (a leaving pane is no longer one). */
function paneOf(target) {
  const el = target && target.closest ? target.closest(".reader-pane") : null;
  return el ? panes.get(el.dataset.nodeId) || null : null;
}

function onPaneScroll(e) {
  const scroller = e.target;
  if (!(scroller instanceof HTMLElement) || !scroller.classList.contains("pane-scroll")) return;
  const pane = paneOf(scroller);
  const node = pane && nodes[pane.id];
  // Behind the canvas a pane cannot hold a place; its last real one stands.
  if (!node || mode !== "reader") return;
  node._scrollTop = scroller.scrollTop;
  syncBarState(pane);
  if (node.id === currentNodeId) readerLifecycle.hooks.scheduleViewSave();
}

function onPanePointer(e) {
  const pane = paneOf(e.target);
  if (!pane || pane.el.classList.contains("pane-folded")) return;
  if (pane.id !== currentNodeId) setCurrentPane(pane.id);
}

function onReaderClick(e) {
  const target = e.target;
  if (!target || !target.closest) return;
  const pane = paneOf(target);
  if (!pane) return;
  if (target.closest(".pane-spine")) {
    revealPane(pane.id, true);
    return;
  }
  if (target.closest(".pane-close")) {
    closePane(pane.id);
    return;
  }
  if (target.closest(".pane-focus")) {
    toggleFocus(pane.id);
    return;
  }
  if (target.closest(".pane-back")) {
    const node = nodes[pane.id];
    if (node) jumpToOrigin(node, motionSourceFromEvent(e));
    return;
  }
  const dot = target.closest(".branch-dot");
  if (dot) {
    e.preventDefault();
    openBranchFrom(dot);
    return;
  }
  onMarkClick(e);
}

// Open the answer a mark or dot points to, beside the document it sits in.
function openBranchFrom(el) {
  const child = nodes[el.dataset.child || el.dataset.note];
  if (!child || isDockedNote(child)) return;
  // Pending branches open too — the pane shows the answer streaming in live.
  openNode(child.id);
}

// Open the parent beside (or in place of) this document and land on the exact
// origin when this branch is anchored.
export function jumpToOrigin(node, source) {
  const parent = nodes[node.parent_id];
  if (!parent) return;
  if (panes.has(parent.id)) revealPane(parent.id, true);
  else openNode(parent.id);
  const pane = panes.get(parent.id);
  if (!pane) return;
  const selector = '[data-child="' + node.id + '"].rh-pdf-mark, mark[data-child="' + node.id + '"]';
  const target = pane.col.querySelector(selector);
  if (!target) return;
  scrollMarkIntoView(target, 0.38, source);
  const marks = pane.col.querySelectorAll(selector);
  for (let i = 0; i < marks.length; i++) playLandingCue(marks[i], "mark-flash");
}

function scrollMarkIntoView(mark, viewportRatio, source) {
  const scroller = mark.closest(".rh-pdf-scroll") || mark.closest(".pane-scroll");
  if (!scroller) return;
  // The glide aims at a place in the real layout, and keeps it while it moves.
  const release = holdFullLayout(scroller);
  const top = mark.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  readerLifecycle.hooks.animateScroll(scroller, Math.max(0, top - scroller.clientHeight * viewportRatio), source);
  setTimeout(release, 400);
}

// A mark takes you to its branch — unless the branch is a docked note, whose
// whole point is that there is nowhere to go: its own module opens it in place.
function onMarkClick(e) {
  const m = e.target.closest("[data-child].rh-pdf-mark, mark[data-child]");
  if (!m) return;
  if (!window.getSelection().isCollapsed) return; // user was selecting, not clicking
  openBranchFrom(m);
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

// j/k focus ring over the current document's anchored branches.
let kbdMarkIdx = -1;
function allMarks() {
  const pane = panes.get(currentNodeId);
  return pane ? pane.col.querySelectorAll("[data-child].rh-pdf-mark, mark[data-child]") : [];
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

// ===========================================================================
// VIEW STATE — what a refresh must bring back
// ===========================================================================
// The reader's part of where-was-I: which documents stand on the trail, where
// it rests, and whether one is read alone. Scroll places are not here: every
// document keeps its own on its node (`_scrollTop`), and view-state.js saves
// and brings those back for panes and cards alike.

/** @returns {{ trail: string[], position: number, focused: boolean } | null} */
export function readerViewState() {
  if (!stage || !trail.length) return null;
  return { trail: trail.slice(), position: stage.position(), focused: stage.focused() };
}

/**
 * Put the reader back exactly as it was, instantly — no flight, no slide, no
 * pane entering: the same trail, the same document current, resting at the
 * same place, read alone or not. Whatever of the saved trail no longer exists
 * (a deleted answer) is cut off where the lineage breaks; with nothing left,
 * the reader stays down and this returns false. `hidden` puts the trail back
 * behind the canvas without raising the reader, so opening it later finds
 * the trail it left.
 * @param {{ trail: string[], position: number, focused: boolean }} state
 * @param {string | null} current the document that was current
 * @param {{ hidden?: boolean }} [options]
 */
export function restoreReaderView(state, current, { hidden = false } = {}) {
  if (!stage || !state || !Array.isArray(state.trail)) return false;
  /** @type {string[]} */
  const ids = [];
  for (const id of state.trail) {
    const node = nodes[id];
    const parent = ids.length ? ids[ids.length - 1] : null;
    if (!node || node._pendingDelete || isDockedNote(node) || (node.parent_id || null) !== parent) break;
    ids.push(id);
  }
  if (!ids.length) return false;
  const here = current && ids.includes(current) ? current : ids[ids.length - 1];
  if (!hidden) {
    setModeValue("reader");
    document.body.classList.remove("mode-canvas");
    readerLifecycle.hooks.hideAsk();
    stage.relayout();
  }
  setTrail(ids);
  // A restored pane was already there: it does not animate in.
  panes.forEach(function (pane) {
    pane.el.classList.remove("pane-entering");
  });
  if (!hidden) setCurrentPane(here);
  if (state.focused && ids.length > 1) stage.setFocused(true, ids.indexOf(here));
  stage.moveTo(Number(state.position) || 0, { instant: true });
  syncReaderPanes();
  return true;
}
