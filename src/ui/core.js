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
export var currentNodeId = null;
export var mode = "reader";
export var view = { x: 0, y: 0, scale: 1 };
export var closed = false;
export var closedReason = null;
export var agentAttached = true;
export var agentReason = null;
export var connLost = false;
var sseFails = 0;
export var canvasBuilt = false;   // canvas DOM is built lazily on first entry
export var canvasFramed = false;  // frame-all runs once; afterwards the view is preserved
export var viewAdjusted = false;  // only user-adjusted camera state is persisted
var orderCounter = 0;

// refs
export var readerMain = null;
export var sideEl = null;
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
var actReader = null;
var actCanvas = null;
var actSep = null;
var sinceEl = null;
var sinceMsg = null;
export var paletteEl = null;
export var palText = null;
export var palResults = null;
export var peekEl = null;
export var shareMenu = null;
export var confirmEl = null;

function defaultCoreHooks(){
  return {
    post: function(){ return Promise.resolve({ ok: true }); },
    ensureCanvasBuilt: function(){},
    diveToNode: function(){},
    openNode: function(){},
    mountDocImages: null,
    effH: function(n){ return n.h; }
  };
}

var coreHooks = defaultCoreHooks();
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
  sinceDismissed = false;
  sinceArmed = false;

  readerMain = document.getElementById("reader-main");
  sideEl = document.getElementById("reader-side");
  breadcrumbEl = document.getElementById("breadcrumb");
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
  actReader = document.getElementById("act-reader");
  actCanvas = document.getElementById("act-canvas");
  actSep = document.getElementById("act-sep");
  sinceEl = document.getElementById("since");
  sinceMsg = document.getElementById("since-msg");
  paletteEl = document.getElementById("palette");
  palText = document.getElementById("pal-text");
  palResults = document.getElementById("pal-results");
  peekEl = document.getElementById("peek");
  shareMenu = document.getElementById("sharemenu");
  confirmEl = document.getElementById("confirm");

  initReduceMotion(coreScope);
  coreScope.listen(actReader, "click", onActivityClick);
  coreScope.listen(actCanvas, "click", onActivityClick);
  coreScope.listen(document.getElementById("since-show"), "click", function(e){
    var un = unreadNodes();
    if (un.length) goToNode(un[0], motionSourceFromEvent(e));
  });
  coreScope.listen(document.getElementById("since-x"), "click", function(){
    sinceDismissed = true;
    sinceEl.classList.remove("visible");
  });
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
    resetCoreState();
  }
}

function resetCoreState(){
  hydration = null;
  rootId = null;
  frozen = false;
  nodes = {};
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
  readerMain = sideEl = breadcrumbEl = viewport = world = edgesSvg = null;
  ask = askText = askGo = zoomLabel = hintEl = bannerEl = null;
  hintNotice = bannerNotice = null;
  composerInner = composerText = composerSend = null;
  actReader = actCanvas = actSep = null;
  sinceEl = sinceMsg = paletteEl = palText = palResults = null;
  peekEl = shareMenu = confirmEl = null;
  sinceDismissed = false;
  sinceArmed = false;
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
export function armSince(){ sinceArmed = true; }

  // ---------- helpers ----------
export function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "n-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }
export function truncate(s, n){ return sharedTruncate(s, n); }
export function childrenOf(id) { var out=[]; for (var k in nodes) if (nodes[k].parent_id === id) out.push(nodes[k]); return out; }
export function anchorStart(n){ return (n.origin && n.origin.anchor) ? n.origin.anchor.offset_start : 1e9; }
export function lineageNodes(id){ var arr=[], n=nodes[id], guard={}; while(n && !guard[n.id]){ guard[n.id]=1; arr.push(n); n = n.parent_id ? nodes[n.parent_id] : null; } return arr.reverse(); }
export function isVisible(node){ var p = node.parent_id ? nodes[node.parent_id] : null; while(p){ if(p.collapsed) return false; p = p.parent_id ? nodes[p.parent_id] : null; } return true; }
export function fontPx(node, base){ return Math.round(base * (node.font_scale || 1)); }
export function nodeOrder(a,b){
    return sharedNodeOrder(a, b);
  }
export function branchTypeOf(n){
    return branchTypeOfNode(n);
  }
export function isSelectionBranch(n){ return branchTypeOf(n) === BRANCH_SELECTION; }
  // A follow-up is a branch with no selection: asked from the composer, shown
  // as an inline chat turn beneath its parent document. Legacy nodes without an
  // explicit branch_type fall back to selected_text: present means selection,
  // absent means follow-up.
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
export function agentDown(){ return closed || connLost || !agentAttached; }
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

  // ---------- read / unread ----------
  // Fresh answers stay "unread" (dot on the card and the sidebar item) until
  // the human actually opens them. The flag persists,
  // so answers that land while you're away are waiting with a dot on re-entry.
export function isUnread(n){ return n.status === "answered" && !n.read && n.id !== rootId; }
export function markRead(node){
    if (!node || node.read) return;
    node.read = true;
    if (!frozen && !closed) coreHooks.post({ type: "node_update", node_id: node.id, read: true });
    if (node.el) node.el.classList.remove("unread");
    refreshAmbient();
    updateSince();
  }
export function unreadNodes(){
    var out = [];
    for (var k in nodes) if (isUnread(nodes[k])) out.push(nodes[k]);
    out.sort(function(a,b){ return (a._order||0) - (b._order||0); });
    return out;
  }
function pendingNodes(){
    var out = [];
    for (var k in nodes) if (nodes[k].status === "pending") out.push(nodes[k]);
    out.sort(function(a,b){ return (a._order||0) - (b._order||0); });
    return out;
  }
  // Bring a node to the human in whichever view they're in: the reader opens it
  // (streaming answers render live), the canvas dives to the card and flashes it.
export function goToNode(node, source){
    if (!node) return;
    if (mode === "canvas"){
      coreHooks.ensureCanvasBuilt();
      coreHooks.diveToNode(node, source);
      if (node.el) playLandingCue(node.el, "flash");
      if (node.status === "answered") markRead(node);
    } else {
      coreHooks.openNode(node.id);
    }
  }
  // The ambient chip only tracks answers currently being written.
export function refreshAmbient(){
    var writing = pendingNodes().length;
    var label = "", cls = "activity on";
    if (writing > 0 && !agentDown()){ label = writing + " writing…"; cls += " writing"; }
    else cls = "activity";
    var chips = [actReader, actCanvas];
    for (var i = 0; i < chips.length; i++){
      chips[i].className = cls;
      var dot = chips[i].querySelector(".act-dot");
      var text = chips[i].querySelector(".act-label");
      if (!dot || !text) {
        dot = document.createElement("span"); dot.className = "act-dot";
        text = document.createElement("span"); text.className = "act-label";
        chips[i].replaceChildren(dot, text);
      }
      text.textContent = label;
      chips[i].title = "Watch it being written";
    }
    if (actSep) actSep.style.display = label ? "" : "none";
  }
  function onActivityClick(e){
    var source = motionSourceFromEvent(e);
    var pend = pendingNodes();
    if (pend.length) goToNode(pend[pend.length - 1], source);
  }
  // "Since you left" strip — a re-entry announcement only: armed at load when
  // unread answers were waiting, retired as they're opened (or on dismiss).
  // Answers landing live mid-session never resurrect it.
  var sinceDismissed = false, sinceArmed = false;
export function updateSince(){
    if (!sinceArmed || sinceDismissed || frozen){ sinceEl.classList.remove("visible"); return; }
    var n = unreadNodes().length;
    if (!n){ sinceArmed = false; sinceEl.classList.remove("visible"); return; }
    sinceMsg.textContent = n === 1
      ? "An answer arrived while you were away"
      : n + " answers arrived while you were away";
    sinceEl.classList.add("visible");
  }
export function lensLabel(key){ return sharedLensLabel(key); }
export function lensBadgeHtml(key){ return '<span class="lens-badge">' + escapeHtml(lensLabel(key)) + '</span>'; }

  // ---------- loading placeholder (pending answers) ----------
  var LOADING_BUNNY_HTML = '<span class="loading-bunny" aria-hidden="true">' +
    '<svg width="22" height="17" viewBox="0 0 44 34" fill="currentColor" focusable="false" aria-hidden="true">' +
    '<circle cx="8.2" cy="18.2" r="3.6"/>' +
    '<path d="M16.8 27.4c-6.4 0-11.1-3.6-11.1-8.4 0-5.1 4.8-8.7 11.4-8.7 6.7 0 11.9 3.9 11.9 8.9 0 4.9-4.9 8.2-12.2 8.2z"/>' +
    '<path d="M29.5 21.2c-4 0-7.1-2.7-7.1-6.2 0-3.6 3.2-6.3 7.2-6.3 4.1 0 7.3 2.7 7.3 6.2 0 3.7-3.2 6.3-7.4 6.3z"/>' +
    '<path d="M27.4 10.4c-.9.3-1.9-.2-2.2-1.1L22.7 2.7c-.4-1 .1-2 1.1-2.4 1-.3 1.9.2 2.3 1.1l2.8 6.7c.4 1-.3 1.9-1.5 2.3z"/>' +
    '<path d="M31.9 10.2c-1 .1-1.8-.5-2-1.5l-1-7.1c-.1-1 .6-1.9 1.6-2 1-.1 1.8.6 2 1.6l1.1 7.1c.1 1-.6 1.8-1.7 1.9z"/>' +
    '<path d="M11.5 28.2h7.6c.5 0 .8.4.6.9-.1.3-.4.6-.8.6l-8.3 1.4c-.8.1-1.5-.5-1.5-1.3 0-.9.8-1.6 2.4-1.6z"/>' +
    '</svg>' +
    '</span>';
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
    var sk = document.createElement("div");
    sk.innerHTML = '<div class="sk-line w1"></div><div class="sk-line w2"></div><div class="sk-line w3"></div><div class="sk-line w4"></div>';
    wrap.appendChild(st);
    wrap.appendChild(sk);
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
    var els = document.querySelectorAll(".loading-time");
    for (var i = 0; i < els.length; i++){
      var t = Number(els[i].getAttribute("data-start")) || 0;
      if (t) els[i].textContent = formatElapsed(Date.now() - t);
    }
}

  // ---------- shared document content ----------
export function buildDocContent(node, base){
    var dc = document.createElement("div");
    dc.className = "doc-content md";
    dc.dataset.nodeId = node.id;
    dc.style.fontSize = fontPx(node, base) + "px";
    if (node.status === "pending"){
      if (node.html) fillStreaming(dc, node, visualSurfaceKey(node, base));
      else dc.appendChild(buildLoading(node));
    }
    else {
      dc.innerHTML = node.html || "";
      mountDocMedia(dc, node, base);
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
