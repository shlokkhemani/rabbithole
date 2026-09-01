import { systemClock } from "../core/clock.js";
import { isNoteNode } from "../core/hole/ask.js";
import { BUNNY_MARK_SVG } from "../core/html/icons.js";
import { shortId } from "../core/utils.js";
import { mountCodeCopy } from "./code-copy.js";
import { qsa } from "./dom.js";
import { createCleanupScope } from "./kit/scope.js";
import { onPreferenceChange, readingScale, toggleTheme } from "./preferences.js";
import { wireNotice } from "./primitives/notice.js";
import { createHoleStore } from "./store/hole-store.js";
import { mountStructuredNote } from "./structured-note.js";
import { mountVisuals } from "./visuals.js";

export const SVGNS = "http://www.w3.org/2000/svg";
export const MIN_SCALE = 0.15,
  MAX_SCALE = 2.5;
export const READER_BASE = 17,
  CANVAS_BASE = 14,
  MIN_FS = 0.7,
  MAX_FS = 2.4;

export const holeStore = createHoleStore();

export let hydration = null;
export let rootId = null;
export let frozen = false; // read-only exported snapshot
/** @type {Record<string, any>} */
export let nodes = holeStore.state.nodes;
export let currentNodeId = null;
// Canvas is home. The reader is not a sibling mode — it is the current card,
// maximized — so "canvas" is the resting state everywhere.
export let mode = "canvas";
export let view = holeStore.state.view;
export let closed = false;
export let closedReason = null;
let agentAttached = true;
export let agentReason = null;
export let connLost = false;
let sseFails = 0;
export let canvasBuilt = false; // canvas DOM is built lazily on first entry
export let canvasFramed = false; // frame-all runs once; afterwards the view is preserved
export let viewAdjusted = false; // only user-adjusted camera state is persisted
let orderCounter = 0;
let stackCounter = 0;
const loadingTimers = new Set();

// refs
export let readerMain = null;
export let breadcrumbEl = null;
export let viewport = null;
export let world = null;
export let edgesSvg = null;
export let ask = null;
export let askText = null;
export let zoomLabel = null;
let hintEl = null;
let bannerEl = null;
let hintNotice = null;
export let bannerNotice = null;
export let composerInner = null;
export let composerText = null;
export let composerActions = null;
export let paletteEl = null;
export let palText = null;
export let palResults = null;
export let shareMenu = null;

function defaultCoreHooks() {
  return {
    post: function () {
      return Promise.resolve({ ok: true });
    },
    putAsset: function () {
      return Promise.resolve({ ok: true });
    },
    deleteAsset: function () {
      return Promise.resolve({ ok: true });
    },
    ensureCanvasBuilt: function () {},
    diveToNode: function () {},
    openNode: function () {},
    ensureNodeHtml: function () {},
    persistNode: function () {},
    scheduleEdges: function () {},
    modeChanged: function () {},
    revealDockedNote: function () {
      return false;
    },
    mountDocImages: null,
    mountPdfView: null,
  };
}

/** @type {any} */
let coreHooks = defaultCoreHooks();
export function postBrowserEvent(event) {
  return coreHooks.post(event);
}
export function putAsset(name, blob) {
  return coreHooks.putAsset(name, blob);
}
export function deleteAsset(name) {
  return coreHooks.deleteAsset(name);
}
let coreScope = null;

export function initCore(inputHydration, hooks) {
  disposeCore();
  coreHooks = Object.assign(defaultCoreHooks(), hooks || {});
  coreScope = createCleanupScope();
  hydration = inputHydration || {};
  rootId = hydration.root_id;
  frozen = !!hydration.frozen;
  holeStore.reset({ hydration, rootId, frozen });
  nodes = holeStore.state.nodes;
  currentNodeId = rootId;
  setModeValue("canvas");
  view = holeStore.state.view;
  closed = frozen;
  closedReason = frozen ? "frozen" : null;
  agentAttached = hydration.agent_attached !== false;
  agentReason = null;
  connLost = false;
  sseFails = 0;
  canvasBuilt = false;
  canvasFramed = false;
  viewAdjusted = false;
  orderCounter = 0;
  stackCounter = 0;
  loadingTimers.clear();
  readerMain = document.getElementById("reader-main");
  // The lineage trail is owned by the UI, not the shell: it lives inside the
  // reader column (hosts may clear that container between holes), so each
  // init builds a fresh nav and the reader renders it into the document flow.
  breadcrumbEl = document.createElement("nav");
  breadcrumbEl.id = "breadcrumb";
  breadcrumbEl.setAttribute("aria-label", "Breadcrumb");
  viewport = document.getElementById("viewport");
  world = document.getElementById("world");
  edgesSvg = document.getElementById("edges");
  ask = document.getElementById("ask");
  askText = document.getElementById("ask-text");
  zoomLabel = document.getElementById("zoom-label");
  hintEl = document.getElementById("hint");
  bannerEl = document.getElementById("banner");
  hintNotice = wireNotice(hintEl, { variant: "hint" });
  bannerNotice = wireNotice(bannerEl, { variant: "banner" });
  composerInner = document.getElementById("composer-inner");
  composerText = document.getElementById("composer-text");
  composerActions = document.getElementById("composer-actions");
  paletteEl = document.getElementById("palette");
  palText = document.getElementById("pal-text");
  palResults = document.getElementById("pal-results");
  shareMenu = document.getElementById("sharemenu");

  initReduceMotion(coreScope);
  // Session-level chrome is wired once here — it lives in the shared taskbar
  // and stays put whichever mode is up.
  coreScope.listen(document.getElementById("tb-done"), "click", function () {
    if (!closed) coreHooks.post({ type: "done" });
  });
  coreScope.listen(document.getElementById("t-theme"), "click", function () {
    toggleTheme();
  });
  coreScope.addCleanup(
    onPreferenceChange(function (kind) {
      if (kind === "reading-scale") refreshDocumentTextSizes();
    }),
  );
  coreScope.interval(updateLoadingTimers, 1000);
  coreScope.addCleanup(function () {
    hintNotice?.hide();
    bannerNotice?.hide();
  });
  return disposeCore;
}

export function disposeCore() {
  const scope = coreScope;
  coreScope = null;
  try {
    if (scope) scope.dispose();
  } finally {
    Object.keys(nodes).forEach(function (id) {
      disposeNodeContent(nodes[id]);
    });
    resetCoreState();
  }
}

function resetCoreState() {
  hydration = null;
  rootId = null;
  frozen = false;
  holeStore.reset();
  nodes = holeStore.state.nodes;
  currentNodeId = null;
  mode = "canvas";
  view = holeStore.state.view;
  closed = false;
  closedReason = null;
  agentAttached = true;
  agentReason = null;
  connLost = false;
  sseFails = 0;
  canvasBuilt = false;
  canvasFramed = false;
  viewAdjusted = false;
  orderCounter = 0;
  stackCounter = 0;
  loadingTimers.clear();
  readerMain = breadcrumbEl = viewport = world = edgesSvg = null;
  ask = askText = zoomLabel = hintEl = bannerEl = null;
  hintNotice = bannerNotice = null;
  composerInner = composerText = composerActions = null;
  paletteEl = palText = palResults = null;
  shareMenu = null;
  reduceMotion = false;
  reduceMotionMql = null;
  coreHooks = defaultCoreHooks();
}

// The current node keeps one visible identity on the canvas: its card carries
// .current, so "the document I'm in" survives collapsing out of the reader.
export function setCurrentNodeId(id) {
  const prev = nodes[currentNodeId];
  if (prev && prev.el) prev.el.classList.remove("current");
  currentNodeId = id;
  holeStore.patch({ currentNodeId: id });
  const next = nodes[id];
  if (next && next.el) next.el.classList.add("current");
}
export function setModeValue(value) {
  mode = value;
  holeStore.patch({ mode: value });
  coreHooks.modeChanged(value);
}
export function setClosedState(value, reason) {
  closed = !!value;
  closedReason = reason || null;
  holeStore.patch({ closed, closedReason });
}
export function setAgentAttached(value) {
  agentAttached = !!value;
}
export function setAgentReason(value) {
  agentReason = value || null;
}
export function setConnLost(value) {
  connLost = !!value;
}
export function resetSseFails() {
  sseFails = 0;
}
export function incrementSseFails() {
  sseFails += 1;
  return sseFails;
}
export function setCanvasBuilt(value) {
  canvasBuilt = !!value;
}
export function setCanvasFramed(value) {
  canvasFramed = !!value;
}
export function setViewAdjusted(value) {
  viewAdjusted = !!value;
}
export function nextOrder() {
  return orderCounter++;
}
export function nextStack() {
  return stackCounter++;
}
// ---------- helpers ----------
export function uuid() {
  while (true) {
    const id = shortId();
    if (!nodes[id]) return id;
  }
}
export function registerNode(node) {
  return holeStore.register(node);
}
export function unregisterNode(id) {
  return holeStore.remove(id);
}
export function childrenOf(id) {
  return holeStore.childrenOf(id);
}
export function isVisible(node, cache) {
  const visible = !node._pendingDelete;
  if (cache) cache[node.id] = visible;
  return visible;
}
/*
 * Two scales compose here and neither replaces the other. The global reading
 * size belongs to the reader (eyes, monitor) and lives in localStorage; the
 * per-node font_scale is authorial and lives in the document. Effective size =
 * base × global × font_scale.
 */
export function fontPx(base, scale) {
  return Math.round(base * readingScale() * normalizeFontScale(scale));
}
export function normalizeFontScale(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.round(Math.min(MAX_FS, Math.max(MIN_FS, value)) * 100) / 100;
}
/*
 * A pinned window owns its own text size: the pin carries a presentation
 * fontScale that is never written back to the authorial font_scale, so the
 * canvas surface shows the pin's size while pinned and the document keeps the
 * size it had before pinning. Reader surfaces always read the authorial scale.
 */
export function surfaceFontScale(node, surfaceKind) {
  if (!node) return 1;
  if (surfaceKind !== "reader") {
    const pin = node.view && node.view.pin;
    if (pin && Number.isFinite(pin.fontScale)) return pin.fontScale;
  }
  return node.font_scale;
}
// The global scale changed under every card at once — repaint the sizes the
// document itself never knew about.
export function refreshDocumentTextSizes() {
  /** @type {HTMLElement[]} */
  const surfaces = qsa(".doc-content, .note-editor");
  for (let i = 0; i < surfaces.length; i++) {
    const surface = surfaces[i];
    const node = nodes[surface.dataset.nodeId];
    // Pin proxies carry no node id; their size is owned by the proxy render,
    // so a global change must not clobber them back to scale 1.
    if (!node) continue;
    const base = surface.dataset.surface === "reader" ? READER_BASE : CANVAS_BASE;
    surface.style.fontSize = fontPx(base, surfaceFontScale(node, surface.dataset.surface)) + "px";
  }
  coreHooks.scheduleEdges();
}
export function setNodeFontScale(node, value) {
  if (!node) return 1;
  node.font_scale = normalizeFontScale(value);
  /** @type {HTMLElement[]} */
  const surfaces = qsa(".doc-content, .note-editor");
  for (let i = 0; i < surfaces.length; i++) {
    if (surfaces[i].dataset.nodeId !== node.id) continue;
    const base = surfaces[i].dataset.surface === "reader" ? READER_BASE : CANVAS_BASE;
    surfaces[i].style.fontSize = fontPx(base, surfaceFontScale(node, surfaces[i].dataset.surface)) + "px";
  }
  coreHooks.persistNode(node);
  // Reflowed text moves the inline marks edges anchor to.
  coreHooks.scheduleEdges();
  return node.font_scale;
}
export function changeNodeFontScale(node, delta) {
  return setNodeFontScale(node, ((node && node.font_scale) || 1) + delta);
}
export function resetNodeFontScale(node) {
  return setNodeFontScale(node, 1);
}
export function sessionPhase() {
  if (frozen) return "frozen";
  if (closed) return "closed";
  if (connLost || !agentAttached) return "away";
  return "live";
}
let reduceMotion = false,
  reduceMotionMql = null;
function setReduceMotion(e) {
  reduceMotion = !!(e && e.matches);
}
function initReduceMotion(scope) {
  if (window.matchMedia) {
    reduceMotionMql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(reduceMotionMql);
    if (reduceMotionMql.addEventListener) scope.listen(reduceMotionMql, "change", setReduceMotion);
    else if (reduceMotionMql.addListener) {
      reduceMotionMql.addListener(setReduceMotion);
      scope.addCleanup(function () {
        reduceMotionMql?.removeListener(setReduceMotion);
      });
    }
  }
}
export function shouldReduceMotion() {
  return reduceMotion;
}
export function motionSourceFromEvent(e) {
  return e && e.detail !== 0 ? "pointer" : "keyboard";
}
export function playLandingCue(el, cls) {
  if (!el || document.hidden) return;
  cls = cls || "flash";
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  if (shouldReduceMotion()) {
    setTimeout(function () {
      el.classList.remove(cls);
    }, 180);
    return;
  }
  requestAnimationFrame(function () {
    el.classList.remove(cls);
  });
}
// Bring a node to the human in whichever view they're in: the reader opens it
// (streaming answers render live), the canvas dives to the card and flashes it.
export function goToNode(node, source) {
  if (!node) return;
  // A docked note has no card of its own to travel to: it is shown where it
  // lives, on the card it was written about.
  if (coreHooks.revealDockedNote(node, source)) return;
  if (mode === "canvas") {
    coreHooks.ensureCanvasBuilt();
    coreHooks.diveToNode(node, source);
    if (node.el) playLandingCue(node.el, "flash");
  } else {
    coreHooks.openNode(node.id);
  }
}

// ---------- loading placeholder (pending answers) ----------
const LOADING_BUNNY_HTML = '<span class="loading-bunny" aria-hidden="true">' + BUNNY_MARK_SVG + "</span>";
export function buildLoading(node) {
  if (node && node.error) {
    const errWrap = document.createElement("div");
    errWrap.className = "loading provider-error";
    const title = document.createElement("div");
    title.className = "provider-error-title";
    title.textContent = "Provider request failed";
    const msg = document.createElement("div");
    msg.className = "provider-error-msg";
    msg.textContent = node.error.message || "The model provider returned an error.";
    const retry = document.createElement("button");
    retry.className = "provider-retry";
    retry.type = "button";
    retry.textContent = "Retry";
    retry.disabled = node.error.retryable === false;
    retry.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      node.error = null;
      coreHooks.post({ type: "retry_branch", node_id: node.id });
    });
    errWrap.appendChild(title);
    errWrap.appendChild(msg);
    errWrap.appendChild(retry);
    return errWrap;
  }
  const wrap = document.createElement("div");
  wrap.className = "loading";
  const st = document.createElement("div");
  st.className = "loading-status";
  st.innerHTML =
    LOADING_BUNNY_HTML +
    '<span class="shimmer-text ll-live">' +
    (node && node.delegated ? "Working in sub-agent…" : "Thinking") +
    "</span>" +
    '<span class="ll-stalled">Saved — waiting for the agent</span>' +
    '<span class="ll-closed">Saved — answered when you reopen this hole</span>' +
    '<span class="ll-frozen">Unanswered when this snapshot was exported</span>' +
    '<span class="loading-time" data-start="' +
    (node._startTs || systemClock.now()) +
    '"></span>';
  loadingTimers.add(st.querySelector(".loading-time"));
  const sk = document.createElement("div");
  sk.innerHTML =
    '<div class="sk-line w1"></div><div class="sk-line w2"></div><div class="sk-line w3"></div><div class="sk-line w4"></div>';
  wrap.appendChild(st);
  wrap.appendChild(sk);
  return wrap;
}
function buildConvertProgress(node, pdfExt, committed) {
  const done = node._pdfProgress ? node._pdfProgress.done : 0;
  const total = node._pdfProgress ? node._pdfProgress.total : pdfExt.pages ? pdfExt.pages.length : 0;
  const wrap = document.createElement("div");
  wrap.className = "rh-pdf-convert-progress" + (committed ? "" : " loading rh-pdf-converting");
  const st = document.createElement("div");
  st.className = "loading-status";
  let label = "Creating text version";
  if (committed && done > 0 && done < total) label += " — page " + done + " of " + total;
  else if (!committed && total) label += " — " + total + (total === 1 ? " page" : " pages");
  st.innerHTML = (committed ? "" : LOADING_BUNNY_HTML) + '<span class="shimmer-text">' + label + "</span>";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "card-btn rh-pdf-convert-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", function (event) {
    event.stopPropagation();
    cancel.disabled = true;
    postBrowserEvent({ type: "convert_cancel", node_id: node.id });
  });
  st.appendChild(cancel);
  wrap.appendChild(st);
  if (!committed) {
    const sk = document.createElement("div");
    sk.innerHTML =
      '<div class="sk-line w1"></div><div class="sk-line w2"></div><div class="sk-line w3"></div><div class="sk-line w4"></div>';
    wrap.appendChild(sk);
  }
  return wrap;
}
function visualSurfaceKey(node, base) {
  return (base === CANVAS_BASE ? "canvas:" : "reader:") + ((node && node.id) || "unknown");
}
function mountDocMedia(dc, node, base) {
  const surfaceKey = visualSurfaceKey(node, base);
  mountVisuals(dc, surfaceKey);
  if (typeof coreHooks.mountDocImages === "function") coreHooks.mountDocImages(dc, surfaceKey);
  mountCodeCopy(dc);
}
// A pending node that has streamed content renders it live: the words so far,
// a breathing caret at the end of the text, and a quiet status row beneath.
export function fillStreaming(dc, node, surfaceKey) {
  dc.innerHTML = node.html || "";
  const caret = document.createElement("span");
  caret.className = "stream-caret";
  let last = dc.lastElementChild;
  if (last && (last.tagName === "UL" || last.tagName === "OL")) last = last.lastElementChild || last;
  if (last && /^(P|H[1-6]|LI)$/.test(last.tagName)) last.appendChild(caret);
  else dc.appendChild(caret);
  const st = document.createElement("div");
  st.className = "stream-status";
  st.innerHTML =
    '<span class="shimmer-text ll-live">' +
    (node && node.delegated ? "Working in sub-agent…" : "Writing") +
    "</span>" +
    '<span class="ll-stalled">Paused — waiting for the agent</span>' +
    '<span class="ll-closed">Saved — answered in full when you reopen this hole</span>' +
    '<span class="ll-frozen">Unfinished when this snapshot was exported</span>' +
    '<span class="loading-time" data-start="' +
    (node._startTs || systemClock.now()) +
    '"></span>';
  loadingTimers.add(st.querySelector(".loading-time"));
  dc.appendChild(st);
  surfaceKey = surfaceKey || "stream:" + ((node && node.id) || "unknown");
  mountVisuals(dc, surfaceKey);
  if (typeof coreHooks.mountDocImages === "function") coreHooks.mountDocImages(dc, surfaceKey);
  mountCodeCopy(dc);
}
function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 3) return "";
  if (s < 60) return s + "s";
  return Math.floor(s / 60) + "m " + (s % 60) + "s";
}
function updateLoadingTimers() {
  if (closed) return; // freeze timers once the session is over
  const now = systemClock.now();
  loadingTimers.forEach(function (el) {
    if (!el || !el.isConnected) {
      loadingTimers.delete(el);
      return;
    }
    const t = Number(el.getAttribute("data-start")) || 0;
    if (t) el.textContent = formatElapsed(now - t);
  });
}

// ---------- shared document content ----------
export function disposeNodeContent(node) {
  if (!node || !node._contentDisposers) return;
  Array.from(node._contentDisposers).forEach(function (dispose) {
    dispose();
  });
  node._contentDisposers.clear();
}
export function buildDocContent(node, base) {
  coreHooks.ensureNodeHtml(node);
  /** @type {HTMLDivElement & {_rhDispose?: null | (() => void)}} */
  const dc = document.createElement("div");
  dc.className = "doc-content md";
  dc.dataset.nodeId = node.id;
  dc.dataset.surface = base === CANVAS_BASE ? "canvas" : "reader";
  dc.style.fontSize = fontPx(base, surfaceFontScale(node, dc.dataset.surface)) + "px";
  if (node.status === "pending") {
    if (node.html) fillStreaming(dc, node, visualSurfaceKey(node, base));
    else dc.appendChild(buildLoading(node));
  } else {
    if (isNoteNode(node) && !node.source) {
      const noteDocument = mountStructuredNote(dc, {
        markdown: node.markdown || "",
        html: node.html || "",
        baseUrl: node.base_url || null,
        ariaLabel: "Note",
        editAriaLabel: "Edit note",
        onChange: function (markdown, transaction) {
          if (node._structuredNoteOnChange) node._structuredNoteOnChange(markdown, transaction, dc);
        },
        onReplace: function () {
          mountDocMedia(dc, node, base);
        },
      });
      mountDocMedia(dc, node, base);
      if (!node._contentDisposers) node._contentDisposers = new Set();
      const disposeNote = function () {
        if (dc._rhDispose !== disposeNote) return;
        dc._rhDispose = null;
        node._contentDisposers.delete(disposeNote);
        noteDocument.destroy();
      };
      node._contentDisposers.add(disposeNote);
      dc._rhDispose = disposeNote;
      return dc;
    }
    const disposePdf = coreHooks.mountPdfView ? coreHooks.mountPdfView(dc, node) : null;
    if (disposePdf) {
      if (!node._contentDisposers) node._contentDisposers = new Set();
      const dispose = function () {
        node._contentDisposers.delete(dispose);
        disposePdf();
      };
      node._contentDisposers.add(dispose);
      dc._rhDispose = dispose;
    } else {
      dc.innerHTML = node.html || "";
      const pdfExt = node.source;
      if (pdfExt && pdfExt.converting) {
        // Until the first converted chunk lands the body is still the raw
        // line-per-line extraction — never show that; show a loading state.
        const committed =
          String(node.markdown || "") !== String(pdfExt.original_markdown != null ? pdfExt.original_markdown : "");
        if (!committed) dc.innerHTML = "";
        dc.prepend(buildConvertProgress(node, pdfExt, committed));
      }
      mountDocMedia(dc, node, base);
    }
  }
  return dc;
}

export function flashHint(msg) {
  hintNotice.show({ message: msg, duration: 4000 });
}
