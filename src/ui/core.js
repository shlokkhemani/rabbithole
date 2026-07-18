import {
  BRANCH_FOLLOWUP,
  BRANCH_SELECTION,
  LENSES,
  branchTypeOfNode,
  lensLabel as sharedLensLabel,
  truncate as sharedTruncate
} from "../core/model.js";
import { wireNotice } from "./primitives/notice.js";
import { escapeHtml } from "../core/utils.js";
import { BUNNY_MARK_SVG } from "../core/html/icons.js";
import { createCleanupScope } from "./lifecycle.js";
import { mountVisuals } from "./visuals.js";
import {
  DEFAULT_CHILD,
  DEFAULT_ROOT,
  TREE_PARENT_GAP,
  TREE_STACK_GAP,
  boundsOverlap as sharedBoundsOverlap,
  nodeBounds as sharedNodeBounds,
  nodeOrder as sharedNodeOrder,
  shiftBounds as sharedShiftBounds,
  unionBounds as sharedUnionBounds
} from "../core/layout.js";

export { BRANCH_FOLLOWUP, BRANCH_SELECTION, DEFAULT_CHILD, DEFAULT_ROOT, LENSES, TREE_PARENT_GAP, TREE_STACK_GAP };

export var SVGNS = "http://www.w3.org/2000/svg";
export var MIN_SCALE = 0.15, MAX_SCALE = 2.5;
export var READER_BASE = 17, CANVAS_BASE = 14, MIN_FS = 0.7, MAX_FS = 2.4;

export var hydration = null;
export var rootId = null;
export var frozen = false; // read-only exported snapshot
export var nodes = {};
var childrenByParent = Object.create(null);
export var currentNodeId = null;
export var mode = "reader";
export var view = { x: 0, y: 0, scale: 1 };
export var closed = false;
export var closedReason = null;
var agentAttached = true;
export var agentReason = null;
export var connLost = false;
var sseFails = 0;
export var canvasBuilt = false;   // canvas DOM is built lazily on first entry
export var canvasFramed = false;  // frame-all runs once; afterwards the view is preserved
export var viewAdjusted = false;  // only user-adjusted camera state is persisted
var orderCounter = 0;
var loadingTimers = new Set();

// refs
export var readerMain = null;
export var breadcrumbEl = null;
export var viewport = null;
export var world = null;
export var edgesSvg = null;
export var ask = null;
export var askText = null;
export var askGo = null;
export var zoomLabel = null;
var hintEl = null;
var bannerEl = null;
var hintNotice = null;
export var bannerNotice = null;
export var composerInner = null;
export var composerText = null;
export var composerSend = null;
export var paletteEl = null;
export var palText = null;
export var palResults = null;
export var shareMenu = null;
export var confirmEl = null;

function defaultCoreHooks(){
  return {
    post: function(){ return Promise.resolve({ ok: true }); },
    ensureCanvasBuilt: function(){},
    diveToNode: function(){},
    openNode: function(){},
    ensureNodeHtml: function(){},
    mountDocImages: null,
    mountPdfView: null,
    effH: function(n){ return n.h; }
  };
}

var coreHooks = defaultCoreHooks();
export function postBrowserEvent(event) { return coreHooks.post(event); }
var coreScope = null;

export function registerCoreHooks(hooks) {
  Object.assign(coreHooks, hooks || {});
}

export function initCore(inputHydration) {
  disposeCore();
  coreScope = createCleanupScope();
  hydration = inputHydration || {};
  rootId = hydration.root_id;
  frozen = !!hydration.frozen;
  nodes = {};
  childrenByParent = Object.create(null);
  currentNodeId = rootId;
  mode = "reader";
  view = { x: 0, y: 0, scale: 1 };
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
  askGo = document.getElementById("ask-go");
  zoomLabel = document.getElementById("zoom-label");
  hintEl = document.getElementById("hint");
  bannerEl = document.getElementById("banner");
  hintNotice = wireNotice(hintEl, { variant: "hint" });
  bannerNotice = wireNotice(bannerEl, { variant: "banner" });
  composerInner = document.getElementById("composer-inner");
  composerText = document.getElementById("composer-text");
  composerSend = document.getElementById("composer-send");
  paletteEl = document.getElementById("palette");
  palText = document.getElementById("pal-text");
  palResults = document.getElementById("pal-results");
  shareMenu = document.getElementById("sharemenu");
  confirmEl = document.getElementById("confirm");

  initReduceMotion(coreScope);
  // Session-level chrome is wired once here — it lives in the shared taskbar
  // and stays put whichever mode is up.
  coreScope.listen(document.getElementById("tb-done"), "click", function(){ if (!closed) coreHooks.post({ type: "done" }); });
  coreScope.listen(document.getElementById("t-theme"), "click", toggleTheme);
  coreScope.interval(updateLoadingTimers, 1000);
  coreScope.addCleanup(function(){
    hintNotice?.hide();
    bannerNotice?.hide();
  });
  return disposeCore;
}

export function disposeCore(){
  var scope = coreScope;
  coreScope = null;
  try {
    if (scope) scope.dispose();
  } finally {
    Object.keys(nodes).forEach(function(id){ disposeNodeContent(nodes[id]); });
    resetCoreState();
  }
}

function resetCoreState(){
  hydration = null;
  rootId = null;
  frozen = false;
  nodes = {};
  childrenByParent = Object.create(null);
  currentNodeId = null;
  mode = "reader";
  view = { x: 0, y: 0, scale: 1 };
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
  loadingTimers.clear();
  readerMain = breadcrumbEl = viewport = world = edgesSvg = null;
  ask = askText = askGo = zoomLabel = hintEl = bannerEl = null;
  hintNotice = bannerNotice = null;
  composerInner = composerText = composerSend = null;
  paletteEl = palText = palResults = null;
  shareMenu = confirmEl = null;
  reduceMotion = false;
  reduceMotionMql = null;
  coreHooks = defaultCoreHooks();
}

export function setCurrentNodeId(id){ currentNodeId = id; }
export function setModeValue(value){ mode = value; }
export function setClosedState(value, reason){ closed = !!value; closedReason = reason || null; }
export function setAgentAttached(value){ agentAttached = !!value; }
export function setAgentReason(value){ agentReason = value || null; }
export function setConnLost(value){ connLost = !!value; }
export function resetSseFails(){ sseFails = 0; }
export function incrementSseFails(){ sseFails += 1; return sseFails; }
export function setCanvasBuilt(value){ canvasBuilt = !!value; }
export function setCanvasFramed(value){ canvasFramed = !!value; }
export function setViewAdjusted(value){ viewAdjusted = !!value; }
export function nextOrder(){ return orderCounter++; }
  // ---------- helpers ----------
export function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "n-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }
export function truncate(s, n){ return sharedTruncate(s, n); }
export function registerNode(node) {
    if (!node) return node;
    var previous = nodes[node.id];
    if (previous) unregisterNode(previous.id);
    nodes[node.id] = node;
    if (node.parent_id != null) {
      var siblings = childrenByParent[node.parent_id];
      if (!siblings) siblings = childrenByParent[node.parent_id] = [];
      siblings.push(node);
    }
    return node;
  }
export function unregisterNode(id) {
    var node = nodes[id];
    if (!node) return null;
    if (node.parent_id != null) {
      var siblings = childrenByParent[node.parent_id];
      if (siblings) {
        var index = siblings.indexOf(node);
        if (index !== -1) siblings.splice(index, 1);
        if (!siblings.length) delete childrenByParent[node.parent_id];
      }
    }
    delete nodes[id];
    return node;
  }
export function childrenOf(id) { return childrenByParent[id] ? childrenByParent[id].slice() : []; }
export function anchorStart(n){ return (n.origin && n.origin.anchor) ? n.origin.anchor.offset_start : 1e9; }
export function lineageNodes(id){ var arr=[], n=nodes[id], guard={}; while(n && !guard[n.id]){ guard[n.id]=1; arr.push(n); n = n.parent_id ? nodes[n.parent_id] : null; } return arr.reverse(); }
export function isVisible(node, cache){
    if (cache && Object.prototype.hasOwnProperty.call(cache, node.id)) return cache[node.id];
    var trail = [], p = node.parent_id ? nodes[node.parent_id] : null, visible = true;
    while(p){
      if (cache && Object.prototype.hasOwnProperty.call(cache, p.id)){ visible = cache[p.id]; break; }
      trail.push(p);
      p = p.parent_id ? nodes[p.parent_id] : null;
    }
    if (cache){
      for (var i = trail.length - 1; i >= 0; i--){
        cache[trail[i].id] = visible;
        if (trail[i].collapsed) visible = false;
      }
      cache[node.id] = visible;
    } else {
      for (var j = 0; j < trail.length; j++) if (trail[j].collapsed) return false;
    }
    return visible;
  }
export function fontPx(node, base){ return Math.round(base * (node.font_scale || 1)); }
export function nodeOrder(a,b){
    return sharedNodeOrder(a, b);
  }
function branchTypeOf(n){
    return branchTypeOfNode(n);
  }
export function isSelectionBranch(n){ return branchTypeOf(n) === BRANCH_SELECTION; }
export function isFollowup(n){ return branchTypeOf(n) === BRANCH_FOLLOWUP; }
export function followupsOf(id){
    return childrenOf(id).filter(isFollowup).sort(nodeOrder);
  }
export function nodeBounds(n){
    return sharedNodeBounds(n, { effH: coreHooks.effH });
  }
export function unionBounds(a,b){
    return sharedUnionBounds(a, b);
  }
export function shiftBounds(b, dx, dy){
    return sharedShiftBounds(b, dx, dy);
  }
export function boundsOverlap(a,b){
    return sharedBoundsOverlap(a, b);
  }
export function sessionPhase(){
    if (frozen) return "frozen";
    if (closed) return "closed";
    if (connLost || !agentAttached) return "away";
    return "live";
  }
  var reduceMotion = false, reduceMotionMql = null;
  function setReduceMotion(e){ reduceMotion = !!(e && e.matches); }
function initReduceMotion(scope){
  if (window.matchMedia){
    reduceMotionMql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(reduceMotionMql);
    if (reduceMotionMql.addEventListener) scope.listen(reduceMotionMql, "change", setReduceMotion);
    else if (reduceMotionMql.addListener) {
      reduceMotionMql.addListener(setReduceMotion);
      scope.addCleanup(function(){ reduceMotionMql?.removeListener(setReduceMotion); });
    }
  }
}
export function shouldReduceMotion(){ return reduceMotion; }
export function motionSourceFromEvent(e){ return (e && e.detail !== 0) ? "pointer" : "keyboard"; }
export function playLandingCue(el, cls){
    if (!el || document.hidden) return;
    cls = cls || "flash";
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    if (shouldReduceMotion()){
      setTimeout(function(){ el.classList.remove(cls); }, 180);
      return;
    }
    requestAnimationFrame(function(){ el.classList.remove(cls); });
  }
export function setSurfaceOrigin(el, anchorRect){
    if (!el || !anchorRect) return;
    var er = el.getBoundingClientRect();
    var ax = anchorRect.left + anchorRect.width / 2;
    var ay = anchorRect.top + anchorRect.height / 2;
    var ox = Math.max(0, Math.min(er.width, ax - er.left));
    var oy;
    if (anchorRect.bottom <= er.top) oy = 0;
    else if (anchorRect.top >= er.bottom) oy = er.height;
    else oy = Math.max(0, Math.min(er.height, ay - er.top));
    el.style.transformOrigin = Math.round(ox) + "px " + Math.round(oy) + "px";
  }

  // Bring a node to the human in whichever view they're in: the reader opens it
  // (streaming answers render live), the canvas dives to the card and flashes it.
export function goToNode(node, source){
    if (!node) return;
    if (mode === "canvas"){
      coreHooks.ensureCanvasBuilt();
      coreHooks.diveToNode(node, source);
      if (node.el) playLandingCue(node.el, "flash");
    } else {
      coreHooks.openNode(node.id);
    }
  }
export function lensLabel(key){ return sharedLensLabel(key); }
export function lensBadgeHtml(key){ return '<span class="lens-badge">' + escapeHtml(lensLabel(key)) + '</span>'; }

  // ---------- loading placeholder (pending answers) ----------
  var LOADING_BUNNY_HTML = '<span class="loading-bunny" aria-hidden="true">' + BUNNY_MARK_SVG + '</span>';
export function buildLoading(node){
    if (node && node.error){
      var errWrap = document.createElement("div");
      errWrap.className = "loading provider-error";
      var title = document.createElement("div");
      title.className = "provider-error-title";
      title.textContent = "Provider request failed";
      var msg = document.createElement("div");
      msg.className = "provider-error-msg";
      msg.textContent = node.error.message || "The model provider returned an error.";
      var retry = document.createElement("button");
      retry.className = "provider-retry";
      retry.type = "button";
      retry.textContent = "Retry";
      retry.disabled = node.error.retryable === false;
      retry.addEventListener("click", function(e){
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
    var wrap = document.createElement("div");
    wrap.className = "loading";
    var st = document.createElement("div");
    st.className = "loading-status";
    st.innerHTML = LOADING_BUNNY_HTML +
      '<span class="shimmer-text ll-live">Thinking</span>' +
      '<span class="ll-stalled">Saved — waiting for the agent</span>' +
      '<span class="ll-closed">Saved — answered when you reopen this hole</span>' +
      '<span class="ll-frozen">Unanswered when this snapshot was exported</span>' +
      '<span class="loading-time" data-start="' + (node._startTs || Date.now()) + '"></span>';
    loadingTimers.add(st.querySelector(".loading-time"));
    var sk = document.createElement("div");
    sk.innerHTML = '<div class="sk-line w1"></div><div class="sk-line w2"></div><div class="sk-line w3"></div><div class="sk-line w4"></div>';
    wrap.appendChild(st);
    wrap.appendChild(sk);
    return wrap;
  }
function buildConvertProgress(node, pdfExt, committed){
    var done = node._pdfProgress ? node._pdfProgress.done : 0;
    var total = node._pdfProgress ? node._pdfProgress.total : (pdfExt.pages ? pdfExt.pages.length : 0);
    var wrap = document.createElement("div");
    wrap.className = "rh-pdf-convert-progress" + (committed ? "" : " loading rh-pdf-converting");
    var st = document.createElement("div"); st.className = "loading-status";
    var label = "Creating text version";
    if (committed && done > 0 && done < total) label += " — page " + done + " of " + total;
    else if (!committed && total) label += " — " + total + (total === 1 ? " page" : " pages");
    st.innerHTML = (committed ? "" : LOADING_BUNNY_HTML) + '<span class="shimmer-text">' + label + '</span>';
    var cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "node-btn rh-pdf-convert-cancel"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", function(event){ event.stopPropagation(); cancel.disabled = true; postBrowserEvent({ type: "convert_cancel", node_id: node.id }); });
    st.appendChild(cancel);
    wrap.appendChild(st);
    if (!committed){
      var sk = document.createElement("div");
      sk.innerHTML = '<div class="sk-line w1"></div><div class="sk-line w2"></div><div class="sk-line w3"></div><div class="sk-line w4"></div>';
      wrap.appendChild(sk);
    }
    return wrap;
  }
export function visualSurfaceKey(node, base){
    return (base === CANVAS_BASE ? "canvas:" : "reader:") + ((node && node.id) || "unknown");
  }
  function mountDocMedia(dc, node, base){
    var surfaceKey = visualSurfaceKey(node, base);
    mountVisuals(dc, surfaceKey);
    if (typeof coreHooks.mountDocImages === "function") coreHooks.mountDocImages(dc, node, base, surfaceKey);
  }
  // A pending node that has streamed content renders it live: the words so far,
  // a breathing caret at the end of the text, and a quiet status row beneath.
export function fillStreaming(dc, node, surfaceKey){
    dc.innerHTML = node.html || "";
    var caret = document.createElement("span");
    caret.className = "stream-caret";
    var last = dc.lastElementChild;
    if (last && (last.tagName === "UL" || last.tagName === "OL")) last = last.lastElementChild || last;
    if (last && /^(P|H[1-6]|LI)$/.test(last.tagName)) last.appendChild(caret);
    else dc.appendChild(caret);
    var st = document.createElement("div");
    st.className = "stream-status";
    st.innerHTML = '<span class="shimmer-text ll-live">Writing</span>' +
      '<span class="ll-stalled">Paused — waiting for the agent</span>' +
      '<span class="ll-closed">Saved — answered in full when you reopen this hole</span>' +
      '<span class="ll-frozen">Unfinished when this snapshot was exported</span>' +
      '<span class="loading-time" data-start="' + (node._startTs || Date.now()) + '"></span>';
    loadingTimers.add(st.querySelector(".loading-time"));
    dc.appendChild(st);
    surfaceKey = surfaceKey || ("stream:" + ((node && node.id) || "unknown"));
    mountVisuals(dc, surfaceKey);
    if (typeof coreHooks.mountDocImages === "function") coreHooks.mountDocImages(dc, node, null, surfaceKey);
  }
  function formatElapsed(ms){
    var s = Math.floor(ms / 1000);
    if (s < 3) return "";
    if (s < 60) return s + "s";
    return Math.floor(s / 60) + "m " + (s % 60) + "s";
  }
function updateLoadingTimers(){
    if (closed) return; // freeze timers once the session is over
    var now = Date.now();
    loadingTimers.forEach(function(el){
      if (!el || !el.isConnected){ loadingTimers.delete(el); return; }
      var t = Number(el.getAttribute("data-start")) || 0;
      if (t) el.textContent = formatElapsed(now - t);
    });
}

  // ---------- shared document content ----------
export function disposeNodeContent(node){
    if (!node || !node._contentDisposers) return;
    Array.from(node._contentDisposers).forEach(function(dispose){ dispose(); });
    node._contentDisposers.clear();
  }
export function buildDocContent(node, base){
    coreHooks.ensureNodeHtml(node);
    var dc = document.createElement("div");
    dc.className = "doc-content md";
    dc.dataset.nodeId = node.id;
    dc.style.fontSize = fontPx(node, base) + "px";
    if (node.status === "pending"){
      if (node.html) fillStreaming(dc, node, visualSurfaceKey(node, base));
      else dc.appendChild(buildLoading(node));
    }
    else {
      var disposePdf = coreHooks.mountPdfView ? coreHooks.mountPdfView(dc, node) : null;
      if (disposePdf){
        if (!node._contentDisposers) node._contentDisposers = new Set();
        var dispose = function(){ node._contentDisposers.delete(dispose); disposePdf(); };
        node._contentDisposers.add(dispose);
        dc._rhDispose = dispose;
      } else {
        dc.innerHTML = node.html || "";
        var pdfExt = node.extensions && node.extensions.pdf;
        if (pdfExt && pdfExt.converting){
          // Until the first converted chunk lands the body is still the raw
          // line-per-line extraction — never show that; show a loading state.
          var committed = String(node.md || "") !== String(pdfExt.original_markdown != null ? pdfExt.original_markdown : "");
          if (!committed) dc.innerHTML = "";
          dc.prepend(buildConvertProgress(node, pdfExt, committed));
        }
        mountDocMedia(dc, node, base);
      }
    }
    return dc;
  }

export function toggleTheme(){
  var cur = document.documentElement.getAttribute("data-theme");
  var next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("rh-theme", next); } catch(e){}
}

export function flashHint(msg){
  hintNotice.show({ message: msg, duration: 4000 });
}
