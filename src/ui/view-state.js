import { normalizeViewState } from "../core/hole/bookmark.js";
import {
  canvasFramed,
  currentNodeId,
  MAX_SCALE,
  MIN_SCALE,
  mode,
  nodes,
  rootId,
  setCanvasFramed,
  setCurrentNodeId,
  setViewAdjusted,
  view,
  viewAdjusted,
} from "./core.js";
import { pdfReadingPlaces, seedPdfReadingPlaces } from "./pdf-view.js";
import { readerScroller, readerViewState, restoreReaderView } from "./reader.js";
import { holdFullLayout, setScrollPlace } from "./scroll-position.js";

/*
 * Where-was-I. A refresh (or a reopen tomorrow) must land exactly where the
 * human was: the same surface (canvas or reader), the same camera, the same
 * document current, the reader's whole trail at the same resting place, every
 * pane and every card scrolled where it was, every PDF on the same page at the
 * same zoom. This module is the one place that turns the live UI into the
 * persisted `view_state` (see core/hole/bookmark.js for its shape) and back.
 *
 * Scroll places are restored under a hold: a document's height keeps changing
 * for a while after it renders (fonts, images, math, diagrams), and a scroll
 * set too early clamps short. Each held scroller is put back on its place
 * every frame until its height has been still for a while, and let go the
 * moment the human reaches for anything.
 */

const HOLD_STILL_FRAMES = 24;
const HOLD_MIN_MS = 400;
const HOLD_MAX_MS = 5000;

// Canvas cards scroll inside themselves. Hiding the canvas (the reader is up)
// drops every card's offset without a scroll event, so the offsets live here,
// fed by scroll events, and are put back whenever the canvas shows again.
/** @type {Map<string, number>} */
let cardScrolls = new Map();

/** @typedef {{ el: HTMLElement, target: number, kind: "reader" | "card", id: string, height: number, still: number, letGo: () => void }} Hold */
/** @type {Hold[]} */
let holds = [];
let holdFrame = 0;
let holdStart = 0;
let fontsReady = false;
let intentBound = false;

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------
/**
 * The live UI as a persisted view state. `framing` also keeps a camera the
 * human never moved (the automatic first framing): a refresh shows exactly
 * that, while a durable save leaves it to be framed afresh next time.
 */
export function captureViewState({ framing = false } = {}) {
  /** @type {Record<string, any>} */
  const state = { mode: mode, node_id: currentNodeId };
  // The automatic first framing is not saved (it is recomputed for whatever
  // the hole holds next time); any camera the human moved, or glided to, is.
  if (viewAdjusted || (framing && canvasFramed)) state.view = { x: view.x, y: view.y, scale: view.scale };
  const reader = readerViewState();
  if (reader) state.reader = reader;

  /** @type {Record<string, number>} */
  const scrolls = {};
  Object.keys(nodes).forEach(function (id) {
    const top = nodes[id] && nodes[id]._scrollTop;
    if (top > 0) scrolls[id] = top;
  });
  /** @type {Record<string, number>} */
  const cards = {};
  cardScrolls.forEach(function (top, id) {
    if (top > 0 && nodes[id]) cards[id] = top;
  });
  if (mode === "reader") {
    const scroller = readerScroller();
    if (scroller && currentNodeId) scrolls[currentNodeId] = scroller.scrollTop;
  }
  // A place still being restored is the place, not wherever the layout has
  // clamped it so far.
  holds.forEach(function (hold) {
    (hold.kind === "reader" ? scrolls : cards)[hold.id] = hold.target;
  });
  Object.keys(scrolls).forEach(function (id) {
    if (!(scrolls[id] > 0)) delete scrolls[id];
  });
  state.scroll = (currentNodeId && scrolls[currentNodeId]) || 0;
  if (Object.keys(scrolls).length) state.scrolls = scrolls;
  if (Object.keys(cards).length) state.cards = cards;
  const pdf = pdfReadingPlaces();
  if (Object.keys(pdf).length) state.pdf = pdf;
  return state;
}

// ---------------------------------------------------------------------------
// the last moment before a refresh
// ---------------------------------------------------------------------------
// Saves are debounced and asynchronous, and an unloading page cannot finish
// one: an IndexedDB write started in pagehide dies with the page, and a POST
// races the reload's own request for the page. So as the page goes, this tab
// also writes, synchronously, to its session storage: where the human was,
// and every edit it sent in the last moments (moves, sizes, text sizes, note
// words, pins) that may not have reached disk. The very next boot of the same
// hole in this tab takes that journal once — it shows the journaled edits and
// view, and sends the edits again through the ordinary path so they persist.
const JOURNAL_KEY = "rh-unload-journal";
const JOURNALED = ["node_update", "nodes_update", "node_extensions_patch"];
const UNDURABLE_MS = 2500; // longer than any debounce plus a store write
// A journal is for the load that follows its unload; one left behind (a page
// frozen into the back/forward cache and never reloaded) must not surface
// much later over a newer save.
const JOURNAL_MAX_AGE_MS = 30000;
/** @type {{ at: number, payload: any }[]} */
let recentEdits = [];
let journalChecked = false;

/** Every durable edit the page sends passes here, so an unload can journal it. */
export function notePosted(payload) {
  if (!payload || !JOURNALED.includes(payload.type)) return;
  if (payload.type === "node_extensions_patch" && payload.namespace !== "canvas") return;
  const now = performance.now();
  recentEdits = recentEdits.filter(function (entry) {
    return now - entry.at < UNDURABLE_MS;
  });
  recentEdits.push({ at: now, payload: payload });
}

/** As the page goes: write where-was-I and the undurable edits, synchronously. */
export function journalBeforeUnload() {
  if (!rootId) return;
  const now = performance.now();
  const edits = recentEdits
    .filter(function (entry) {
      return now - entry.at < UNDURABLE_MS;
    })
    .map(function (entry) {
      return entry.payload;
    });
  try {
    sessionStorage.setItem(
      JOURNAL_KEY,
      JSON.stringify({
        root_id: rootId,
        at: Date.now(),
        view: captureViewState({ framing: true }),
        view_adjusted: viewAdjusted,
        edits: edits,
      }),
    );
  } catch (e) {}
}

/**
 * On the first hydrate after a page load only (switching holes in place never
 * reads it): the journal this tab wrote for this same hole as it unloaded.
 * @returns {{ view: any, viewAdjusted: boolean, edits: any[] } | null}
 */
export function takeUnloadJournal() {
  if (journalChecked) return null;
  journalChecked = true;
  let journal = null;
  try {
    const raw = sessionStorage.getItem(JOURNAL_KEY);
    sessionStorage.removeItem(JOURNAL_KEY);
    journal = raw ? JSON.parse(raw) : null;
  } catch (e) {}
  if (!journal || journal.root_id !== rootId) return null;
  if (!(Date.now() - Number(journal.at) < JOURNAL_MAX_AGE_MS)) return null;
  return {
    view: normalizeViewState(journal.view),
    viewAdjusted: journal.view_adjusted === true,
    edits: Array.isArray(journal.edits)
      ? journal.edits.filter(function (edit) {
          return edit && JOURNALED.includes(edit.type);
        })
      : [],
  };
}

/** Show journaled edits in the hydration the page is about to build from. */
export function applyJournaledEdits(rawNodes, edits) {
  /** @type {Record<string, any>} */
  const byId = {};
  (rawNodes || []).forEach(function (raw) {
    byId[raw.id] = raw;
  });
  const patch = function (update) {
    const raw = update && byId[update.node_id];
    if (!raw) return;
    ["title", "position", "size", "collapsed", "font_scale", "markdown"].forEach(function (key) {
      if (update[key] !== undefined) raw[key] = update[key];
    });
  };
  edits.forEach(function (edit) {
    if (edit.type === "node_update") patch(edit);
    else if (edit.type === "nodes_update") (edit.nodes || []).forEach(patch);
    else if (edit.type === "node_extensions_patch" && byId[edit.node_id]) {
      const raw = byId[edit.node_id];
      raw.extensions = Object.assign({}, raw.extensions, { [edit.namespace]: edit.value });
    }
  });
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------
/**
 * Before any surface is built: the current document, every document's reader
 * place, every PDF place, and the camera. Surfaces built after this open on
 * them.
 */
export function seedViewState(vs, { viewAdjusted: adjusted = true } = {}) {
  cancelHolds(false);
  cardScrolls = new Map();
  seedPdfReadingPlaces(vs && vs.pdf);
  if (!vs) return;
  if (vs.node_id && nodes[vs.node_id]) setCurrentNodeId(vs.node_id);
  if (vs.scrolls) {
    Object.keys(vs.scrolls).forEach(function (id) {
      if (nodes[id]) nodes[id]._scrollTop = vs.scrolls[id];
    });
  }
  if (vs.cards) {
    Object.keys(vs.cards).forEach(function (id) {
      if (nodes[id]) cardScrolls.set(id, vs.cards[id]);
    });
  }
  if (vs.view) {
    view.x = vs.view.x;
    view.y = vs.view.y;
    view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, vs.view.scale || 1));
    setCanvasFramed(true); // the saved framing wins; don't re-frame on first entry
    // A camera the human moved stays saved; an automatic framing brought back
    // by a refresh is shown, but still not saved as theirs.
    setViewAdjusted(adjusted);
  }
}

/**
 * Bring the reader back if that is where the human was, holding every pane's
 * place until its document has finished laying out. Returns whether it did;
 * if not, the canvas comes up (restoreCanvasSurface).
 */
export function restoreReaderSurface(vs) {
  const trail = vs && vs.reader;
  if (!trail || vs.mode !== "reader" || !restoreReaderView(trail, restoredCurrent(vs))) return false;
  trail.trail.forEach(function (id) {
    const scroller = readerScroller(id);
    const top = nodes[id] && nodes[id]._scrollTop;
    if (scroller && top > 0) hold(scroller, top, "reader", id);
  });
  return true;
}

/**
 * With the canvas up: every card at its place, and the reader's trail kept
 * behind it (when allowed), so opening the reader later finds the trail it left.
 */
export function restoreCanvasSurface(vs, { allowReader = true } = {}) {
  if (allowReader && vs && vs.reader) restoreReaderView(vs.reader, restoredCurrent(vs), { hidden: true });
  restoreCardScrolls({ held: true });
}

// The document that was current may be gone: the reader then lands on the
// deepest one of its trail that is still there.
function restoredCurrent(vs) {
  return vs && vs.node_id && nodes[vs.node_id] ? vs.node_id : null;
}

/**
 * The canvas is showing again: every card goes back to its place. Cards whose
 * documents the reader just showed take the reader's places instead
 * (`except`, keyed by node id).
 * @param {{ except?: Map<string, unknown> | null, held?: boolean }} [options]
 */
export function restoreCardScrolls({ except = null, held = false } = {}) {
  cardScrolls.forEach(function (top, id) {
    const node = nodes[id];
    const body = node && node.bodyEl;
    if (!body || except?.has(id) || !(top > 0) || Math.abs(body.scrollTop - top) <= 1) return;
    if (held) hold(body, top, "card", id);
    else setScrollPlace(body, top);
  });
}

// ---------------------------------------------------------------------------
// watching: every place the human reads at, so the next save has it
// ---------------------------------------------------------------------------
/** Save on every scroll of a reading surface; returns its cleanup. @param {() => void} save */
export function watchViewSurfaces(save) {
  const onScroll = function (e) {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    if (el.classList.contains("card-body")) {
      const card = el.closest(".card");
      const id = card instanceof HTMLElement ? card.dataset.id : "";
      const node = id ? nodes[id] : null;
      // Only a card on screen reports a real place (a hidden one reads 0).
      if (!node || node.bodyEl !== el || !el.clientHeight) return;
      if (!isHeld(el)) cardScrolls.set(id, el.scrollTop);
      save();
    } else if (el.classList.contains("pane-scroll") || el.classList.contains("rh-pdf-scroll")) {
      save();
    }
  };
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  document.addEventListener("rh-pdf-place", save);
  return function () {
    document.removeEventListener("scroll", onScroll, { capture: true });
    document.removeEventListener("rh-pdf-place", save);
    // Leaving before a place finished restoring: the place stands.
    cancelHolds(true);
  };
}

// ---------------------------------------------------------------------------
// holds
// ---------------------------------------------------------------------------
function isHeld(el) {
  return holds.some(function (hold) {
    return hold.el === el;
  });
}

/** @param {HTMLElement} el @param {number} target @param {"reader" | "card"} kind @param {string} id */
function hold(el, target, kind, id) {
  holds = holds.filter(function (h) {
    if (h.el === el) h.letGo();
    return h.el !== el;
  });
  // Held against the real layout: a pixel place means its text only there.
  holds.push({ el, target, kind, id, height: -1, still: 0, letGo: holdFullLayout(el) });
  el.scrollTop = target;
  bindIntent();
  if (!holdStart) holdStart = performance.now();
  if (!fontsReady && document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      fontsReady = true;
    });
  } else fontsReady = true;
  if (!holdFrame) holdFrame = requestAnimationFrame(stepHolds);
}

function stepHolds(now) {
  holdFrame = 0;
  const expired = now - holdStart > HOLD_MAX_MS;
  holds = holds.filter(function (h) {
    if (expired || !h.el.isConnected) return release(h);
    if (!h.el.clientHeight) return true; // hidden for now: nothing to measure
    const height = h.el.scrollHeight;
    if (height !== h.height) {
      h.height = height;
      h.still = 0;
    } else h.still++;
    if (Math.abs(h.el.scrollTop - h.target) > 1) h.el.scrollTop = h.target;
    const settled = fontsReady && h.still >= HOLD_STILL_FRAMES && now - holdStart >= HOLD_MIN_MS && imagesDone(h.el);
    return settled ? release(h) : true;
  });
  if (holds.length) holdFrame = requestAnimationFrame(stepHolds);
  else holdStart = 0;
}

function imagesDone(el) {
  const images = el.querySelectorAll("img");
  for (let i = 0; i < images.length; i++) {
    const img = /** @type {HTMLImageElement} */ (images[i]);
    if (!img.complete && img.loading !== "lazy") return false;
  }
  return true;
}

// Let go: from here on the scroller's own place is the truth (a document that
// has since grown shorter keeps the nearest place it has).
/** @param {Hold} h @returns {false} */
function release(h) {
  h.letGo();
  if (h.kind === "reader" && nodes[h.id] && h.el.isConnected && h.el.clientHeight) {
    nodes[h.id]._scrollTop = h.el.scrollTop;
  }
  if (h.kind === "card" && h.el.isConnected && h.el.clientHeight) cardScrolls.set(h.id, h.el.scrollTop);
  return false;
}

/** @param {boolean} keepTargets the places were never left, so they are still the truth */
function cancelHolds(keepTargets) {
  holds.forEach(function (h) {
    if (!keepTargets) return release(h);
    h.letGo();
    if (h.kind === "reader" && nodes[h.id]) nodes[h.id]._scrollTop = h.target;
    if (h.kind === "card") cardScrolls.set(h.id, h.target);
  });
  holds = [];
  unbindIntent();
  if (holdFrame) cancelAnimationFrame(holdFrame);
  holdFrame = 0;
  holdStart = 0;
}

// The human reaching into a surface ends the holds there: their place is
// theirs from then on. A key moves the reader (j/k, arrows) or the canvas, so
// it ends them all; a click on chrome (the taskbar, the rail) ends none.
function onIntent(e) {
  if (e.type === "keydown") return cancelHolds(false);
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  const inReader = !!target.closest("#reader");
  const inCanvas = !!target.closest("#viewport");
  const kept = holds.filter(function (h) {
    const reached = h.el.contains(target) || (h.kind === "reader" ? inReader : inCanvas);
    if (reached) release(h);
    return !reached;
  });
  if (kept.length === holds.length) return;
  holds = kept;
  if (!holds.length) cancelHolds(false);
}
const INTENT_EVENTS = ["wheel", "pointerdown", "touchstart", "keydown"];
function bindIntent() {
  if (intentBound) return;
  intentBound = true;
  INTENT_EVENTS.forEach(function (type) {
    document.addEventListener(type, onIntent, { capture: true, passive: true });
  });
}
function unbindIntent() {
  if (!intentBound) return;
  intentBound = false;
  INTENT_EVENTS.forEach(function (type) {
    document.removeEventListener(type, onIntent, { capture: true });
  });
}
