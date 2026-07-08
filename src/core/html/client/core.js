/*
 * Browser-runtime chunk. These strings are concatenated in order by
 * ../client-script.js so the served page remains self-contained.
 */
export const CLIENT_CORE = `
  var SVGNS = "http://www.w3.org/2000/svg";
  var DEFAULT_ROOT = { w: 480, h: 580 };
  var DEFAULT_CHILD = { w: 420, h: 460 };
  var MIN_SCALE = 0.15, MAX_SCALE = 2.5;
  var READER_BASE = 17, CANVAS_BASE = 14, MIN_FS = 0.7, MAX_FS = 2.4;
  var BRANCH_SELECTION = "selection", BRANCH_FOLLOWUP = "followup";
  var TREE_PARENT_GAP = 70, TREE_STACK_GAP = 30;

  var rootId = hydration.root_id;
  var frozen = !!hydration.frozen; // read-only exported snapshot
  var nodes = {};
  var currentNodeId = rootId;
  var mode = "reader";
  var view = { x: 0, y: 0, scale: 1 };
  var closed = frozen;
  var closedReason = frozen ? "frozen" : null;
  var agentAttached = hydration.agent_attached !== false;
  var agentReason = null;
  var connLost = false;
  var sseFails = 0;
  var pendingAsk = null;
  var canvasBuilt = false;   // canvas DOM is built lazily on first entry
  var canvasFramed = false;  // frame-all runs once; afterwards the view is preserved
  var edgeRaf = 0;           // coalesces edge redraws during drag/resize/scroll
  var orderCounter = 0;

  // refs
  var readerMain = document.getElementById("reader-main");
  var sideEl = document.getElementById("reader-side");
  var breadcrumbEl = document.getElementById("breadcrumb");
  var viewport = document.getElementById("viewport");
  var world = document.getElementById("world");
  var edgesSvg = document.getElementById("edges");
  var ask = document.getElementById("ask");
  var askText = document.getElementById("ask-text");
  var askGo = document.getElementById("ask-go");
  var zoomLabel = document.getElementById("zoom-label");
  var hintEl = document.getElementById("hint");
  var bannerEl = document.getElementById("banner");
  var bannerTitle = document.getElementById("banner-title");
  var bannerMsg = document.getElementById("banner-msg");
  var composerInner = document.getElementById("composer-inner");
  var composerText = document.getElementById("composer-text");
  var composerSend = document.getElementById("composer-send");
  var actReader = document.getElementById("act-reader");
  var actCanvas = document.getElementById("act-canvas");
  var actSep = document.getElementById("act-sep");
  var sinceEl = document.getElementById("since");
  var sinceMsg = document.getElementById("since-msg");
  var paletteEl = document.getElementById("palette");
  var palText = document.getElementById("pal-text");
  var palResults = document.getElementById("pal-results");
  var peekEl = document.getElementById("peek");
  var shareMenu = document.getElementById("sharemenu");
  var confirmEl = document.getElementById("confirm");

  // ---------- helpers ----------
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "n-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }
  function esc(s){ var d=document.createElement("div"); d.textContent = (s==null?"":String(s)); return d.innerHTML; }
  function truncate(s, n){ s = String(s); return s.length > n ? s.slice(0, n) + "…" : s; }
  function childrenOf(id) { var out=[]; for (var k in nodes) if (nodes[k].parent_id === id) out.push(nodes[k]); return out; }
  function anchorStart(n){ return (n.origin && n.origin.anchor) ? n.origin.anchor.offset_start : 1e9; }
  function lineageNodes(id){ var arr=[], n=nodes[id], guard={}; while(n && !guard[n.id]){ guard[n.id]=1; arr.push(n); n = n.parent_id ? nodes[n.parent_id] : null; } return arr.reverse(); }
  function isVisible(node){ var p = node.parent_id ? nodes[node.parent_id] : null; while(p){ if(p.collapsed) return false; p = p.parent_id ? nodes[p.parent_id] : null; } return true; }
  function fontPx(node, base){ return Math.round(base * (node.font_scale || 1)); }
  function nodeOrder(a,b){
    return ((a._order||0) - (b._order||0)) || String(a.id || "").localeCompare(String(b.id || ""));
  }
  function branchTypeOf(n){
    if (!n || (!n.origin && !n.parent_id)) return null;
    var t = n.origin && n.origin.branch_type;
    if (t === BRANCH_SELECTION || t === BRANCH_FOLLOWUP) return t;
    return n.origin && n.origin.selected_text ? BRANCH_SELECTION : BRANCH_FOLLOWUP;
  }
  function isSelectionBranch(n){ return branchTypeOf(n) === BRANCH_SELECTION; }
  // A follow-up is a branch with no selection: asked from the composer, shown
  // as an inline chat turn beneath its parent document. Legacy nodes without an
  // explicit branch_type fall back to selected_text: present means selection,
  // absent means follow-up.
  function isFollowup(n){ return branchTypeOf(n) === BRANCH_FOLLOWUP; }
  function followupsOf(id){
    return childrenOf(id).filter(isFollowup).sort(nodeOrder);
  }
  function nodeBounds(n){
    return { minX: n.x, minY: n.y, maxX: n.x + n.w, maxY: n.y + effH(n) };
  }
  function unionBounds(a,b){
    if (!a) return b;
    if (!b) return a;
    return { minX: Math.min(a.minX,b.minX), minY: Math.min(a.minY,b.minY),
      maxX: Math.max(a.maxX,b.maxX), maxY: Math.max(a.maxY,b.maxY) };
  }
  function shiftBounds(b, dx, dy){
    return { minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy };
  }
  function boundsOverlap(a,b){
    return !!(a && b && a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY);
  }
  function agentDown(){ return closed || connLost || !agentAttached; }
  var reduceMotion = false, reduceMotionMql = null;
  function setReduceMotion(e){ reduceMotion = !!(e && e.matches); }
  if (window.matchMedia){
    reduceMotionMql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(reduceMotionMql);
    if (reduceMotionMql.addEventListener) reduceMotionMql.addEventListener("change", setReduceMotion);
    else if (reduceMotionMql.addListener) reduceMotionMql.addListener(setReduceMotion);
  }
  function shouldReduceMotion(){ return reduceMotion; }
  function motionSourceFromEvent(e){ return (e && e.detail !== 0) ? "pointer" : "keyboard"; }
  function bezierCoord(t, a, b){
    var mt = 1 - t;
    return 3 * mt * mt * t * a + 3 * mt * t * t * b + t * t * t;
  }
  function bezierSlope(t, a, b){
    return 3 * (1 - t) * (1 - t) * a + 6 * (1 - t) * t * (b - a) + 3 * t * t * (1 - b);
  }
  function cubicBezier(x1, y1, x2, y2, x){
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var t = x, i, xAt, slope;
    for (i = 0; i < 5; i++){
      xAt = bezierCoord(t, x1, x2) - x;
      slope = bezierSlope(t, x1, x2);
      if (Math.abs(xAt) < 0.001 || !slope) break;
      t -= xAt / slope;
    }
    if (t < 0 || t > 1){
      var lo = 0, hi = 1;
      t = x;
      for (i = 0; i < 8; i++){
        xAt = bezierCoord(t, x1, x2);
        if (xAt < x) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return bezierCoord(t, y1, y2);
  }
  function easeOutMotion(k){ return cubicBezier(0.23, 1, 0.32, 1, k); }
  function easeInOutMotion(k){ return cubicBezier(0.77, 0, 0.175, 1, k); }
  function playLandingCue(el, cls){
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
  function setSurfaceOrigin(el, anchorRect){
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
  function isUnread(n){ return n.status === "answered" && !n.read && n.id !== rootId; }
  function markRead(node){
    if (!node || node.read) return;
    node.read = true;
    if (!frozen && !closed) post({ type: "node_update", node_id: node.id, read: true });
    if (node.el) node.el.classList.remove("unread");
    refreshAmbient();
    updateSince();
  }
  function unreadNodes(){
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
  function goToNode(node, source){
    if (!node) return;
    if (mode === "canvas"){
      ensureCanvasBuilt();
      diveToNode(node, source);
      flashNode(node);
      if (node.status === "answered") markRead(node);
    } else {
      openNode(node.id);
    }
  }
  function flashNode(node){
    if (!node.el) return;
    playLandingCue(node.el, "flash");
  }
  // The ambient chip only tracks answers currently being written.
  function refreshAmbient(){
    var writing = pendingNodes().length;
    var label = "", cls = "activity on";
    if (writing > 0 && !agentDown()){ label = writing + " writing…"; cls += " writing"; }
    else cls = "activity";
    var chips = [actReader, actCanvas];
    for (var i = 0; i < chips.length; i++){
      chips[i].className = cls;
      chips[i].innerHTML = label ? '<span class="act-dot"></span>' + esc(label) : "";
      chips[i].title = "Watch it being written";
    }
    if (actSep) actSep.style.display = label ? "" : "none";
  }
  function onActivityClick(e){
    var source = motionSourceFromEvent(e);
    var pend = pendingNodes();
    if (pend.length) goToNode(pend[pend.length - 1], source);
  }
  actReader.addEventListener("click", onActivityClick);
  actCanvas.addEventListener("click", onActivityClick);

  // "Since you left" strip — a re-entry announcement only: armed at load when
  // unread answers were waiting, retired as they're opened (or on dismiss).
  // Answers landing live mid-session never resurrect it.
  var sinceDismissed = false, sinceArmed = false;
  function updateSince(){
    if (!sinceArmed || sinceDismissed || frozen){ sinceEl.classList.remove("visible"); return; }
    var n = unreadNodes().length;
    if (!n){ sinceArmed = false; sinceEl.classList.remove("visible"); return; }
    sinceMsg.textContent = n === 1
      ? "An answer arrived while you were away"
      : n + " answers arrived while you were away";
    sinceEl.classList.add("visible");
  }
  document.getElementById("since-show").addEventListener("click", function(e){
    var un = unreadNodes();
    if (un.length) goToNode(un[0], motionSourceFromEvent(e));
  });
  document.getElementById("since-x").addEventListener("click", function(){
    sinceDismissed = true;
    sinceEl.classList.remove("visible");
  });

  // ---------- lenses (one-tap preset asks) ----------
  // Each lens sends its full crafted question to the agent, but every UI
  // surface shows only the short label (origin.lens carries the key).
  var LENSES = {
    explain: { label: "Explain", q: "Explain this clearly and precisely: what it means here, why it matters, and the key intuition an expert would want me to take away." },
    eli5: { label: "ELI5", q: "Explain this like I'm five: start with a concrete everyday analogy, then translate the analogy back to the real thing, one level more precise." },
    example: { label: "Example", q: "Show this in action with one concrete worked example: realistic, minimal, step by step. Use runnable code if it's code-shaped, real numbers if it's quantitative." },
    deeper: { label: "Go Deeper", q: "Go one level deeper than this document does: the underlying mechanism, the important edge cases, and what experts know about this that introductory treatments gloss over." }
  };
  function lensLabel(key){ return LENSES[key] ? LENSES[key].label : String(key || ""); }
  function lensBadgeHtml(key){ return '<span class="lens-badge">' + esc(lensLabel(key)) + '</span>'; }

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
  function buildLoading(node){
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
  function visualSurfaceKey(node, base){
    return (base === CANVAS_BASE ? "canvas:" : "reader:") + ((node && node.id) || "unknown");
  }
  function mountDocVisuals(dc, node, base){
    if (typeof mountVisuals === "function") mountVisuals(dc, visualSurfaceKey(node, base));
  }
  // A pending node that has streamed content renders it live: the words so far,
  // a breathing caret at the end of the text, and a quiet status row beneath.
  function fillStreaming(dc, node, surfaceKey){
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
    if (typeof mountVisuals === "function") mountVisuals(dc, surfaceKey || ("stream:" + ((node && node.id) || "unknown")));
  }
  function formatElapsed(ms){
    var s = Math.floor(ms / 1000);
    if (s < 3) return "";
    if (s < 60) return s + "s";
    return Math.floor(s / 60) + "m " + (s % 60) + "s";
  }
  setInterval(function(){
    if (closed) return; // freeze timers once the session is over
    var els = document.querySelectorAll(".loading-time");
    for (var i = 0; i < els.length; i++){
      var t = Number(els[i].getAttribute("data-start")) || 0;
      if (t) els[i].textContent = formatElapsed(Date.now() - t);
    }
  }, 1000);

  // ---------- shared document content ----------
  function buildDocContent(node, base){
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
      mountDocVisuals(dc, node, base);
    }
    return dc;
  }

`;
