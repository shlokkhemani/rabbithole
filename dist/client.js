var RabbitholeClient = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/ui/entry.js
  var entry_exports = {};
  __export(entry_exports, {
    startRabbithole: () => startRabbithole
  });

  // src/ui/core.js
  var SVGNS = "http://www.w3.org/2000/svg";
  var DEFAULT_ROOT = { w: 480, h: 580 };
  var DEFAULT_CHILD = { w: 420, h: 460 };
  var MIN_SCALE = 0.15;
  var MAX_SCALE = 2.5;
  var READER_BASE = 17;
  var CANVAS_BASE = 14;
  var MIN_FS = 0.7;
  var MAX_FS = 2.4;
  var BRANCH_SELECTION = "selection";
  var BRANCH_FOLLOWUP = "followup";
  var TREE_PARENT_GAP = 70;
  var TREE_STACK_GAP = 30;
  var hydration = null;
  var rootId = null;
  var frozen = false;
  var nodes = {};
  var currentNodeId = null;
  var mode = "reader";
  var view = { x: 0, y: 0, scale: 1 };
  var closed = false;
  var closedReason = null;
  var agentAttached2 = true;
  var agentReason = null;
  var connLost2 = false;
  var sseFails = 0;
  var canvasBuilt = false;
  var canvasFramed = false;
  var orderCounter = 0;
  var readerMain = null;
  var sideEl2 = null;
  var breadcrumbEl = null;
  var viewport = null;
  var world = null;
  var edgesSvg = null;
  var ask = null;
  var askText = null;
  var askGo = null;
  var zoomLabel = null;
  var hintEl = null;
  var bannerEl = null;
  var bannerTitle = null;
  var bannerMsg = null;
  var composerInner = null;
  var composerText = null;
  var composerSend = null;
  var actReader = null;
  var actCanvas = null;
  var actSep = null;
  var sinceEl = null;
  var sinceMsg = null;
  var paletteEl = null;
  var palText = null;
  var palResults = null;
  var peekEl = null;
  var shareMenu = null;
  var confirmEl = null;
  var hintTimer = 0;
  var coreHooks = {
    post: function() {
      return Promise.resolve({ ok: true });
    },
    ensureCanvasBuilt: function() {
    },
    diveToNode: function() {
    },
    openNode: function() {
    },
    mountVisuals: null,
    mountDocImages: null,
    effH: function(n) {
      return n.h;
    }
  };
  function registerCoreHooks(hooks) {
    Object.assign(coreHooks, hooks || {});
  }
  function initCore(inputHydration) {
    hydration = inputHydration || {};
    rootId = hydration.root_id;
    frozen = !!hydration.frozen;
    nodes = {};
    currentNodeId = rootId;
    mode = "reader";
    view = { x: 0, y: 0, scale: 1 };
    closed = frozen;
    closedReason = frozen ? "frozen" : null;
    agentAttached2 = hydration.agent_attached !== false;
    agentReason = null;
    connLost2 = false;
    sseFails = 0;
    canvasBuilt = false;
    canvasFramed = false;
    orderCounter = 0;
    hintTimer = 0;
    sinceDismissed = false;
    sinceArmed = false;
    readerMain = document.getElementById("reader-main");
    sideEl2 = document.getElementById("reader-side");
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
    bannerTitle = document.getElementById("banner-title");
    bannerMsg = document.getElementById("banner-msg");
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
    initReduceMotion();
    actReader.addEventListener("click", onActivityClick);
    actCanvas.addEventListener("click", onActivityClick);
    document.getElementById("since-show").addEventListener("click", function(e) {
      var un = unreadNodes();
      if (un.length) goToNode2(un[0], motionSourceFromEvent(e));
    });
    document.getElementById("since-x").addEventListener("click", function() {
      sinceDismissed = true;
      sinceEl.classList.remove("visible");
    });
    setInterval(updateLoadingTimers, 1e3);
  }
  function setCurrentNodeId(id) {
    currentNodeId = id;
  }
  function setModeValue(value) {
    mode = value;
  }
  function setClosedState(value, reason) {
    closed = !!value;
    closedReason = reason || null;
  }
  function setAgentAttached(value) {
    agentAttached2 = !!value;
  }
  function setAgentReason(value) {
    agentReason = value || null;
  }
  function setConnLost(value) {
    connLost2 = !!value;
  }
  function resetSseFails() {
    sseFails = 0;
  }
  function incrementSseFails() {
    sseFails += 1;
    return sseFails;
  }
  function setCanvasBuilt(value) {
    canvasBuilt = !!value;
  }
  function setCanvasFramed(value) {
    canvasFramed = !!value;
  }
  function nextOrder() {
    return orderCounter++;
  }
  function armSince() {
    sinceArmed = true;
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "n-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }
  function truncate2(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n) + "\u2026" : s;
  }
  function childrenOf(id) {
    var out = [];
    for (var k in nodes) if (nodes[k].parent_id === id) out.push(nodes[k]);
    return out;
  }
  function anchorStart(n) {
    return n.origin && n.origin.anchor ? n.origin.anchor.offset_start : 1e9;
  }
  function lineageNodes2(id) {
    var arr = [], n = nodes[id], guard = {};
    while (n && !guard[n.id]) {
      guard[n.id] = 1;
      arr.push(n);
      n = n.parent_id ? nodes[n.parent_id] : null;
    }
    return arr.reverse();
  }
  function isVisible(node) {
    var p = node.parent_id ? nodes[node.parent_id] : null;
    while (p) {
      if (p.collapsed) return false;
      p = p.parent_id ? nodes[p.parent_id] : null;
    }
    return true;
  }
  function fontPx(node, base) {
    return Math.round(base * (node.font_scale || 1));
  }
  function nodeOrder(a, b) {
    return (a._order || 0) - (b._order || 0) || String(a.id || "").localeCompare(String(b.id || ""));
  }
  function branchTypeOf(n) {
    if (!n || !n.origin && !n.parent_id) return null;
    var t = n.origin && n.origin.branch_type;
    if (t === BRANCH_SELECTION || t === BRANCH_FOLLOWUP) return t;
    return n.origin && n.origin.selected_text ? BRANCH_SELECTION : BRANCH_FOLLOWUP;
  }
  function isSelectionBranch(n) {
    return branchTypeOf(n) === BRANCH_SELECTION;
  }
  function isFollowup(n) {
    return branchTypeOf(n) === BRANCH_FOLLOWUP;
  }
  function followupsOf(id) {
    return childrenOf(id).filter(isFollowup).sort(nodeOrder);
  }
  function nodeBounds(n) {
    return { minX: n.x, minY: n.y, maxX: n.x + n.w, maxY: n.y + coreHooks.effH(n) };
  }
  function unionBounds(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
      minX: Math.min(a.minX, b.minX),
      minY: Math.min(a.minY, b.minY),
      maxX: Math.max(a.maxX, b.maxX),
      maxY: Math.max(a.maxY, b.maxY)
    };
  }
  function shiftBounds(b, dx, dy) {
    return { minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy };
  }
  function boundsOverlap(a, b) {
    return !!(a && b && a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY);
  }
  function agentDown() {
    return closed || connLost2 || !agentAttached2;
  }
  var reduceMotion = false;
  var reduceMotionMql = null;
  function setReduceMotion(e) {
    reduceMotion = !!(e && e.matches);
  }
  function initReduceMotion() {
    if (window.matchMedia) {
      reduceMotionMql = window.matchMedia("(prefers-reduced-motion: reduce)");
      setReduceMotion(reduceMotionMql);
      if (reduceMotionMql.addEventListener) reduceMotionMql.addEventListener("change", setReduceMotion);
      else if (reduceMotionMql.addListener) reduceMotionMql.addListener(setReduceMotion);
    }
  }
  function shouldReduceMotion() {
    return reduceMotion;
  }
  function motionSourceFromEvent(e) {
    return e && e.detail !== 0 ? "pointer" : "keyboard";
  }
  function bezierCoord(t, a, b) {
    var mt = 1 - t;
    return 3 * mt * mt * t * a + 3 * mt * t * t * b + t * t * t;
  }
  function bezierSlope(t, a, b) {
    return 3 * (1 - t) * (1 - t) * a + 6 * (1 - t) * t * (b - a) + 3 * t * t * (1 - b);
  }
  function cubicBezier(x1, y1, x2, y2, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var t = x, i, xAt, slope;
    for (i = 0; i < 5; i++) {
      xAt = bezierCoord(t, x1, x2) - x;
      slope = bezierSlope(t, x1, x2);
      if (Math.abs(xAt) < 1e-3 || !slope) break;
      t -= xAt / slope;
    }
    if (t < 0 || t > 1) {
      var lo = 0, hi = 1;
      t = x;
      for (i = 0; i < 8; i++) {
        xAt = bezierCoord(t, x1, x2);
        if (xAt < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return bezierCoord(t, y1, y2);
  }
  function easeOutMotion(k) {
    return cubicBezier(0.23, 1, 0.32, 1, k);
  }
  function easeInOutMotion(k) {
    return cubicBezier(0.77, 0, 0.175, 1, k);
  }
  function playLandingCue(el, cls) {
    if (!el || document.hidden) return;
    cls = cls || "flash";
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    if (shouldReduceMotion()) {
      setTimeout(function() {
        el.classList.remove(cls);
      }, 180);
      return;
    }
    requestAnimationFrame(function() {
      el.classList.remove(cls);
    });
  }
  function setSurfaceOrigin(el, anchorRect) {
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
  function isUnread(n) {
    return n.status === "answered" && !n.read && n.id !== rootId;
  }
  function markRead(node) {
    if (!node || node.read) return;
    node.read = true;
    if (!frozen && !closed) coreHooks.post({ type: "node_update", node_id: node.id, read: true });
    if (node.el) node.el.classList.remove("unread");
    refreshAmbient();
    updateSince();
  }
  function unreadNodes() {
    var out = [];
    for (var k in nodes) if (isUnread(nodes[k])) out.push(nodes[k]);
    out.sort(function(a, b) {
      return (a._order || 0) - (b._order || 0);
    });
    return out;
  }
  function pendingNodes() {
    var out = [];
    for (var k in nodes) if (nodes[k].status === "pending") out.push(nodes[k]);
    out.sort(function(a, b) {
      return (a._order || 0) - (b._order || 0);
    });
    return out;
  }
  function goToNode2(node, source) {
    if (!node) return;
    if (mode === "canvas") {
      coreHooks.ensureCanvasBuilt();
      coreHooks.diveToNode(node, source);
      flashNode(node);
      if (node.status === "answered") markRead(node);
    } else {
      coreHooks.openNode(node.id);
    }
  }
  function flashNode(node) {
    if (!node.el) return;
    playLandingCue(node.el, "flash");
  }
  function refreshAmbient() {
    var writing = pendingNodes().length;
    var label = "", cls = "activity on";
    if (writing > 0 && !agentDown()) {
      label = writing + " writing\u2026";
      cls += " writing";
    } else cls = "activity";
    var chips = [actReader, actCanvas];
    for (var i = 0; i < chips.length; i++) {
      chips[i].className = cls;
      chips[i].innerHTML = label ? '<span class="act-dot"></span>' + esc(label) : "";
      chips[i].title = "Watch it being written";
    }
    if (actSep) actSep.style.display = label ? "" : "none";
  }
  function onActivityClick(e) {
    var source = motionSourceFromEvent(e);
    var pend = pendingNodes();
    if (pend.length) goToNode2(pend[pend.length - 1], source);
  }
  var sinceDismissed = false;
  var sinceArmed = false;
  function updateSince() {
    if (!sinceArmed || sinceDismissed || frozen) {
      sinceEl.classList.remove("visible");
      return;
    }
    var n = unreadNodes().length;
    if (!n) {
      sinceArmed = false;
      sinceEl.classList.remove("visible");
      return;
    }
    sinceMsg.textContent = n === 1 ? "An answer arrived while you were away" : n + " answers arrived while you were away";
    sinceEl.classList.add("visible");
  }
  var LENSES = {
    explain: { label: "Explain", q: "Explain this clearly and precisely: what it means here, why it matters, and the key intuition an expert would want me to take away." },
    eli5: { label: "ELI5", q: "Explain this like I'm five: start with a concrete everyday analogy, then translate the analogy back to the real thing, one level more precise." },
    example: { label: "Example", q: "Show this in action with one concrete worked example: realistic, minimal, step by step. Use runnable code if it's code-shaped, real numbers if it's quantitative." },
    deeper: { label: "Go Deeper", q: "Go one level deeper than this document does: the underlying mechanism, the important edge cases, and what experts know about this that introductory treatments gloss over." }
  };
  function lensLabel(key) {
    return LENSES[key] ? LENSES[key].label : String(key || "");
  }
  function lensBadgeHtml(key) {
    return '<span class="lens-badge">' + esc(lensLabel(key)) + "</span>";
  }
  var LOADING_BUNNY_HTML = '<span class="loading-bunny" aria-hidden="true"><svg width="22" height="17" viewBox="0 0 44 34" fill="currentColor" focusable="false" aria-hidden="true"><circle cx="8.2" cy="18.2" r="3.6"/><path d="M16.8 27.4c-6.4 0-11.1-3.6-11.1-8.4 0-5.1 4.8-8.7 11.4-8.7 6.7 0 11.9 3.9 11.9 8.9 0 4.9-4.9 8.2-12.2 8.2z"/><path d="M29.5 21.2c-4 0-7.1-2.7-7.1-6.2 0-3.6 3.2-6.3 7.2-6.3 4.1 0 7.3 2.7 7.3 6.2 0 3.7-3.2 6.3-7.4 6.3z"/><path d="M27.4 10.4c-.9.3-1.9-.2-2.2-1.1L22.7 2.7c-.4-1 .1-2 1.1-2.4 1-.3 1.9.2 2.3 1.1l2.8 6.7c.4 1-.3 1.9-1.5 2.3z"/><path d="M31.9 10.2c-1 .1-1.8-.5-2-1.5l-1-7.1c-.1-1 .6-1.9 1.6-2 1-.1 1.8.6 2 1.6l1.1 7.1c.1 1-.6 1.8-1.7 1.9z"/><path d="M11.5 28.2h7.6c.5 0 .8.4.6.9-.1.3-.4.6-.8.6l-8.3 1.4c-.8.1-1.5-.5-1.5-1.3 0-.9.8-1.6 2.4-1.6z"/></svg></span>';
  function buildLoading(node) {
    var wrap = document.createElement("div");
    wrap.className = "loading";
    var st = document.createElement("div");
    st.className = "loading-status";
    st.innerHTML = LOADING_BUNNY_HTML + '<span class="shimmer-text ll-live">Thinking</span><span class="ll-stalled">Saved \u2014 waiting for the agent</span><span class="ll-closed">Saved \u2014 answered when you reopen this hole</span><span class="ll-frozen">Unanswered when this snapshot was exported</span><span class="loading-time" data-start="' + (node._startTs || Date.now()) + '"></span>';
    var sk = document.createElement("div");
    sk.innerHTML = '<div class="sk-line w1"></div><div class="sk-line w2"></div><div class="sk-line w3"></div><div class="sk-line w4"></div>';
    wrap.appendChild(st);
    wrap.appendChild(sk);
    return wrap;
  }
  function visualSurfaceKey(node, base) {
    return (base === CANVAS_BASE ? "canvas:" : "reader:") + (node && node.id || "unknown");
  }
  function mountDocMedia(dc, node, base) {
    var surfaceKey = visualSurfaceKey(node, base);
    if (typeof coreHooks.mountVisuals === "function") coreHooks.mountVisuals(dc, surfaceKey);
    if (typeof coreHooks.mountDocImages === "function") coreHooks.mountDocImages(dc, node, base, surfaceKey);
  }
  function fillStreaming(dc, node, surfaceKey) {
    dc.innerHTML = node.html || "";
    var caret = document.createElement("span");
    caret.className = "stream-caret";
    var last = dc.lastElementChild;
    if (last && (last.tagName === "UL" || last.tagName === "OL")) last = last.lastElementChild || last;
    if (last && /^(P|H[1-6]|LI)$/.test(last.tagName)) last.appendChild(caret);
    else dc.appendChild(caret);
    var st = document.createElement("div");
    st.className = "stream-status";
    st.innerHTML = '<span class="shimmer-text ll-live">Writing</span><span class="ll-stalled">Paused \u2014 waiting for the agent</span><span class="ll-closed">Saved \u2014 answered in full when you reopen this hole</span><span class="ll-frozen">Unfinished when this snapshot was exported</span><span class="loading-time" data-start="' + (node._startTs || Date.now()) + '"></span>';
    dc.appendChild(st);
    surfaceKey = surfaceKey || "stream:" + (node && node.id || "unknown");
    if (typeof coreHooks.mountVisuals === "function") coreHooks.mountVisuals(dc, surfaceKey);
    if (typeof coreHooks.mountDocImages === "function") coreHooks.mountDocImages(dc, node, null, surfaceKey);
  }
  function formatElapsed(ms) {
    var s = Math.floor(ms / 1e3);
    if (s < 3) return "";
    if (s < 60) return s + "s";
    return Math.floor(s / 60) + "m " + s % 60 + "s";
  }
  function updateLoadingTimers() {
    if (closed) return;
    var els = document.querySelectorAll(".loading-time");
    for (var i = 0; i < els.length; i++) {
      var t = Number(els[i].getAttribute("data-start")) || 0;
      if (t) els[i].textContent = formatElapsed(Date.now() - t);
    }
  }
  function buildDocContent(node, base) {
    var dc = document.createElement("div");
    dc.className = "doc-content md";
    dc.dataset.nodeId = node.id;
    dc.style.fontSize = fontPx(node, base) + "px";
    if (node.status === "pending") {
      if (node.html) fillStreaming(dc, node, visualSurfaceKey(node, base));
      else dc.appendChild(buildLoading(node));
    } else {
      dc.innerHTML = node.html || "";
      mountDocMedia(dc, node, base);
    }
    return dc;
  }
  function toggleTheme() {
    var cur = document.documentElement.getAttribute("data-theme");
    var next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("rh-theme", next);
    } catch (e) {
    }
  }
  function flashHint(msg) {
    if (hintTimer) clearTimeout(hintTimer);
    hintEl.textContent = msg;
    hintEl.classList.add("flash");
    hintTimer = setTimeout(function() {
      hintTimer = 0;
      hintEl.classList.remove("flash");
    }, 4e3);
  }

  // src/ui/visuals.js
  var visualSurfaceCaches = {};
  var visualHandlers = {};
  var visualHooksReady = false;
  var VISUAL_ALLOWED_URI = /^(?:(?:https?:)?\/\/|https?:|\/|\.\/|\.\.\/|#|data:image\/(?:png|jpe?g|gif|webp);base64,|[^:]*$)/i;
  var VISUAL_SANITIZE_CONFIG = {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_TAGS: ["style"],
    ADD_ATTR: ["style"],
    FORCE_BODY: true,
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["srcdoc"],
    ALLOWED_URI_REGEXP: VISUAL_ALLOWED_URI
  };
  var VISUAL_BASE_CSS = ":host{display:block;width:100%;max-width:100%;margin:0.55em 0 1em;contain:content;color:var(--fg);background:transparent;font:inherit;}.rh-viz-frame{box-sizing:border-box;width:100%;max-width:100%;overflow-x:auto;overflow-y:visible;overscroll-behavior-x:contain;border:1px solid var(--border);border-radius:8px;padding:0.85em 1em;background:var(--node-bg);color:var(--fg);font:inherit;}.rh-viz-content{box-sizing:border-box;min-width:100%;width:auto;color:inherit;font:inherit;}.rh-viz-content *,.rh-viz-content *::before,.rh-viz-content *::after{box-sizing:border-box;}.rh-viz-content svg{max-width:none;height:auto;}.rh-viz-content img{max-width:100%;height:auto;}.rh-viz-content a{color:var(--accent);text-decoration-color:color-mix(in srgb,var(--accent) 42%,transparent);}.rh-viz-content code,.rh-viz-content pre{font-family:var(--font-mono);}";
  function registerVisualHandler(type, build) {
    if (!type || typeof build !== "function") return;
    visualHandlers[String(type).toLowerCase()] = build;
  }
  function ensureVisualSanitizer() {
    var purifier = window.DOMPurify;
    if (!purifier || typeof purifier.sanitize !== "function") throw new Error("DOMPurify is unavailable");
    if (!visualHooksReady && typeof purifier.addHook === "function") {
      purifier.addHook("uponSanitizeAttribute", function(node, data) {
        if (data && data.attrName && /^on/i.test(data.attrName)) data.keepAttr = false;
      });
      visualHooksReady = true;
    }
    return purifier;
  }
  function sanitizeVisualSource(source) {
    return ensureVisualSanitizer().sanitize(source, VISUAL_SANITIZE_CONFIG);
  }
  function decodeVisualSource(encoded) {
    var bin = atob(String(encoded || ""));
    if (typeof TextDecoder === "function") {
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8").decode(bytes);
    }
    try {
      return decodeURIComponent(escape(bin));
    } catch (e) {
      return bin;
    }
  }
  function visualCacheKey(type, encoded) {
    return String(type || "") + "\n" + String(encoded || "");
  }
  function visualFallback(source, message) {
    var wrap = document.createElement("div");
    wrap.className = "viz-fallback";
    var note = document.createElement("div");
    note.className = "viz-fallback-note";
    note.textContent = message || "Unable to render visual. Showing source.";
    var pre = document.createElement("pre");
    var code = document.createElement("code");
    code.textContent = String(source || "");
    pre.appendChild(code);
    wrap.appendChild(note);
    wrap.appendChild(pre);
    return wrap;
  }
  function buildShowVisual(source) {
    try {
      var clean = sanitizeVisualSource(source);
      var host = document.createElement("div");
      host.className = "viz-mounted viz-show";
      host.setAttribute("data-viz-mounted", "show");
      host.style.contain = "content";
      var shadow = host.attachShadow({ mode: "open" });
      var style = document.createElement("style");
      style.textContent = VISUAL_BASE_CSS;
      var frame = document.createElement("div");
      frame.className = "rh-viz-frame";
      var content = document.createElement("div");
      content.className = "rh-viz-content";
      content.innerHTML = clean;
      frame.appendChild(content);
      shadow.appendChild(style);
      shadow.appendChild(frame);
      return host;
    } catch (e) {
      return visualFallback(source, "Unable to render visual. Showing source.");
    }
  }
  function getSurfaceCache(surfaceKey) {
    var key = String(surfaceKey || "default");
    if (!visualSurfaceCaches[key]) visualSurfaceCaches[key] = {};
    return visualSurfaceCaches[key];
  }
  function mountVisuals2(containerEl, surfaceKey) {
    if (!containerEl || !containerEl.querySelectorAll) return;
    var placeholders = containerEl.querySelectorAll(".viz");
    if (!placeholders.length) {
      if (surfaceKey && visualSurfaceCaches[surfaceKey]) visualSurfaceCaches[surfaceKey] = {};
      return;
    }
    var cache = getSurfaceCache(surfaceKey);
    var present = {};
    var used = {};
    var mountable = [];
    for (var i = 0; i < placeholders.length; i++) {
      var ph = placeholders[i];
      if (ph.classList && ph.classList.contains("viz-pending")) continue;
      var type = String(ph.getAttribute("data-viz") || "").toLowerCase();
      var encoded = ph.getAttribute("data-src") || "";
      if (!type || !encoded) continue;
      var key = visualCacheKey(type, encoded);
      present[key] = (present[key] || 0) + 1;
      mountable.push({ el: ph, type, encoded, key });
    }
    for (var m = 0; m < mountable.length; m++) {
      var item = mountable[m];
      var idx = used[item.key] || 0;
      used[item.key] = idx + 1;
      if (!cache[item.key]) cache[item.key] = [];
      var mounted = cache[item.key][idx];
      if (!mounted) {
        var handler = visualHandlers[item.type];
        var source;
        try {
          source = decodeVisualSource(item.encoded);
          mounted = handler ? handler(source, item.type) : visualFallback(source, "Unsupported visual type. Showing source.");
        } catch (e) {
          source = "";
          mounted = visualFallback("", "Unable to decode visual source.");
        }
        cache[item.key][idx] = mounted;
      }
      if (item.el.parentNode) item.el.parentNode.replaceChild(mounted, item.el);
    }
    for (var ckey in cache) {
      if (!Object.prototype.hasOwnProperty.call(cache, ckey)) continue;
      if (!present[ckey]) delete cache[ckey];
      else cache[ckey].length = present[ckey];
    }
  }
  registerVisualHandler("show", function(source) {
    return buildShowVisual(source);
  });
  function initVisuals() {
    window.__rhVisuals = { mount: mountVisuals2, caches: visualSurfaceCaches, config: VISUAL_SANITIZE_CONFIG, register: registerVisualHandler };
  }

  // src/ui/reader.js
  var readerHooks = {
    hideAsk: function() {
    },
    hidePeek: function() {
    },
    updateComposerState: function() {
    },
    scheduleViewSave: function() {
    },
    setMode: function() {
    },
    post: function() {
      return Promise.resolve({ ok: true });
    },
    mountVisuals: null,
    mountDocImages: null,
    persistNode: function() {
    },
    animateScroll: function() {
    }
  };
  function registerReaderHooks(hooks) {
    Object.assign(readerHooks, hooks || {});
  }
  function openNode(id) {
    if (!nodes[id]) return;
    var prev = nodes[currentNodeId];
    if (prev && !document.body.classList.contains("mode-canvas")) prev._scrollTop = readerMain.scrollTop;
    setCurrentNodeId(id);
    setModeValue("reader");
    document.body.classList.remove("mode-canvas");
    readerHooks.hideAsk();
    readerHooks.hidePeek();
    kbdMarkIdx = -1;
    renderBreadcrumb();
    renderReaderBody();
    renderSidebar();
    readerHooks.updateComposerState();
    if (nodes[id].status === "answered") markRead(nodes[id]);
    readerHooks.scheduleViewSave();
  }
  function renderBreadcrumb() {
    var path = lineageNodes(currentNodeId), html = "";
    path.forEach(function(n, i) {
      if (i > 0) html += '<span class="crumb-sep">\u203A</span>';
      var cur = i === path.length - 1;
      html += '<span class="crumb' + (cur ? " current" : "") + '" data-id="' + n.id + '">' + esc(n.title || "Untitled") + "</span>";
    });
    breadcrumbEl.innerHTML = html;
  }
  function initReader() {
    breadcrumbEl.addEventListener("click", function(e) {
      var c = e.target.closest(".crumb");
      if (!c || c.classList.contains("current")) return;
      openNode(c.dataset.id);
    });
    readerMain.addEventListener("scroll", onReaderScroll, { passive: true });
    readerMain.addEventListener("click", onMarkClick);
    world.addEventListener("click", onMarkClick);
    sideEl2.addEventListener("click", onSidebarClick);
    document.getElementById("r-textdown").addEventListener("click", function() {
      setReaderFontScale(-0.1);
    });
    document.getElementById("r-textup").addEventListener("click", function() {
      setReaderFontScale(0.1);
    });
    document.getElementById("r-canvas").addEventListener("click", function() {
      readerHooks.setMode("canvas");
    });
    document.getElementById("r-done").addEventListener("click", function() {
      if (!closed) readerHooks.post({ type: "done" });
    });
    document.getElementById("r-theme").addEventListener("click", toggleTheme);
    document.getElementById("t-theme").addEventListener("click", toggleTheme);
  }
  function renderReaderBody() {
    var node = nodes[currentNodeId];
    readerMain.innerHTML = "";
    var col = document.createElement("div");
    col.className = "reader-col";
    if (node.origin && (node.origin.selected_text || node.origin.question)) {
      var ctx = document.createElement("div");
      ctx.className = "reader-context";
      if (node.origin.synthesis) {
        ctx.innerHTML = '<span class="rc-label">Synthesis</span>The journey so far, distilled';
      } else if (node.origin.selected_text) {
        var tail = node.origin.lens ? " \u2014 " + lensBadgeHtml(node.origin.lens) : node.origin.question ? " \u2014 " + esc(node.origin.question) : "";
        ctx.innerHTML = '<span class="rc-label">From</span>\u201C' + esc(truncate2(node.origin.selected_text, 200)) + "\u201D" + tail + '<span class="rc-go">\u2192</span>';
      } else {
        ctx.innerHTML = '<span class="rc-label">Follow-up</span>' + (node.origin.lens ? lensBadgeHtml(node.origin.lens) : esc(node.origin.question || ""));
      }
      if (node.parent_id && nodes[node.parent_id] && !node.origin.synthesis) {
        ctx.classList.add("linked");
        ctx.title = "See this in its original context";
        ctx.addEventListener("click", function(e) {
          jumpToOrigin(node, motionSourceFromEvent(e));
        });
      }
      col.appendChild(ctx);
    }
    var dc = buildDocContent(node, READER_BASE);
    col.appendChild(dc);
    applyChildHighlights(dc, node);
    var fups = followupsOf(node.id);
    if (fups.length) {
      var thread = document.createElement("div");
      thread.id = "thread";
      thread.appendChild(buildThreadRule());
      fups.forEach(function(k) {
        thread.appendChild(buildThreadItem(k));
      });
      col.appendChild(thread);
      fups.forEach(function(k) {
        if (k.status === "answered") markRead(k);
      });
    }
    readerMain.appendChild(col);
    readerMain.scrollTop = node._scrollTop || 0;
  }
  function jumpToOrigin(node, source) {
    var parent = nodes[node.parent_id];
    if (!parent) return;
    openNode(parent.id);
    var target = readerMain.querySelector('mark[data-child="' + node.id + '"]') || readerMain.querySelector('[data-turn="' + node.id + '"]');
    if (!target) return;
    var top = target.getBoundingClientRect().top - readerMain.getBoundingClientRect().top + readerMain.scrollTop;
    readerHooks.animateScroll(readerMain, Math.max(0, top - readerMain.clientHeight * 0.38), source);
    if (target.tagName === "MARK") {
      var marks = readerMain.querySelectorAll('mark[data-child="' + node.id + '"]');
      for (var i = 0; i < marks.length; i++) playLandingCue(marks[i], "mark-flash");
    }
  }
  function onReaderScroll() {
    var n = nodes[currentNodeId];
    if (n) n._scrollTop = readerMain.scrollTop;
    readerHooks.hidePeek();
    readerHooks.scheduleViewSave();
  }
  function buildThreadRule() {
    var r = document.createElement("div");
    r.className = "thread-rule";
    r.textContent = "Conversation";
    return r;
  }
  function buildThreadItem(k) {
    var item = document.createElement("div");
    item.className = "turn";
    item.dataset.turn = k.id;
    var q = document.createElement("div");
    q.className = "turn-q";
    var qs = document.createElement("span");
    if (k.origin && k.origin.lens) qs.innerHTML = lensBadgeHtml(k.origin.lens);
    else qs.textContent = k.origin && k.origin.question || "";
    q.appendChild(qs);
    var a = document.createElement("div");
    a.className = "turn-a";
    fillTurnAnswer(a, k);
    item.appendChild(q);
    item.appendChild(a);
    return item;
  }
  function fillTurnAnswer(a, k) {
    a.innerHTML = "";
    if (k.status === "pending" && !k.html) {
      a.appendChild(buildLoading(k));
      return;
    }
    var dc = buildDocContent(k, READER_BASE);
    var host = nodes[currentNodeId];
    if (host) dc.style.fontSize = fontPx(host, READER_BASE) + "px";
    a.appendChild(dc);
    if (k.status === "answered") applyChildHighlights(dc, k);
  }
  function ensureThread() {
    var t = readerMain.querySelector("#thread");
    if (t) return t;
    var col = readerMain.querySelector(".reader-col");
    if (!col) return null;
    t = document.createElement("div");
    t.id = "thread";
    t.appendChild(buildThreadRule());
    col.appendChild(t);
    return t;
  }
  function updateThreadItem(k) {
    var item = readerMain.querySelector('[data-turn="' + k.id + '"]');
    if (!item) {
      var t = ensureThread();
      if (t) t.appendChild(buildThreadItem(k));
      return;
    }
    fillTurnAnswer(item.querySelector(".turn-a"), k);
  }
  function removeThreadItem(childId) {
    var item = readerMain.querySelector('[data-turn="' + childId + '"]');
    if (item && item.parentNode) item.parentNode.removeChild(item);
    var t = readerMain.querySelector("#thread");
    if (t && !t.querySelector(".turn")) t.parentNode.removeChild(t);
  }
  function applyChildHighlights(dc, node) {
    var kids = childrenOf(node.id).filter(function(k) {
      return k.origin && k.origin.anchor;
    });
    kids.sort(function(a, b) {
      return b.origin.anchor.offset_start - a.origin.anchor.offset_start;
    });
    kids.forEach(function(k) {
      var a = k.origin.anchor;
      var r = rangeFromOffsets(dc, a.offset_start, a.offset_end);
      if (!r) return;
      wrapRange(r, k.id, "hl " + (k.status === "answered" ? "mark-ready" : "mark-pending"));
    });
  }
  function wrapInContainer(dc, anchor, childId, cls) {
    if (!dc || !anchor) return;
    var rr = rangeFromOffsets(dc, anchor.offset_start, anchor.offset_end);
    if (rr) {
      try {
        wrapRange(rr, childId, cls);
      } catch (e) {
      }
    }
  }
  function upgradeMarks(root, childId) {
    if (!root) return;
    var marks = root.querySelectorAll('mark[data-child="' + childId + '"]');
    for (var i = 0; i < marks.length; i++) {
      marks[i].classList.remove("mark-pending");
      marks[i].classList.add("mark-ready");
    }
  }
  function removeMarks(root, childId) {
    if (!root) return;
    var marks = root.querySelectorAll('mark[data-child="' + childId + '"]');
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i], p = m.parentNode;
      if (!p) continue;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    }
  }
  function onMarkClick(e) {
    var m = e.target.closest("mark[data-child]");
    if (!m) return;
    if (!window.getSelection().isCollapsed) return;
    var k = nodes[m.dataset.child];
    if (k) openNode(k.id);
  }
  function renderSidebar() {
    var kids = childrenOf(currentNodeId).filter(function(k) {
      return !isFollowup(k);
    }).sort(function(a, b) {
      return anchorStart(a) - anchorStart(b) || (a._order || 0) - (b._order || 0);
    });
    if (!kids.length) {
      sideEl2.innerHTML = '<h3>Branches</h3><div class="side-empty">Select any text in the document and ask about it \u2014 the answer opens as a branch here. Or ask a follow-up in the box below the document.</div>';
      return;
    }
    var html = "<h3>Branches (" + kids.length + ")</h3>";
    kids.forEach(function(k, i) {
      var pending = k.status !== "answered";
      var qHtml = k.origin && k.origin.synthesis ? '<span class="lens-badge">\u2726 Synthesis</span>' : k.origin && k.origin.lens ? lensBadgeHtml(k.origin.lens) : esc(k.origin && k.origin.question ? k.origin.question : k.title || "Untitled");
      var quote = k.origin && k.origin.selected_text ? k.origin.selected_text : "";
      var status = pending ? pendingStatusHtml(k) : isUnread(k) ? '<span class="si-new">new \u2014 open \u2192</span>' : "open \u2192";
      html += '<div class="side-item' + (pending ? " pending" : "") + '" data-child="' + k.id + '">';
      html += '<div class="si-q"><span class="si-num">' + (i + 1) + "</span><span>" + qHtml + "</span></div>";
      if (quote) html += '<div class="si-quote">\u201C' + esc(truncate2(quote, 80)) + "\u201D</div>";
      html += '<div class="si-status">' + status + "</div>";
      if (pending && k.html) html += '<div class="si-live"><div class="md">' + k.html + "</div></div>";
      html += "</div>";
    });
    sideEl2.innerHTML = html;
    mountSidebarVisuals();
  }
  function mountSidebarVisuals() {
    if (typeof readerHooks.mountVisuals !== "function") return;
    var panes = sideEl2.querySelectorAll(".side-item[data-child] .si-live .md");
    for (var i = 0; i < panes.length; i++) {
      var item = panes[i].closest(".side-item[data-child]");
      var key = "reader-side:" + (item ? item.dataset.child : i);
      readerHooks.mountVisuals(panes[i], key);
      if (typeof readerHooks.mountDocImages === "function") readerHooks.mountDocImages(panes[i], nodes[item ? item.dataset.child : ""], null, key);
    }
  }
  function pendingStatusHtml(k) {
    if (frozen) return '<span class="si-muted">unanswered in this snapshot</span>';
    if (closed) return '<span class="si-muted">saved \u2014 answered when you reopen</span>';
    if (connLost || !agentAttached) return '<span class="si-muted">saved \u2014 waiting for the agent</span>';
    if (k && k.html) return '<span class="shimmer-text">Writing\u2026</span>';
    return '<span class="shimmer-text">Thinking\u2026</span>';
  }
  function onSidebarClick(e) {
    var it = e.target.closest(".side-item");
    if (!it) return;
    openNode(it.dataset.child);
  }
  function setReaderFontScale(delta) {
    var node = nodes[currentNodeId];
    node.font_scale = Math.min(MAX_FS, Math.max(MIN_FS, (node.font_scale || 1) + delta));
    var dcs = readerMain.querySelectorAll(".doc-content");
    for (var i = 0; i < dcs.length; i++) dcs[i].style.fontSize = fontPx(node, READER_BASE) + "px";
    if (node.bodyEl) {
      var cdc = node.bodyEl.querySelector(".doc-content");
      if (cdc) cdc.style.fontSize = fontPx(node, CANVAS_BASE) + "px";
    }
    readerHooks.persistNode(node);
  }
  function rangeFromOffsets(container, startOff, endOff) {
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    var pos = 0, sN, sO, eN, eO;
    while (walker.nextNode()) {
      var node = walker.currentNode, L = node.textContent.length;
      if (sN == null && pos + L > startOff) {
        sN = node;
        sO = startOff - pos;
      }
      if (pos + L >= endOff) {
        eN = node;
        eO = endOff - pos;
        break;
      }
      pos += L;
    }
    if (sN == null || eN == null) return null;
    var r = document.createRange();
    try {
      r.setStart(sN, sO);
      r.setEnd(eN, eO);
    } catch (e) {
      return null;
    }
    return r;
  }
  function charOffset(container, node, offset) {
    var r = document.createRange();
    r.selectNodeContents(container);
    try {
      r.setEnd(node, offset);
    } catch (e) {
      return 0;
    }
    return r.toString().length;
  }
  function wrapTextNode(textNode, childId, cls) {
    var m = document.createElement("mark");
    m.className = cls;
    m.dataset.child = childId;
    textNode.parentNode.insertBefore(m, textNode);
    m.appendChild(textNode);
  }
  function wrapRange(range, childId, cls) {
    var startC = range.startContainer, endC = range.endContainer, startO = range.startOffset, endO = range.endOffset;
    if (startC === endC && startC.nodeType === 3) {
      if (startO === endO) return;
      var mid = startC.splitText(startO);
      mid.splitText(endO - startO);
      wrapTextNode(mid, childId, cls);
      return;
    }
    var ancestor = range.commonAncestorContainer;
    if (ancestor.nodeType === 3) ancestor = ancestor.parentNode;
    var walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT);
    var collected = [], inRange = false;
    while (walker.nextNode()) {
      var n = walker.currentNode;
      if (n === startC) {
        inRange = true;
        var info = { node: n, start: startO, end: n.textContent.length };
        if (n === endC) {
          info.end = endO;
          collected.push(info);
          break;
        }
        collected.push(info);
        continue;
      }
      if (n === endC) {
        collected.push({ node: n, start: 0, end: endO });
        break;
      }
      if (inRange) collected.push({ node: n, start: 0, end: n.textContent.length });
    }
    for (var i = collected.length - 1; i >= 0; i--) {
      var c = collected[i], node = c.node, s = c.start, e = c.end, L = node.textContent.length;
      if (s >= e || !L) continue;
      var t = s > 0 ? node.splitText(s) : node;
      if (e < L) t.splitText(e - s);
      wrapTextNode(t, childId, cls);
    }
  }
  var kbdMarkIdx = -1;
  function allMarks() {
    return readerMain.querySelectorAll("mark[data-child]");
  }
  function focusedMark() {
    var marks = allMarks();
    return kbdMarkIdx >= 0 && kbdMarkIdx < marks.length ? marks[kbdMarkIdx] : null;
  }
  function stepMark(delta) {
    var marks = allMarks();
    if (!marks.length) return;
    var prev = focusedMark();
    if (prev) prev.classList.remove("mark-focus");
    kbdMarkIdx = kbdMarkIdx < 0 ? delta > 0 ? 0 : marks.length - 1 : Math.max(0, Math.min(marks.length - 1, kbdMarkIdx + delta));
    var m = marks[kbdMarkIdx];
    m.classList.add("mark-focus");
    var top = m.getBoundingClientRect().top - readerMain.getBoundingClientRect().top + readerMain.scrollTop;
    readerHooks.animateScroll(readerMain, Math.max(0, top - readerMain.clientHeight * 0.42), "keyboard");
  }

  // src/ui/canvas-view.js
  var canvasHooks = {
    hideAsk: function() {
    },
    hidePeek: function() {
    },
    sendFollowup: function() {
      return null;
    },
    confirmDelete: function() {
    },
    persistNode: function() {
    },
    persistNodesBulk: function() {
    },
    scheduleViewSave: function() {
    }
  };
  function registerCanvasHooks(hooks) {
    Object.assign(canvasHooks, hooks || {});
  }
  function initCanvasView() {
    registerCoreHooks({
      ensureCanvasBuilt,
      diveToNode,
      effH
    });
    world.addEventListener("mouseover", onWorldMouseOver);
    world.addEventListener("mouseout", onWorldMouseOut);
    initViewportPan();
    viewport.addEventListener("wheel", onViewportWheel, { passive: false });
    viewport.addEventListener("dblclick", onViewportDblClick);
    document.getElementById("t-reader").addEventListener("click", function() {
      openNode(currentNodeId);
    });
    document.getElementById("t-frame").addEventListener("click", function(e) {
      frameAll(true, motionSourceFromEvent(e));
    });
    document.getElementById("t-tidy").addEventListener("click", function(e) {
      tidy(motionSourceFromEvent(e));
    });
    document.getElementById("t-zin").addEventListener("click", function() {
      zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 1.15);
    });
    document.getElementById("t-zout").addEventListener("click", function() {
      zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 0.87);
    });
    zoomLabel.addEventListener("click", function() {
      zoomTo(viewport.clientWidth / 2, viewport.clientHeight / 2, 1);
    });
    exposeFilmCameraHook();
  }
  function applyTransform() {
    world.style.transform = "translate(" + view.x + "px," + view.y + "px) scale(" + view.scale + ")";
    zoomLabel.textContent = Math.round(view.scale * 100) + "%";
    canvasHooks.scheduleViewSave();
  }
  function exposeFilmCameraHook() {
    var enabled = false;
    try {
      enabled = localStorage.getItem("rh-film") === "1";
    } catch (e) {
    }
    if (!enabled) return;
    Object.defineProperty(window, "__rhFilmCamera", {
      configurable: true,
      value: {
        getView: function() {
          return { x: view.x, y: view.y, scale: view.scale };
        },
        setView: function(x, y, scale) {
          viewAnimId++;
          view.x = Number(x);
          view.y = Number(y);
          view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(scale)));
          applyTransform();
          drawEdges();
          return { x: view.x, y: view.y, scale: view.scale };
        }
      }
    });
  }
  function screenToWorld(sx, sy) {
    return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
  }
  function zoomAt(sx, sy, factor) {
    var next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    zoomTo(sx, sy, next);
  }
  function zoomTo(sx, sy, next) {
    viewAnimId++;
    next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    if (next === view.scale) return;
    var w = screenToWorld(sx, sy);
    view.scale = next;
    view.x = sx - w.x * view.scale;
    view.y = sy - w.y * view.scale;
    applyTransform();
  }
  var NODE_EXPAND_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" aria-hidden="true"><path d="M9.25 3.75h3v3"/><path d="M12.25 3.75 8.75 7.25"/><path d="M6.75 12.25h-3v-3"/><path d="M3.75 12.25l3.5-3.5"/></svg>';
  var NODE_COLLAPSE_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" aria-hidden="true"><path d="M3 8h10"/></svg>';
  function createNodeEl(node, enter) {
    var el = document.createElement("div");
    el.className = "node" + (node.id === rootId ? " root" : "");
    if (enter && !document.hidden && !shouldReduceMotion()) el.className += " node-enter";
    el.dataset.id = node.id;
    var head = document.createElement("div");
    head.className = "node-head";
    if (node.id === rootId) {
      var badge = document.createElement("span");
      badge.className = "node-badge";
      badge.textContent = "\u{1F407}";
      badge.title = "Where this Rabbithole begins";
      head.appendChild(badge);
    }
    var titleEl = document.createElement("span");
    titleEl.className = "node-title";
    titleEl.textContent = node.title || "\u2026";
    titleEl.title = node.title || "";
    var aDown = mkBtn("A\u2212", "Smaller text");
    var aUp = mkBtn("A+", "Larger text");
    aDown.classList.add("node-font-btn");
    aUp.classList.add("node-font-btn");
    var collapseBtn = mkIconBtn(NODE_COLLAPSE_ICON, "Collapse");
    var openBtn = mkIconBtn(NODE_EXPAND_ICON, "Expand");
    var divider = document.createElement("span");
    divider.className = "node-act-divider";
    divider.setAttribute("aria-hidden", "true");
    var acts = document.createElement("span");
    acts.className = "node-acts";
    if (node.id !== rootId) {
      var delBtn = mkBtn("\u2715", "Remove this branch");
      delBtn.classList.add("danger");
      delBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        canvasHooks.confirmDelete(node, delBtn);
      });
      acts.appendChild(delBtn);
    }
    acts.appendChild(aDown);
    acts.appendChild(aUp);
    acts.appendChild(divider);
    acts.appendChild(collapseBtn);
    acts.appendChild(openBtn);
    head.appendChild(titleEl);
    head.appendChild(acts);
    var body = document.createElement("div");
    body.className = "node-body";
    var comp = buildCardComposer(node);
    var resize = document.createElement("div");
    resize.className = "node-resize";
    el.appendChild(head);
    el.appendChild(body);
    el.appendChild(comp);
    el.appendChild(resize);
    world.appendChild(el);
    node.el = el;
    node.bodyEl = body;
    node.titleEl = titleEl;
    fillBody(node);
    updateCardComposer(node);
    if (node.collapsed) el.classList.add("collapsed");
    if (isUnread(node)) el.classList.add("unread");
    enableDrag(node, head);
    enableResize(node, resize);
    head.addEventListener("dblclick", function() {
      openNode(node.id);
    });
    openBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      openNode(node.id);
    });
    collapseBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      toggleCollapse(node, collapseBtn);
    });
    aDown.addEventListener("click", function(e) {
      e.stopPropagation();
      setNodeFontScale(node, -0.1);
    });
    aUp.addEventListener("click", function(e) {
      e.stopPropagation();
      setNodeFontScale(node, 0.1);
    });
    body.addEventListener("scroll", scheduleEdges, { passive: true });
    body.addEventListener("pointerdown", function() {
      if (node.status === "answered") markRead(node);
    });
    el.addEventListener("mouseenter", function() {
      focusOrigin(node, true);
    });
    el.addEventListener("mouseleave", function() {
      focusOrigin(node, false);
      if (node.ncComp && !node.ncText.value.trim() && document.activeElement !== node.ncText) closeCardDrawer(node);
    });
    layoutNode(node);
    if (el.classList.contains("node-enter")) {
      requestAnimationFrame(function() {
        el.classList.add("entered");
        setTimeout(function() {
          el.classList.remove("node-enter");
          el.classList.remove("entered");
        }, 220);
      });
    }
    return node;
  }
  function diveToNode(node, source) {
    var vw = viewport.clientWidth, vh = viewport.clientHeight;
    var ts = Math.min(1, Math.max(0.75, Math.min((vw - 120) / node.w, (vh - 120) / effH(node))));
    var tx = vw / 2 - (node.x + node.w / 2) * ts;
    var ty = vh / 2 - (node.y + effH(node) / 2) * ts;
    animateView(tx, ty, ts, { source, duration: 270, ease: "inOut" });
  }
  function mkBtn(txt, title) {
    var b = document.createElement("button");
    b.className = "node-btn";
    b.textContent = txt;
    b.title = title;
    return b;
  }
  function mkIconBtn(svg, title) {
    var b = mkBtn("", title);
    b.innerHTML = svg;
    b.setAttribute("aria-label", title);
    return b;
  }
  var SEND_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 12.8V3.6M8 3.6 3.9 7.7M8 3.6l4.1 4.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function autoGrowEl(ta, max) {
    ta.style.height = "auto";
    ta.style.height = Math.min(max, ta.scrollHeight) + "px";
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  }
  function buildCardComposer(node) {
    var comp = document.createElement("div");
    comp.className = "node-composer";
    var clip = document.createElement("div");
    clip.className = "nc-clip";
    var inner = document.createElement("div");
    inner.className = "nc-inner";
    var ta = document.createElement("textarea");
    ta.rows = 1;
    var send = document.createElement("button");
    send.className = "send-btn";
    send.title = "Send (\u21B5)";
    send.innerHTML = SEND_ICON;
    var handle = document.createElement("button");
    handle.type = "button";
    handle.className = "nc-handle";
    handle.title = "Ask a follow-up about this document";
    var plus = document.createElement("span");
    plus.className = "nc-plus";
    plus.textContent = "+";
    handle.appendChild(plus);
    handle.appendChild(document.createTextNode(" Follow-up"));
    inner.appendChild(ta);
    inner.appendChild(send);
    clip.appendChild(inner);
    comp.appendChild(clip);
    comp.appendChild(handle);
    node.ncComp = comp;
    node.ncInner = inner;
    node.ncText = ta;
    node.ncSend = send;
    handle.addEventListener("click", function(e) {
      e.stopPropagation();
      openCardDrawer(node);
    });
    ta.addEventListener("input", function() {
      autoGrowEl(ta, 90);
      updateCardComposer(node);
    });
    ta.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitCardFollowup(node, "keyboard");
      } else if (e.key === "Escape") {
        e.stopPropagation();
        closeCardDrawer(node);
        ta.blur();
      }
    });
    ta.addEventListener("blur", function() {
      if (!ta.value.trim() && !(node.el && node.el.matches(":hover"))) closeCardDrawer(node);
    });
    send.addEventListener("click", function(e) {
      e.stopPropagation();
      submitCardFollowup(node, motionSourceFromEvent(e));
    });
    return comp;
  }
  function openCardDrawer(node) {
    node.ncComp.classList.add("open");
    node.ncText.focus({ preventScroll: true });
  }
  function closeCardDrawer(node) {
    node.ncComp.classList.remove("open");
  }
  function updateCardComposer(node) {
    if (!node.ncText) return;
    var down = closed || node.status === "pending";
    node.ncText.disabled = down;
    node.ncInner.classList.toggle("disabled", down);
    node.ncComp.classList.toggle("nc-draft", !!node.ncText.value.trim());
    if (frozen) node.ncText.placeholder = "Read-only snapshot";
    else if (closed) node.ncText.placeholder = "Session ended \u2014 saved";
    else if (node.status === "pending") node.ncText.placeholder = "Still being written\u2026";
    else if (connLost2 || !agentAttached2) node.ncText.placeholder = "Asks are saved for the agent\u2026";
    else node.ncText.placeholder = "Ask a follow-up\u2026";
    node.ncSend.disabled = down || !node.ncText.value.trim();
  }
  function submitCardFollowup(node, source) {
    if (closed) {
      flashHint("Session ended \u2014 reopen this Rabbithole from your terminal to continue.");
      return;
    }
    if (node.status === "pending") return;
    var question = node.ncText.value.trim();
    if (!question) return;
    var kid = canvasHooks.sendFollowup(node, question, null);
    node.ncText.value = "";
    autoGrowEl(node.ncText, 90);
    closeCardDrawer(node);
    updateCardComposer(node);
    revealNode(kid, source);
  }
  function revealNode(n, source) {
    if (mode !== "canvas" || !n) return;
    var pad = 30, vw = viewport.clientWidth, vh = viewport.clientHeight;
    var x1 = n.x * view.scale + view.x, y1 = n.y * view.scale + view.y;
    var x2 = (n.x + n.w) * view.scale + view.x, y2 = (n.y + n.h) * view.scale + view.y;
    var dx = 0, dy = 0;
    if (x2 > vw - pad) dx = vw - pad - x2;
    if (x1 + dx < pad) dx = pad - x1;
    if (y2 > vh - pad) dy = vh - pad - y2;
    if (y1 + dy < pad) dy = pad - y1;
    if (!dx && !dy) return;
    animatePan(view.x + dx, view.y + dy, source, 230, "out");
  }
  function animatePan(tx, ty, source, duration, ease) {
    animateView(tx, ty, view.scale, { source, duration, ease });
  }
  var viewAnimId = 0;
  function animateView(tx, ty, ts, opts) {
    opts = opts || {};
    var myId = ++viewAnimId;
    if (document.hidden || shouldReduceMotion() || opts.source !== "pointer") {
      view.x = tx;
      view.y = ty;
      view.scale = ts;
      applyTransform();
      return;
    }
    var sx = view.x, sy = view.y, ss = view.scale, t0 = performance.now(), D = opts.duration || 270;
    var easeFn = opts.ease === "inOut" ? easeInOutMotion : easeOutMotion;
    function step(t) {
      if (myId !== viewAnimId) return;
      var p = Math.min(1, (t - t0) / D), k = easeFn(p);
      view.x = sx + (tx - sx) * k;
      view.y = sy + (ty - sy) * k;
      view.scale = ss + (ts - ss) * k;
      applyTransform();
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function fillBody(node) {
    var body = node.bodyEl;
    if (!body) return;
    body.innerHTML = "";
    if (node.origin && node.origin.synthesis) {
      var sq = document.createElement("div");
      sq.className = "origin-quote";
      sq.textContent = "\u2726 Synthesis of this Rabbithole";
      body.appendChild(sq);
    } else if (node.origin && node.origin.selected_text) {
      var q = document.createElement("div");
      q.className = "origin-quote";
      q.textContent = "\u201C" + node.origin.selected_text + "\u201D";
      body.appendChild(q);
    } else if (node.origin && (node.origin.question || node.origin.lens)) {
      var fq = document.createElement("div");
      fq.className = "origin-quote";
      fq.textContent = node.origin.lens ? "Follow-up \u2014 " + lensLabel(node.origin.lens) : node.origin.question;
      body.appendChild(fq);
    }
    var dc = buildDocContent(node, CANVAS_BASE);
    body.appendChild(dc);
    applyChildHighlights(dc, node);
  }
  function setNodeFontScale(node, delta) {
    node.font_scale = Math.min(MAX_FS, Math.max(MIN_FS, (node.font_scale || 1) + delta));
    var dc = node.bodyEl && node.bodyEl.querySelector(".doc-content");
    if (dc) dc.style.fontSize = fontPx(node, CANVAS_BASE) + "px";
    if (mode === "reader" && currentNodeId === node.id) {
      var rdc = readerMain.querySelector(".doc-content");
      if (rdc) rdc.style.fontSize = fontPx(node, READER_BASE) + "px";
    }
    scheduleEdges();
    canvasHooks.persistNode(node);
  }
  function layoutNode(node) {
    var el = node.el;
    el.style.left = node.x + "px";
    el.style.top = node.y + "px";
    el.style.width = node.w + "px";
    if (!node.collapsed) el.style.height = node.h + "px";
  }
  function onPointerGesture(handle, onDown, onMove, onUp) {
    handle.addEventListener("pointerdown", function(e) {
      if (!onDown(e)) return;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch (_e) {
      }
      function move(ev) {
        onMove(ev);
      }
      function done() {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", done);
        handle.removeEventListener("pointercancel", done);
        handle.removeEventListener("lostpointercapture", done);
        try {
          handle.releasePointerCapture(e.pointerId);
        } catch (_e) {
        }
        onUp();
      }
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", done);
      handle.addEventListener("pointercancel", done);
      handle.addEventListener("lostpointercapture", done);
    });
  }
  function enableDrag(node, handle) {
    var sx, sy, ox, oy;
    onPointerGesture(
      handle,
      function(e) {
        if (e.button !== 0 || e.target.closest(".node-btn")) return false;
        e.preventDefault();
        canvasHooks.hideAsk();
        sx = e.clientX;
        sy = e.clientY;
        ox = node.x;
        oy = node.y;
        return true;
      },
      function(ev) {
        node.x = ox + (ev.clientX - sx) / view.scale;
        node.y = oy + (ev.clientY - sy) / view.scale;
        layoutNode(node);
        scheduleEdges();
      },
      function() {
        drawEdges();
        canvasHooks.persistNode(node);
      }
    );
  }
  function enableResize(node, handle) {
    var sx, sy, ow, oh;
    onPointerGesture(
      handle,
      function(e) {
        if (e.button !== 0) return false;
        e.preventDefault();
        e.stopPropagation();
        sx = e.clientX;
        sy = e.clientY;
        ow = node.w;
        oh = node.h;
        return true;
      },
      function(ev) {
        node.w = Math.max(240, ow + (ev.clientX - sx) / view.scale);
        node.h = Math.max(160, oh + (ev.clientY - sy) / view.scale);
        layoutNode(node);
        scheduleEdges();
      },
      function() {
        drawEdges();
        canvasHooks.persistNode(node);
      }
    );
  }
  function toggleCollapse(node, btn) {
    node.collapsed = !node.collapsed;
    node.el.classList.toggle("collapsed", node.collapsed);
    btn.innerHTML = NODE_COLLAPSE_ICON;
    if (!node.collapsed) layoutNode(node);
    renderVisibility();
    drawEdges();
    canvasHooks.persistNode(node);
  }
  function renderVisibility() {
    for (var id in nodes) {
      var n = nodes[id];
      if (!n.el) continue;
      if (n.id === rootId) {
        n.el.style.display = "";
        continue;
      }
      n.el.style.display = isVisible(n) ? "" : "none";
    }
  }
  var edgeRaf = 0;
  function scheduleEdges() {
    if (edgeRaf) return;
    edgeRaf = requestAnimationFrame(function() {
      edgeRaf = 0;
      drawEdges();
    });
  }
  function effH(n) {
    return n.collapsed && n.el ? n.el.offsetHeight || 36 : n.h;
  }
  function clamp(lo, hi, v) {
    return Math.max(lo, Math.min(hi, v));
  }
  function edgeSides(p, n) {
    var ph = effH(p), nh = effH(n);
    var dx = n.x + n.w / 2 - (p.x + p.w / 2);
    var dy = n.y + nh / 2 - (p.y + ph / 2);
    var fx = dx / ((p.w + n.w) / 2 + 1);
    var fy = dy / ((ph + nh) / 2 + 1);
    if (Math.abs(fx) >= Math.abs(fy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
    return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
  }
  function edgeStart(p, child, side) {
    var ph = effH(p), ax = null, ay = null, anchored = false;
    if (!p.collapsed && p.el && p.bodyEl) {
      var mark = p.bodyEl.querySelector('mark[data-child="' + child.id + '"]');
      if (mark) {
        var mr = mark.getBoundingClientRect();
        if (mr.height > 0) {
          var er = p.el.getBoundingClientRect();
          var br = p.bodyEl.getBoundingClientRect();
          ay = p.y + clamp(
            (br.top - er.top) / view.scale + 10,
            (br.bottom - er.top) / view.scale - 10,
            (mr.top + mr.height / 2 - er.top) / view.scale
          );
          ax = p.x + clamp(
            (br.left - er.left) / view.scale + 10,
            (br.right - er.left) / view.scale - 10,
            (mr.left + mr.width / 2 - er.left) / view.scale
          );
          anchored = true;
        }
      } else if (isFollowup(child)) {
        ay = p.y + ph - 22;
      }
    }
    if (side === "right") return { x: p.x + p.w, y: ay != null ? ay : p.y + ph / 2, anchored };
    if (side === "left") return { x: p.x, y: ay != null ? ay : p.y + ph / 2, anchored };
    if (side === "bottom") return { x: ax != null ? ax : p.x + p.w / 2, y: p.y + ph, anchored };
    return { x: ax != null ? ax : p.x + p.w / 2, y: p.y, anchored };
  }
  function edgeEnd(n, side) {
    var nh = effH(n);
    if (side === "left") return { x: n.x, y: n.y + nh / 2 };
    if (side === "right") return { x: n.x + n.w, y: n.y + nh / 2 };
    if (side === "top") return { x: n.x + n.w / 2, y: n.y };
    return { x: n.x + n.w / 2, y: n.y + nh };
  }
  function ctrlPt(pt, side, d) {
    if (side === "right") return pt.x + d + " " + pt.y;
    if (side === "left") return pt.x - d + " " + pt.y;
    if (side === "bottom") return pt.x + " " + (pt.y + d);
    return pt.x + " " + (pt.y - d);
  }
  var edgeEls = {};
  function drawEdges() {
    while (edgesSvg.firstChild) edgesSvg.removeChild(edgesSvg.firstChild);
    edgeEls = {};
    var visCache = {};
    function vis(node) {
      var k = node.id;
      if (k in visCache) return visCache[k];
      return visCache[k] = isVisible(node);
    }
    for (var id in nodes) {
      var n = nodes[id];
      if (!n.parent_id || !n.el) continue;
      var p = nodes[n.parent_id];
      if (!p || !p.el) continue;
      if (!vis(n) || !vis(p)) continue;
      var sides = edgeSides(p, n);
      var start = edgeStart(p, n, sides[0]);
      var end = edgeEnd(n, sides[1]);
      var horiz = sides[0] === "left" || sides[0] === "right";
      var reach = Math.max(40, (horiz ? Math.abs(end.x - start.x) : Math.abs(end.y - start.y)) / 2);
      var d = "M " + start.x + " " + start.y + " C " + ctrlPt(start, sides[0], reach) + " " + ctrlPt(end, sides[1], reach) + " " + end.x + " " + end.y;
      var path = document.createElementNS(SVGNS, "path");
      path.setAttribute("d", d);
      path.setAttribute("data-child", n.id);
      var dot = document.createElementNS(SVGNS, "circle");
      dot.setAttribute("cx", start.x);
      dot.setAttribute("cy", start.y);
      dot.setAttribute("r", "3");
      dot.setAttribute("data-child", n.id);
      if (start.anchored) dot.classList.add("anchored");
      if (edgeHl[n.id]) {
        path.classList.add("edge-hl");
        dot.classList.add("edge-hl");
      }
      edgesSvg.appendChild(path);
      edgesSvg.appendChild(dot);
      edgeEls[n.id] = [path, dot];
    }
  }
  var edgeHl = {};
  function setEdgeHighlight(childId, on) {
    if (on) edgeHl[childId] = true;
    else delete edgeHl[childId];
    var els = edgeEls[childId];
    if (!els) return;
    for (var i = 0; i < els.length; i++) els[i].classList.toggle("edge-hl", on);
  }
  function clearEdgeHighlight(childId) {
    delete edgeHl[childId];
  }
  function focusOrigin(node, on) {
    if (mode !== "canvas") return;
    setEdgeHighlight(node.id, on);
    var p = node.parent_id ? nodes[node.parent_id] : null;
    if (p && p.bodyEl) {
      var marks = p.bodyEl.querySelectorAll('mark[data-child="' + node.id + '"]');
      for (var i = 0; i < marks.length; i++) marks[i].classList.toggle("mark-focus", on);
    }
  }
  function onWorldMouseOver(e) {
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (m) setEdgeHighlight(m.dataset.child, true);
  }
  function onWorldMouseOut(e) {
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (m) setEdgeHighlight(m.dataset.child, false);
  }
  function initViewportPan() {
    var sx, sy, ox, oy;
    onPointerGesture(
      viewport,
      function(e) {
        if (e.button !== 0 || e.target.closest(".node")) return false;
        canvasHooks.hideAsk();
        viewAnimId++;
        viewport.classList.add("panning");
        sx = e.clientX;
        sy = e.clientY;
        ox = view.x;
        oy = view.y;
        return true;
      },
      function(ev) {
        view.x = ox + (ev.clientX - sx);
        view.y = oy + (ev.clientY - sy);
        applyTransform();
      },
      function() {
        viewport.classList.remove("panning");
      }
    );
  }
  function canScroll(el, dx, dy) {
    if (dx && el.scrollWidth > el.clientWidth + 1) {
      if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
    }
    if (dy && el.scrollHeight > el.clientHeight + 1) {
      if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
    }
    return false;
  }
  var wheelKind = null;
  var wheelCard = null;
  var wheelTs = 0;
  function onViewportWheel(e) {
    if (e.ctrlKey) {
      e.preventDefault();
      wheelKind = null;
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      return;
    }
    if (!wheelKind || e.timeStamp - wheelTs > 180) {
      wheelCard = e.target.closest && e.target.closest(".node") || null;
      wheelKind = wheelCard ? "card" : "pan";
    }
    wheelTs = e.timeStamp;
    if (wheelKind === "pan") {
      e.preventDefault();
      viewAnimId++;
      view.x -= e.deltaX;
      view.y -= e.deltaY;
      applyTransform();
      return;
    }
    var over = e.target.closest && e.target.closest(".node") || null;
    if (over !== wheelCard) {
      e.preventDefault();
      var nb = wheelCard ? wheelCard.querySelector(".node-body") : null;
      if (nb) {
        nb.scrollLeft += e.deltaX;
        nb.scrollTop += e.deltaY;
      }
      return;
    }
    var el = e.target, consumable = false;
    while (el && el.nodeType === 1) {
      if (canScroll(el, e.deltaX, e.deltaY)) {
        consumable = true;
        break;
      }
      if (el === over) break;
      el = el.parentNode;
    }
    if (!consumable) e.preventDefault();
  }
  function frameAll(animate, source) {
    var ids = Object.keys(nodes).filter(function(id) {
      return isVisible(nodes[id]);
    });
    if (!ids.length) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ids.forEach(function(id) {
      var n = nodes[id];
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + (n.collapsed ? 40 : n.h));
    });
    var vw = viewport.clientWidth || window.innerWidth, vh = viewport.clientHeight || window.innerHeight, pad = 100;
    var ts = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min((vw - pad) / (maxX - minX), (vh - pad) / (maxY - minY), 1.2)));
    var tx = vw / 2 - (minX + (maxX - minX) / 2) * ts, ty = vh / 2 - (minY + (maxY - minY) / 2) * ts;
    if (animate) {
      animateView(tx, ty, ts, { source, duration: 270, ease: "inOut" });
      return;
    }
    view.scale = ts;
    view.x = tx;
    view.y = ty;
    applyTransform();
  }
  function onViewportDblClick(e) {
    if (e.target.closest && e.target.closest(".node")) return;
    frameAll(true, motionSourceFromEvent(e));
  }
  function tidy(source) {
    var visited = {};
    function moveSubtree(node, dx, dy) {
      node.x += dx;
      node.y += dy;
      childrenOf(node.id).filter(function(k) {
        return visited[k.id];
      }).sort(nodeOrder).forEach(function(k) {
        moveSubtree(k, dx, dy);
      });
    }
    function place(node, x, y) {
      visited[node.id] = true;
      node.x = x;
      node.y = y;
      var bounds = nodeBounds(node);
      if (node.collapsed) return bounds;
      var kids = childrenOf(node.id).sort(nodeOrder);
      var selectionKids = kids.filter(isSelectionBranch);
      var followupKids = kids.filter(isFollowup);
      var sideBounds = null;
      var sideX = node.x + node.w + TREE_PARENT_GAP;
      var sideY = node.y;
      selectionKids.forEach(function(k) {
        var kb = place(k, sideX, sideY);
        sideBounds = unionBounds(sideBounds, kb);
        bounds = unionBounds(bounds, kb);
        sideY = kb.maxY + TREE_STACK_GAP;
      });
      var belowY = node.y + effH(node) + TREE_PARENT_GAP;
      followupKids.forEach(function(k) {
        var kb = place(k, node.x, belowY);
        if (boundsOverlap(kb, sideBounds)) {
          var dy = sideBounds.maxY + TREE_STACK_GAP - kb.minY;
          moveSubtree(k, 0, dy);
          kb = shiftBounds(kb, 0, dy);
        }
        bounds = unionBounds(bounds, kb);
        belowY = kb.maxY + TREE_STACK_GAP;
      });
      return bounds;
    }
    var root = nodes[rootId];
    if (!root) return;
    place(root, 0, 0);
    var ids = Object.keys(visited);
    var moved = [];
    ids.forEach(function(id) {
      var nn = nodes[id];
      layoutNode(nn);
      moved.push(nn);
    });
    canvasHooks.persistNodesBulk(moved);
    drawEdges();
    frameAll(true, source);
  }
  function ensureCanvasBuilt() {
    if (canvasBuilt) return;
    setCanvasBuilt(true);
    Object.keys(nodes).forEach(function(id) {
      if (!nodes[id].el) createNodeEl(nodes[id]);
    });
    renderVisibility();
    applyTransform();
  }
  function setMode(m) {
    if (m === "canvas" && mode === "reader") {
      var cur = nodes[currentNodeId];
      if (cur) cur._scrollTop = readerMain.scrollTop;
    }
    setModeValue(m);
    if (m === "canvas") {
      ensureCanvasBuilt();
      canvasHooks.hidePeek();
      document.body.classList.add("mode-canvas");
      requestAnimationFrame(function() {
        drawEdges();
        if (!canvasFramed) {
          setCanvasFramed(true);
          frameAll();
        }
      });
      canvasHooks.scheduleViewSave();
    } else {
      openNode(currentNodeId);
    }
  }

  // src/ui/ask-followups.js
  var askHooks = {
    post: function() {
      return Promise.resolve({ ok: true });
    },
    closeShare: function() {
    },
    hideConfirm: function() {
    },
    hidePeek: function() {
    }
  };
  function registerAskHooks(hooks) {
    Object.assign(askHooks, hooks || {});
  }
  function initAskFollowups() {
    document.addEventListener("mousedown", function(e) {
      var c = e.target && e.target.closest ? function(sel) {
        return e.target.closest(sel);
      } : function() {
        return null;
      };
      if (!c("#sharemenu") && !c("#r-share") && !c("#t-share")) askHooks.closeShare();
      if (!c("#confirm")) askHooks.hideConfirm();
      if (!c("#peek") && !c("mark[data-child]")) askHooks.hidePeek();
      if (inAsk(e)) return;
      hideAsk();
    });
    document.addEventListener("mouseup", function(e) {
      if (inAsk(e)) return;
      setTimeout(maybeShowAsk, 0);
    });
    askGo.addEventListener("click", function(e) {
      submitAsk(null, motionSourceFromEvent(e));
    });
    document.getElementById("ask-lenses").addEventListener("click", function(e) {
      var b = e.target.closest ? e.target.closest(".lens") : null;
      if (b) submitAsk(b.getAttribute("data-lens"), motionSourceFromEvent(e));
    });
    askText.addEventListener("input", function() {
      autoGrowEl(askText, 110);
    });
    askText.addEventListener("keydown", onAskTextKeydown);
    composerText.addEventListener("input", function() {
      autoGrowComposer();
      updateComposerState();
    });
    composerText.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitFollowup("keyboard");
      }
    });
    composerSend.addEventListener("click", function(e) {
      submitFollowup(motionSourceFromEvent(e));
    });
    readerMain.addEventListener("wheel", interruptScrollAnimation, { passive: true });
    readerMain.addEventListener("touchstart", interruptScrollAnimation, { passive: true });
    readerMain.addEventListener("pointerdown", interruptScrollAnimation, { passive: true });
    readerMain.addEventListener("scroll", function() {
      if (performance.now() > scrollAnimIgnoreUntil) cancelScrollAnimation();
    }, { passive: true });
    document.addEventListener("keydown", interruptScrollAnimation);
  }
  function inAsk(e) {
    return e.target && e.target.closest && e.target.closest("#ask");
  }
  function maybeShowAsk() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    var anchor = sel.anchorNode && sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentNode : sel.anchorNode;
    var dc = anchor && anchor.closest ? anchor.closest(".doc-content") : null;
    if (!dc) return;
    var parentId = dc.dataset.nodeId;
    if (!parentId || !nodes[parentId] || nodes[parentId].status === "pending") return;
    if (closed) {
      flashHint(frozen ? "This is a read-only snapshot \u2014 asking needs the live Rabbithole." : "Session ended \u2014 reopen this Rabbithole from your terminal to keep asking.");
      return;
    }
    var range = sel.getRangeAt(0);
    if (!dc.contains(range.startContainer) || !dc.contains(range.endContainer)) return;
    var startOff = charOffset(dc, range.startContainer, range.startOffset);
    var endOff = charOffset(dc, range.endContainer, range.endOffset);
    if (endOff <= startOff) return;
    pendingAsk = {
      parentId,
      container: dc,
      selectedText: sel.toString().trim(),
      startOff,
      endOff,
      range: range.cloneRange()
    };
    paintAskHighlight(pendingAsk.range);
    askText.value = "";
    askText.placeholder = "Ask about this\u2026 \u21B5 = Explain";
    var rect = range.getBoundingClientRect();
    ask.style.left = Math.min(window.innerWidth - 392, Math.max(10, rect.left)) + "px";
    ask.style.top = Math.min(window.innerHeight - 200, rect.bottom + 8) + "px";
    ask.classList.add("visible");
    setSurfaceOrigin(ask, rect);
    autoGrowEl(askText, 110);
    askText.focus();
  }
  var pendingAsk = null;
  function hideAsk() {
    ask.classList.remove("visible");
    pendingAsk = null;
    clearAskHighlight();
  }
  function paintAskHighlight(range) {
    try {
      if (window.Highlight && window.CSS && CSS.highlights) CSS.highlights.set("rh-ask", new Highlight(range));
    } catch (e) {
    }
  }
  function clearAskHighlight() {
    try {
      if (window.CSS && CSS.highlights) CSS.highlights.delete("rh-ask");
    } catch (e) {
    }
  }
  var LENS_KEYS = { "1": "explain", "2": "eli5", "3": "example", "4": "deeper" };
  function onAskTextKeydown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitAsk(null, "keyboard");
    } else if (e.key === "Escape") {
      hideAsk();
    } else if (askText.value === "" && !e.metaKey && !e.ctrlKey && !e.altKey && LENS_KEYS[e.key]) {
      e.preventDefault();
      submitAsk(LENS_KEYS[e.key], "keyboard");
    }
  }
  function submitAsk(lensKey, source) {
    if (!pendingAsk || closed) return;
    var parent = nodes[pendingAsk.parentId];
    if (!parent) {
      hideAsk();
      return;
    }
    var lens = lensKey && LENSES[lensKey] ? lensKey : null;
    var question = lens ? LENSES[lens].q : askText.value.trim();
    var requestId = uuid(), childId = uuid();
    var pos = placeChild(parent, BRANCH_SELECTION);
    var anchor = { offset_start: pendingAsk.startOff, offset_end: pendingAsk.endOff };
    var node = {
      id: childId,
      parent_id: parent.id,
      title: lens ? lensLabel(lens) : question ? truncate(question, 48) : "\u2026",
      html: "",
      md: "",
      read: false,
      origin: { selected_text: pendingAsk.selectedText, question, lens, anchor, branch_type: BRANCH_SELECTION },
      x: pos.x,
      y: pos.y,
      w: DEFAULT_CHILD.w,
      h: DEFAULT_CHILD.h,
      font_scale: 1,
      collapsed: false,
      status: "pending",
      _order: nextOrder(),
      _startTs: Date.now()
    };
    nodes[childId] = node;
    if (canvasBuilt) {
      createNodeEl(node, true);
      renderVisibility();
      drawEdges();
    }
    if (mode === "reader") {
      var rdc = readerMain.querySelector('.doc-content[data-node-id="' + parent.id + '"]');
      wrapInContainer(rdc, anchor, childId, "hl mark-pending");
      if (currentNodeId === parent.id) renderSidebar();
    }
    if (parent.bodyEl) {
      wrapInContainer(parent.bodyEl.querySelector(".doc-content"), anchor, childId, "hl mark-pending");
      scheduleEdges();
    }
    var sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    hideAsk();
    askHooks.post({
      type: "branch_request",
      request_id: requestId,
      node_id: childId,
      parent_id: parent.id,
      selected_text: node.origin.selected_text,
      question,
      lens,
      anchor,
      branch_type: BRANCH_SELECTION,
      position: { x: node.x, y: node.y },
      size: { w: node.w, h: node.h }
    }).then(function(res) {
      if (!res || !res.ok) rollbackBranch(node);
    });
    revealNode(node, source);
    refreshAmbient();
  }
  function updateComposerState() {
    var current = nodes[currentNodeId];
    var down = closed || !current || current.status === "pending";
    composerText.disabled = down;
    composerInner.classList.toggle("disabled", down);
    if (frozen) composerText.placeholder = "Read-only snapshot \u2014 open the live Rabbithole to keep asking";
    else if (closed) composerText.placeholder = "Session ended \u2014 reopen this Rabbithole from your terminal; saved questions are answered there";
    else if (current && current.status === "pending") composerText.placeholder = "This answer is still being written\u2026";
    else if (connLost2 || !agentAttached2) composerText.placeholder = "The agent is away \u2014 questions are saved and answered when it returns\u2026";
    else composerText.placeholder = "Ask a follow-up about this document\u2026";
    composerSend.disabled = down || !composerText.value.trim();
  }
  function autoGrowComposer() {
    autoGrowEl(composerText, 140);
  }
  function sendFollowup(parent, question, lens, synthesis) {
    var requestId = uuid(), childId = uuid();
    var pos = placeChild(parent, BRANCH_FOLLOWUP);
    var node = {
      id: childId,
      parent_id: parent.id,
      title: synthesis ? "Synthesis" : lens ? lensLabel(lens) : truncate(question, 48),
      html: "",
      md: "",
      read: false,
      origin: { selected_text: "", question, lens, synthesis: !!synthesis, anchor: null, branch_type: BRANCH_FOLLOWUP },
      x: pos.x,
      y: pos.y,
      w: DEFAULT_CHILD.w,
      h: DEFAULT_CHILD.h,
      font_scale: 1,
      collapsed: false,
      status: "pending",
      _order: nextOrder(),
      _startTs: Date.now()
    };
    nodes[childId] = node;
    if (canvasBuilt) {
      createNodeEl(node, true);
      renderVisibility();
      drawEdges();
    }
    if (currentNodeId === parent.id && mode === "reader") {
      if (synthesis) renderSidebar();
      else {
        var t = ensureThread();
        if (t) t.appendChild(buildThreadItem(node));
      }
    }
    var payload = {
      type: "branch_request",
      request_id: requestId,
      node_id: childId,
      parent_id: parent.id,
      selected_text: "",
      question,
      lens,
      anchor: null,
      branch_type: BRANCH_FOLLOWUP,
      position: { x: node.x, y: node.y },
      size: { w: node.w, h: node.h }
    };
    if (synthesis) payload.synthesis = true;
    askHooks.post(payload).then(function(res) {
      if (!res || !res.ok) rollbackBranch(node);
    });
    refreshAmbient();
    return node;
  }
  var scrollAnimId = 0;
  var scrollAnimIgnoreUntil = 0;
  function cancelScrollAnimation() {
    scrollAnimId++;
  }
  function setAnimatedScrollTop(el, value) {
    scrollAnimIgnoreUntil = performance.now() + 80;
    el.scrollTop = value;
  }
  function animateScroll(el, target, source) {
    var myId = ++scrollAnimId;
    if (document.hidden || shouldReduceMotion() || source !== "pointer") {
      el.scrollTop = target;
      return;
    }
    var s = el.scrollTop, t0 = performance.now(), D = 240;
    function step(t) {
      if (myId !== scrollAnimId) return;
      var p = Math.min(1, (t - t0) / D), k = easeOutMotion(p);
      setAnimatedScrollTop(el, s + (target - s) * k);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function interruptScrollAnimation() {
    cancelScrollAnimation();
  }
  function submitFollowup(source) {
    if (closed) {
      flashHint(frozen ? "This is a read-only snapshot." : "Session ended \u2014 reopen this Rabbithole from your terminal to continue.");
      return;
    }
    var parent = nodes[currentNodeId];
    if (!parent || parent.status === "pending") return;
    var question = composerText.value.trim();
    if (!question) return;
    sendFollowup(parent, question, null);
    composerText.value = "";
    autoGrowComposer();
    updateComposerState();
    animateScroll(readerMain, readerMain.scrollHeight, source);
  }
  function rollbackBranch(node) {
    var live = nodes[node.id];
    if (!live || live.status === "answered") return;
    delete nodes[node.id];
    if (node.el && node.el.parentNode) node.el.parentNode.removeChild(node.el);
    removeMarks(readerMain, node.id);
    removeThreadItem(node.id);
    var p = nodes[node.parent_id];
    if (p && p.bodyEl) removeMarks(p.bodyEl, node.id);
    if (canvasBuilt) drawEdges();
    if (mode === "reader" && currentNodeId === node.parent_id) renderSidebar();
    refreshAmbient();
    flashHint("Couldn't reach the agent \u2014 that ask was undone.");
  }
  function subtreeBounds(node) {
    var b = nodeBounds(node);
    if (!node.collapsed) {
      childrenOf(node.id).sort(nodeOrder).forEach(function(k) {
        b = unionBounds(b, subtreeBounds(k));
      });
    }
    return b;
  }
  function placeChild(parent, branchType) {
    var type = branchType === BRANCH_SELECTION ? BRANCH_SELECTION : BRANCH_FOLLOWUP;
    var x = type === BRANCH_SELECTION ? parent.x + parent.w + TREE_PARENT_GAP : parent.x;
    var y = type === BRANCH_SELECTION ? parent.y : parent.y + effH(parent) + TREE_PARENT_GAP;
    var sibs = childrenOf(parent.id).sort(nodeOrder);
    sibs.forEach(function(s) {
      if (branchTypeOf(s) === type) {
        y = Math.max(y, subtreeBounds(s).maxY + TREE_STACK_GAP);
      }
    });
    var blockers = sibs.filter(function(s) {
      return branchTypeOf(s) !== type;
    }).map(subtreeBounds).sort(function(a, b) {
      return a.minY - b.minY || a.minX - b.minX;
    });
    var candidate = { minX: x, minY: y, maxX: x + DEFAULT_CHILD.w, maxY: y + DEFAULT_CHILD.h };
    var bumped = true, guard = 0;
    while (bumped && guard++ < 100) {
      bumped = false;
      blockers.forEach(function(b) {
        if (boundsOverlap(candidate, b)) {
          y = b.maxY + TREE_STACK_GAP;
          candidate = { minX: x, minY: y, maxX: x + DEFAULT_CHILD.w, maxY: y + DEFAULT_CHILD.h };
          bumped = true;
        }
      });
    }
    return { x, y };
  }

  // src/ui/image-ux.js
  var imageResizeMemory = {};
  var activeLightbox = null;
  var IMAGE_MIN_WIDTH = 120;
  var LIGHTBOX_MIN_ZOOM = 0.25;
  var LIGHTBOX_MAX_ZOOM = 6;
  function imageSurfaceScale(dc) {
    if (!dc || !dc.offsetWidth) return 1;
    var rect = dc.getBoundingClientRect();
    return rect.width ? rect.width / dc.offsetWidth : 1;
  }
  function imageMemoryKey(dc, img, index, surfaceKey) {
    var nodeId = dc && dc.dataset && dc.dataset.nodeId || "doc";
    return String(surfaceKey || "surface") + ":" + nodeId + ":" + index + ":" + (img.getAttribute("src") || "");
  }
  function clampImageWidth(dc, value) {
    var max = Math.max(IMAGE_MIN_WIDTH, dc ? dc.clientWidth : IMAGE_MIN_WIDTH);
    return Math.max(IMAGE_MIN_WIDTH, Math.min(max, value));
  }
  function nearestImageScrollContainer(el) {
    var cur = el ? el.parentElement : null;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      var style = window.getComputedStyle(cur);
      var oy = style.overflowY;
      if ((oy === "auto" || oy === "scroll" || oy === "overlay") && cur.scrollHeight > cur.clientHeight + 1) return cur;
      cur = cur.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }
  function imageScrollScale(scroller) {
    if (!scroller || !scroller.offsetHeight) return 1;
    var rect = scroller.getBoundingClientRect();
    return rect.height ? rect.height / scroller.offsetHeight : 1;
  }
  function keepImageHandleAnchored(scroller, beforeRect, afterRect) {
    if (!scroller || !beforeRect || !afterRect) return;
    var delta = afterRect.bottom - beforeRect.bottom;
    if (!delta) return;
    scroller.scrollTop += delta / imageScrollScale(scroller);
  }
  function applyImageWidth(frame, width) {
    frame.style.width = Math.round(width) + "px";
    frame.dataset.rhResized = "1";
  }
  function resetImageWidth(frame, key) {
    frame.style.width = "";
    delete frame.dataset.rhResized;
    if (key) delete imageResizeMemory[key];
  }
  function beginImageResize(e, dc, frame, key) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    hideAsk();
    var scale = imageSurfaceScale(dc);
    var startX = e.clientX;
    var startW = frame.getBoundingClientRect().width / scale;
    var scroller = nearestImageScrollContainer(frame);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (_e) {
    }
    function move(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var next = clampImageWidth(dc, startW + (ev.clientX - startX) / scale);
      var before = frame.getBoundingClientRect();
      applyImageWidth(frame, next);
      keepImageHandleAnchored(scroller, before, frame.getBoundingClientRect());
      imageResizeMemory[key] = next;
      scheduleEdges();
    }
    function done(ev) {
      if (ev) ev.stopPropagation();
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", done, true);
      window.removeEventListener("pointercancel", done, true);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch (_e) {
      }
      scheduleEdges();
    }
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", done, true);
    window.addEventListener("pointercancel", done, true);
  }
  function setLightboxTransform(img, state) {
    img.style.setProperty("--rh-zoom", state.scale);
    img.style.setProperty("--rh-pan-x", Math.round(state.x) + "px");
    img.style.setProperty("--rh-pan-y", Math.round(state.y) + "px");
  }
  function clampLightboxZoom(value) {
    return Math.max(LIGHTBOX_MIN_ZOOM, Math.min(LIGHTBOX_MAX_ZOOM, value));
  }
  function pointerDistance(a, b) {
    var dx = a.clientX - b.clientX;
    var dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function openImageLightbox(src, alt) {
    closeImageLightbox();
    var overlay = document.createElement("div");
    overlay.className = "rh-lightbox";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", alt || "Image preview");
    var img = document.createElement("img");
    img.className = "rh-lightbox-img";
    img.src = src;
    img.alt = alt || "";
    img.draggable = false;
    overlay.appendChild(img);
    document.body.appendChild(overlay);
    var state = { scale: 1, x: 0, y: 0 };
    var drag = null;
    var pointers = {};
    var pinch = null;
    setLightboxTransform(img, state);
    activeLightbox = { el: overlay, key: onKey };
    function onKey(e) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeImageLightbox();
    }
    function clearPointer(id) {
      delete pointers[id];
      var keys = Object.keys(pointers);
      if (keys.length < 2) pinch = null;
      if (!keys.length) drag = null;
    }
    overlay.addEventListener("click", function(e) {
      if (e.target === overlay) closeImageLightbox();
    });
    overlay.addEventListener("wheel", function(e) {
      e.preventDefault();
      e.stopPropagation();
      var next = clampLightboxZoom(state.scale * (e.deltaY < 0 ? 1.12 : 0.88));
      state.scale = next;
      if (state.scale <= 1) {
        state.x = 0;
        state.y = 0;
      }
      setLightboxTransform(img, state);
    }, { passive: false });
    overlay.addEventListener("pointerdown", function(e) {
      e.preventDefault();
      e.stopPropagation();
      pointers[e.pointerId] = { clientX: e.clientX, clientY: e.clientY };
      try {
        overlay.setPointerCapture(e.pointerId);
      } catch (_e) {
      }
      var ids = Object.keys(pointers);
      if (ids.length >= 2) {
        pinch = { dist: pointerDistance(pointers[ids[0]], pointers[ids[1]]), scale: state.scale };
        drag = null;
      } else if (e.target === img && state.scale > 1) {
        drag = { x: e.clientX, y: e.clientY, ox: state.x, oy: state.y };
      }
    });
    overlay.addEventListener("pointermove", function(e) {
      if (!pointers[e.pointerId]) return;
      e.preventDefault();
      e.stopPropagation();
      pointers[e.pointerId] = { clientX: e.clientX, clientY: e.clientY };
      var ids = Object.keys(pointers);
      if (pinch && ids.length >= 2) {
        var dist = pointerDistance(pointers[ids[0]], pointers[ids[1]]);
        if (pinch.dist > 0) state.scale = clampLightboxZoom(pinch.scale * dist / pinch.dist);
        if (state.scale <= 1) {
          state.x = 0;
          state.y = 0;
        }
        setLightboxTransform(img, state);
      } else if (drag && state.scale > 1) {
        state.x = drag.ox + e.clientX - drag.x;
        state.y = drag.oy + e.clientY - drag.y;
        setLightboxTransform(img, state);
      }
    });
    overlay.addEventListener("pointerup", function(e) {
      clearPointer(e.pointerId);
    });
    overlay.addEventListener("pointercancel", function(e) {
      clearPointer(e.pointerId);
    });
    document.addEventListener("keydown", onKey, true);
  }
  function closeImageLightbox() {
    if (!activeLightbox) return;
    document.removeEventListener("keydown", activeLightbox.key, true);
    if (activeLightbox.el && activeLightbox.el.parentNode) activeLightbox.el.parentNode.removeChild(activeLightbox.el);
    activeLightbox = null;
  }
  function mountDocImages(dc, node, base, surfaceKey) {
    if (!dc || !dc.querySelectorAll) return;
    var imgs = dc.querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (img.dataset.rhImgReady === "1") continue;
      if (img.closest(".viz, .viz-mounted")) continue;
      var frame = img.parentNode && img.parentNode.classList && img.parentNode.classList.contains("rh-img-frame") ? img.parentNode : null;
      if (!frame) {
        frame = document.createElement("span");
        frame.className = "rh-img-frame";
        img.parentNode.insertBefore(frame, img);
        frame.appendChild(img);
      }
      var key = imageMemoryKey(dc, img, i, surfaceKey || visualSurfaceKey(node, base));
      img.dataset.rhImgReady = "1";
      img.draggable = false;
      if (imageResizeMemory[key]) applyImageWidth(frame, imageResizeMemory[key]);
      var handle = document.createElement("button");
      handle.type = "button";
      handle.className = "rh-img-handle";
      handle.setAttribute("aria-label", "Resize image");
      handle.title = "Drag to resize \xB7 double-click to reset";
      frame.appendChild(handle);
      frame.addEventListener("pointerdown", function(e) {
        e.stopPropagation();
      });
      img.addEventListener("click", function(e) {
        e.preventDefault();
        e.stopPropagation();
        openImageLightbox(e.currentTarget.currentSrc || e.currentTarget.src, e.currentTarget.alt);
      });
      handle.addEventListener("pointerdown", /* @__PURE__ */ (function(f, k) {
        return function(e) {
          beginImageResize(e, dc, f, k);
        };
      })(frame, key));
      handle.addEventListener("dblclick", /* @__PURE__ */ (function(f, k) {
        return function(e) {
          e.preventDefault();
          e.stopPropagation();
          var scroller = nearestImageScrollContainer(f);
          var before = f.getBoundingClientRect();
          resetImageWidth(f, k);
          keepImageHandleAnchored(scroller, before, f.getBoundingClientRect());
          scheduleEdges();
        };
      })(frame, key));
    }
  }

  // src/ui/palette.js
  var paletteHooks = {
    hideAsk: function() {
    },
    hidePeek: function() {
    },
    closeShare: function() {
    },
    hideConfirm: function() {
    }
  };
  function registerPaletteHooks(hooks) {
    Object.assign(paletteHooks, hooks || {});
  }
  function getPlain(node) {
    if (node._plainFor !== node.html) {
      var d = document.createElement("div");
      d.innerHTML = node.html || "";
      node._plainFor = node.html;
      node._plain = d.textContent || "";
    }
    return node._plain || "";
  }
  var palOpen = false;
  var palSel = 0;
  var palItems = [];
  var palCanvasCommands = false;
  function initPalette() {
    paletteEl.addEventListener("mousedown", function(e) {
      if (e.target === paletteEl) closePalette();
    });
    palText.addEventListener("input", function() {
      renderPalette(palText.value);
    });
    palText.addEventListener("keydown", onPaletteKeydown);
    palResults.addEventListener("click", onPaletteClick);
    palResults.addEventListener("mousemove", onPaletteMousemove);
  }
  function togglePalette() {
    if (palOpen) closePalette();
    else openPalette();
  }
  function openPalette() {
    palOpen = true;
    palCanvasCommands = mode === "canvas";
    paletteHooks.hideAsk();
    paletteHooks.hidePeek();
    paletteHooks.closeShare();
    paletteHooks.hideConfirm();
    paletteEl.classList.add("visible");
    palText.value = "";
    renderPalette("");
    palText.focus();
  }
  function closePalette() {
    palOpen = false;
    palCanvasCommands = false;
    paletteEl.classList.remove("visible");
    palText.blur();
  }
  function onPaletteKeydown(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePalette();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      movePalSel(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      movePalSel(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      commitPal("keyboard");
    }
  }
  function renderPalette(q) {
    var tokens = q.toLowerCase().split(/\s+/).filter(function(t2) {
      return !!t2;
    });
    var scored = [];
    for (var id in nodes) {
      var n = nodes[id];
      var title = (n.title || "").toLowerCase();
      var ask2 = ((n.origin && n.origin.selected_text || "") + " " + (n.origin && n.origin.question || "")).toLowerCase();
      var body = getPlain(n).toLowerCase();
      var score = 0, ok = true;
      for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        if (title.indexOf(t) !== -1) score += title.indexOf(t) === 0 ? 40 : 30;
        else if (ask2.indexOf(t) !== -1) score += 15;
        else if (body.indexOf(t) !== -1) score += 5;
        else {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      scored.push({ n, score });
    }
    scored.sort(function(a, b) {
      return b.score - a.score || (b.n._order || 0) - (a.n._order || 0);
    });
    scored = scored.slice(0, 12);
    palItems = scored.map(function(s) {
      return { type: "node", id: s.n.id };
    }).concat(paletteCommandItems(tokens));
    palSel = 0;
    if (!palItems.length) {
      palResults.innerHTML = tokens.length ? '<div class="pal-empty">Nothing in this hole matches that.</div>' : "";
      return;
    }
    var html = "";
    palItems.forEach(function(item, i2) {
      if (item.type === "command") {
        html += '<div class="pal-item pal-command' + (i2 === palSel ? " sel" : "") + '" data-idx="' + i2 + '">';
        html += '<div class="pal-t"><span class="pal-title">' + esc(item.name) + '</span><kbd class="pal-kbd">' + esc(item.kbd) + "</kbd></div>";
        html += "</div>";
        return;
      }
      var n2 = nodes[item.id];
      if (!n2) return;
      var badge = n2.origin && n2.origin.synthesis ? '<span class="lens-badge">\u2726 Synthesis</span>' : n2.origin && n2.origin.lens ? lensBadgeHtml(n2.origin.lens) : "";
      var flags = n2.status === "pending" ? '<span class="pal-writing">writing\u2026</span>' : isUnread(n2) ? '<span class="pal-dot"></span>' : "";
      html += '<div class="pal-item' + (i2 === palSel ? " sel" : "") + '" data-idx="' + i2 + '">';
      html += '<div class="pal-t">' + flags + '<span class="pal-title">' + esc(n2.title || "Untitled") + "</span>" + badge + "</div>";
      html += '<div class="pal-s">' + palSnippet(n2, tokens) + "</div>";
      html += "</div>";
    });
    palResults.innerHTML = html;
  }
  function paletteCommandItems(tokens) {
    if (!palCanvasCommands) return [];
    var commands = [
      { type: "command", name: "Frame everything", kbd: "F", run: function() {
        frameAll(true, "keyboard");
      } },
      { type: "command", name: "Tidy up layout", kbd: "T", run: function() {
        tidy("keyboard");
      } }
    ];
    var out = [];
    for (var i = 0; i < commands.length; i++) {
      var c = commands[i];
      var name = c.name.toLowerCase();
      var ok = true;
      for (var t = 0; t < tokens.length; t++) {
        if (name.indexOf(tokens[t]) === -1) {
          ok = false;
          break;
        }
      }
      if (ok) out.push(c);
    }
    return out;
  }
  function palSnippet(n, tokens) {
    var body = getPlain(n);
    var lower = body.toLowerCase();
    for (var i = 0; i < tokens.length; i++) {
      var at = lower.indexOf(tokens[i]);
      if (at !== -1) {
        var start = Math.max(0, at - 34);
        var slice = (start > 0 ? "\u2026" : "") + body.slice(start, start + 120);
        return hiTokens(slice, tokens);
      }
    }
    var quote = n.origin && n.origin.selected_text;
    if (quote) return "\u201C" + hiTokens(truncate2(quote, 90), tokens) + "\u201D";
    var q = n.origin && n.origin.question;
    if (q) return hiTokens(truncate2(q, 100), tokens);
    return esc(truncate2(body, 100));
  }
  function hiTokens(text, tokens) {
    if (!tokens.length) return esc(text);
    var lower = text.toLowerCase(), out = "", i = 0;
    while (i < text.length) {
      var best = -1, bl = 0;
      for (var t = 0; t < tokens.length; t++) {
        var at = lower.indexOf(tokens[t], i);
        if (at !== -1 && (best === -1 || at < best)) {
          best = at;
          bl = tokens[t].length;
        }
      }
      if (best === -1) {
        out += esc(text.slice(i));
        break;
      }
      out += esc(text.slice(i, best)) + "<mark>" + esc(text.slice(best, best + bl)) + "</mark>";
      i = best + bl;
    }
    return out;
  }
  function movePalSel(delta) {
    if (!palItems.length) return;
    palSel = Math.max(0, Math.min(palItems.length - 1, palSel + delta));
    var items = palResults.querySelectorAll(".pal-item");
    for (var i = 0; i < items.length; i++) items[i].classList.toggle("sel", i === palSel);
    if (items[palSel]) items[palSel].scrollIntoView({ block: "nearest" });
  }
  function commitPal(source) {
    var item = palItems[palSel];
    if (!item) return;
    if (item.type === "command") {
      item.run();
      closePalette();
      return;
    }
    var node = nodes[item.id];
    closePalette();
    if (node) goToNode2(node, source);
  }
  function onPaletteClick(e) {
    var it = e.target.closest(".pal-item");
    if (!it) return;
    palSel = Number(it.dataset.idx) || 0;
    commitPal(motionSourceFromEvent(e));
  }
  function onPaletteMousemove(e) {
    var it = e.target.closest(".pal-item");
    if (!it) return;
    var idx = Number(it.dataset.idx) || 0;
    if (idx !== palSel) {
      palSel = idx;
      var items = palResults.querySelectorAll(".pal-item");
      for (var i = 0; i < items.length; i++) items[i].classList.toggle("sel", i === palSel);
    }
  }

  // src/ui/branch-surfaces.js
  var branchHooks = {
    post: function() {
      return Promise.resolve({ ok: true });
    }
  };
  function registerBranchHooks(hooks) {
    Object.assign(branchHooks, hooks || {});
  }
  var peekTimer = 0;
  var peekFor = null;
  function initBranchSurfaces() {
    readerMain.addEventListener("mouseover", onReaderMarkMouseover);
    readerMain.addEventListener("mouseout", onReaderMarkMouseout);
    peekEl.addEventListener("mouseleave", function() {
      hidePeek();
    });
    peekEl.addEventListener("click", function() {
      var kid = peekFor && nodes[peekFor];
      hidePeek();
      if (kid) openNode(kid.id);
    });
    document.getElementById("r-share").addEventListener("click", function(e) {
      e.stopPropagation();
      toggleShare(e.currentTarget);
    });
    document.getElementById("t-share").addEventListener("click", function(e) {
      e.stopPropagation();
      toggleShare(e.currentTarget);
    });
    document.getElementById("sm-doc").addEventListener("click", onCopyDoc);
    document.getElementById("sm-trail").addEventListener("click", onCopyTrail);
    document.getElementById("sm-export").addEventListener("click", onExportSnapshot);
    document.getElementById("sm-synth").addEventListener("click", function(e) {
      closeShare();
      synthesize(motionSourceFromEvent(e));
    });
    document.getElementById("cf-keep").addEventListener("click", hideConfirm);
    document.getElementById("cf-remove").addEventListener("click", function() {
      var node = confirmFor && nodes[confirmFor];
      hideConfirm();
      if (node) deleteBranch(node);
    });
  }
  function hidePeek() {
    if (peekTimer) {
      clearTimeout(peekTimer);
      peekTimer = 0;
    }
    peekFor = null;
    peekEl.classList.remove("visible");
  }
  function showPeek(mark) {
    var kid = nodes[mark.dataset.child];
    if (!kid || kid.status !== "answered") return;
    peekFor = kid.id;
    var badge = kid.origin && kid.origin.synthesis ? '<span class="lens-badge">\u2726 Synthesis</span>' : kid.origin && kid.origin.lens ? lensBadgeHtml(kid.origin.lens) : "";
    peekEl.innerHTML = '<div class="peek-title">' + (isUnread(kid) ? '<span class="pal-dot"></span>' : "") + "<span>" + esc(kid.title || "Untitled") + "</span>" + badge + '</div><div class="peek-body md">' + (kid.html || "") + '</div><div class="peek-hint">Click to open</div>';
    if (typeof mountVisuals2 === "function") {
      var peekBody = peekEl.querySelector(".peek-body");
      if (peekBody) mountVisuals2(peekBody, "peek:" + kid.id);
    }
    var r = mark.getBoundingClientRect();
    var top = r.bottom + 8;
    if (top + peekEl.offsetHeight + 10 > window.innerHeight) top = Math.max(10, r.top - peekEl.offsetHeight - 8);
    peekEl.style.left = Math.min(window.innerWidth - 360, Math.max(10, r.left)) + "px";
    peekEl.style.top = top + "px";
    peekEl.classList.add("visible");
    setSurfaceOrigin(peekEl, r);
  }
  function onReaderMarkMouseover(e) {
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (!m) return;
    var kid = nodes[m.dataset.child];
    if (!kid || kid.status !== "answered") return;
    if (peekTimer) clearTimeout(peekTimer);
    peekTimer = setTimeout(function() {
      peekTimer = 0;
      showPeek(m);
    }, 220);
  }
  function onReaderMarkMouseout(e) {
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (!m) return;
    if (peekTimer) {
      clearTimeout(peekTimer);
      peekTimer = 0;
    }
    setTimeout(function() {
      if (!peekEl.matches(":hover") && !readerMain.querySelector("mark[data-child]:hover")) hidePeek();
    }, 80);
  }
  var shareOpen = false;
  function toggleShare(anchor) {
    if (shareOpen) {
      closeShare();
      return;
    }
    var noAgent = frozen || closed;
    document.getElementById("sm-export").style.display = frozen ? "none" : "";
    document.getElementById("sm-sep2").style.display = noAgent ? "none" : "";
    document.getElementById("sm-synth").style.display = noAgent ? "none" : "";
    var r = anchor.getBoundingClientRect();
    shareMenu.style.left = Math.min(window.innerWidth - shareMenu.offsetWidth - 10, Math.max(10, r.right - shareMenu.offsetWidth)) + "px";
    shareMenu.style.top = r.bottom + 8 + "px";
    shareOpen = true;
    shareMenu.classList.add("visible");
    setSurfaceOrigin(shareMenu, r);
  }
  function closeShare() {
    shareOpen = false;
    shareMenu.classList.remove("visible");
  }
  function copyText(text, okMsg) {
    function done() {
      flashHint(okMsg);
    }
    function legacy() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch (err) {
      }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function() {
        legacy();
        done();
      });
    } else {
      legacy();
      done();
    }
  }
  function originLine(n) {
    if (!n.origin) return "";
    if (n.origin.synthesis) return "> \u2726 Synthesis of the whole Rabbithole\n\n";
    var ask2 = n.origin.lens ? lensLabel(n.origin.lens) : n.origin.question || "";
    if (n.origin.selected_text) return "> Asked about: \u201C" + n.origin.selected_text + "\u201D" + (ask2 ? " \u2014 " + ask2 : "") + "\n\n";
    return ask2 ? "> Follow-up \u2014 " + ask2 + "\n\n" : "";
  }
  function docMarkdown(n, depth) {
    var h = "#";
    for (var i = 0; i < Math.min(depth, 3); i++) h += "#";
    var body = (n.md || "").trim() || "_(still being written)_";
    return h + " " + (n.title || "Untitled") + "\n\n" + originLine(n) + body + "\n";
  }
  function trailMarkdown(id) {
    var path = lineageNodes2(id), parts = [];
    for (var i = 0; i < path.length; i++) parts.push(docMarkdown(path[i], i));
    return parts.join("\n---\n\n");
  }
  function onCopyDoc() {
    closeShare();
    var n = nodes[currentNodeId];
    if (!n) return;
    copyText(docMarkdown(n, 0), "Copied \u201C" + truncate2(n.title || "Untitled", 40) + "\u201D as Markdown");
  }
  function onCopyTrail() {
    closeShare();
    var path = lineageNodes2(currentNodeId);
    copyText(trailMarkdown(currentNodeId), path.length === 1 ? "Copied this document as Markdown" : "Copied the trail \u2014 " + path.length + " documents");
  }
  function onExportSnapshot() {
    closeShare();
    window.location.href = "/export";
    flashHint("Snapshot downloading \u2014 a single file that opens anywhere.");
  }
  function synthesize(source) {
    if (closed) {
      flashHint("Session ended \u2014 reopen this Rabbithole from your terminal first.");
      return;
    }
    var root = nodes[rootId];
    if (!root) return;
    for (var k in nodes) {
      var n = nodes[k];
      if (n.status === "pending" && n.origin && n.origin.synthesis) {
        flashHint("A synthesis is already being written\u2026");
        goToNode(n, source);
        return;
      }
    }
    var q = "Step back and write the synthesis of this whole Rabbithole so far: the key ideas we explored, how they connect, and the takeaways worth keeping. Make it a standalone summary of the journey.";
    var kid = sendFollowup(root, q, null, true);
    if (mode === "canvas") revealNode(kid, source);
    flashHint("\u2726 Synthesizing this journey \u2014 it will appear as a branch of the root document.");
  }
  var confirmFor = null;
  function confirmDelete(node, anchor) {
    if (closed) {
      flashHint(frozen ? "This is a read-only snapshot." : "Session ended \u2014 changes can't be saved anymore.");
      return;
    }
    confirmFor = node.id;
    var subCount = countSubtree(node.id) - 1;
    document.getElementById("cf-msg").textContent = subCount > 0 ? "Remove this branch and " + subCount + " inside it?" : "Remove this branch?";
    var r = anchor.getBoundingClientRect();
    confirmEl.style.left = Math.min(window.innerWidth - confirmEl.offsetWidth - 10, Math.max(10, r.right - confirmEl.offsetWidth)) + "px";
    confirmEl.style.top = r.bottom + 8 + "px";
    confirmEl.classList.add("visible");
    setSurfaceOrigin(confirmEl, r);
  }
  function hideConfirm() {
    confirmFor = null;
    confirmEl.classList.remove("visible");
  }
  function countSubtree(id) {
    var c = 1;
    childrenOf(id).forEach(function(k) {
      c += countSubtree(k.id);
    });
    return c;
  }
  function collectSubtree(id, out) {
    out.push(id);
    childrenOf(id).forEach(function(k) {
      collectSubtree(k.id, out);
    });
    return out;
  }
  function deleteBranch(node) {
    var title = node.title || "Untitled";
    var ids = collectSubtree(node.id, []);
    branchHooks.post({ type: "delete_node", node_id: node.id });
    removeNodesLocal(ids, node.parent_id);
    flashHint(ids.length > 1 ? "Removed \u201C" + truncate2(title, 40) + "\u201D and " + (ids.length - 1) + " inside it" : "Removed \u201C" + truncate2(title, 40) + "\u201D");
  }
  function removeNodesLocal(ids, parentId) {
    var currentGone = false;
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], n = nodes[id];
      if (!n) continue;
      if (currentNodeId === id) currentGone = true;
      if (n.el && n.el.parentNode) n.el.parentNode.removeChild(n.el);
      removeMarks(readerMain, id);
      removeThreadItem(id);
      var p = nodes[n.parent_id];
      if (p && p.bodyEl) removeMarks(p.bodyEl, id);
      clearEdgeHighlight(id);
      delete nodes[id];
    }
    if (currentGone) {
      setCurrentNodeId(parentId && nodes[parentId] ? parentId : rootId);
      if (mode === "reader") openNode(currentNodeId);
    }
    if (canvasBuilt) {
      renderVisibility();
      drawEdges();
    }
    if (mode === "reader") {
      renderBreadcrumb();
      renderSidebar();
    }
    refreshAmbient();
    updateSince();
  }

  // src/ui/transport-status.js
  function initTransportStatus() {
    document.getElementById("banner-x").addEventListener("click", function() {
      if (bannerKey) bannerDismissed[bannerKey] = true;
      bannerEl.classList.remove("visible");
    });
  }
  function post(payload) {
    if (frozen) return Promise.resolve({ ok: true });
    return fetch("/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(function() {
      return null;
    });
  }
  var viewSaveTimer = 0;
  function scheduleViewSave() {
    if (frozen || closed) return;
    if (viewSaveTimer) clearTimeout(viewSaveTimer);
    viewSaveTimer = setTimeout(function() {
      viewSaveTimer = 0;
      if (closed) return;
      var cur = nodes[currentNodeId];
      var scroll = mode === "reader" ? readerMain.scrollTop : cur && cur._scrollTop || 0;
      post({ type: "view_state", state: { mode, node_id: currentNodeId, scroll, view: { x: view.x, y: view.y, scale: view.scale } } });
    }, 600);
  }
  var saveTimers = {};
  function persistNode(node) {
    if (saveTimers[node.id]) clearTimeout(saveTimers[node.id]);
    saveTimers[node.id] = setTimeout(function() {
      post({ type: "node_update", node_id: node.id, position: { x: node.x, y: node.y }, size: { w: node.w, h: node.h }, collapsed: node.collapsed, font_scale: node.font_scale });
    }, 350);
  }
  function persistNodesBulk(list) {
    if (!list || !list.length) return;
    post({ type: "nodes_update", nodes: list.map(function(n) {
      return { node_id: n.id, position: { x: n.x, y: n.y }, size: { w: n.w, h: n.h }, collapsed: n.collapsed, font_scale: n.font_scale };
    }) });
  }
  var sse = null;
  function connectSse() {
    var after = hydration.last_event_id || 0;
    sse = new EventSource("/sse?after=" + after);
    sse.onopen = function() {
      resetSseFails();
      if (connLost2) {
        setConnLost(false);
        refreshStatus();
      }
    };
    sse.onmessage = function(ev) {
      try {
        handleServer(JSON.parse(ev.data));
      } catch (e) {
      }
    };
    sse.onerror = function() {
      if (closed) return;
      if (incrementSseFails() >= 2 && !connLost2) {
        fetch("/health", { cache: "no-store" }).then(function(r) {
          if (!r.ok) throw new Error("bad status");
        }).catch(function() {
          if (!closed && !connLost2) {
            setConnLost(true);
            refreshStatus();
          }
        });
      }
    };
  }
  function renderStreamSurfaces(node, firstChunk) {
    if (node.bodyEl) {
      var cs = node.bodyEl.scrollTop;
      fillBody(node);
      node.bodyEl.scrollTop = cs;
      scheduleEdges();
    }
    if (mode !== "reader") return;
    var keep = readerMain.scrollTop;
    if (currentNodeId === node.id) {
      var rdc = readerMain.querySelector('.doc-content[data-node-id="' + node.id + '"]');
      if (rdc) {
        rdc.innerHTML = "";
        if (node.html) fillStreaming(rdc, node, "reader:" + node.id);
        else rdc.appendChild(buildLoading(node));
        readerMain.scrollTop = keep;
      }
    } else if (currentNodeId === node.parent_id) {
      if (isFollowup(node)) {
        updateThreadItem(node);
        readerMain.scrollTop = keep;
      } else {
        var live = sideEl.querySelector('.side-item[data-child="' + node.id + '"] .si-live .md');
        if (live && !firstChunk) {
          live.innerHTML = node.html || "";
          if (typeof mountVisuals === "function") mountVisuals(live, "reader-side:" + node.id);
        } else renderSidebar();
      }
    }
  }
  function handleServer(msg) {
    if (msg.type === "node_answered") {
      var node = nodes[msg.node_id];
      if (!node) {
        var pos = msg.position || {};
        node = nodes[msg.node_id] = {
          id: msg.node_id,
          parent_id: msg.parent_id || null,
          title: msg.title || "\u2026",
          html: "",
          md: "",
          read: false,
          origin: msg.origin || null,
          x: pos.x || 0,
          y: pos.y || 0,
          w: DEFAULT_CHILD.w,
          h: DEFAULT_CHILD.h,
          font_scale: msg.font_scale || 1,
          collapsed: false,
          status: "pending",
          _order: nextOrder(),
          _startTs: Date.now()
        };
        if (canvasBuilt) {
          createNodeEl(node);
          renderVisibility();
          drawEdges();
        }
        if (node.origin && node.origin.anchor) {
          if (mode === "reader")
            wrapInContainer(readerMain.querySelector('.doc-content[data-node-id="' + node.parent_id + '"]'), node.origin.anchor, node.id, "hl mark-pending");
          var pp = nodes[node.parent_id];
          if (pp && pp.bodyEl) wrapInContainer(pp.bodyEl.querySelector(".doc-content"), node.origin.anchor, node.id, "hl mark-pending");
        }
      }
      node.status = "answered";
      node.title = msg.title || node.title;
      node.html = msg.contentHtml || "";
      node.md = msg.markdown || node.md || "";
      node.read = false;
      if (node.titleEl) {
        node.titleEl.textContent = node.title;
        node.titleEl.title = node.title;
      }
      if (node.bodyEl) {
        fillBody(node);
        scheduleEdges();
      }
      updateCardComposer(node);
      if (mode === "reader") {
        if (currentNodeId === node.id) {
          renderBreadcrumb();
          renderReaderBody();
          renderSidebar();
          updateComposerState();
          markRead(node);
        } else {
          upgradeMarks(readerMain, node.id);
          if (currentNodeId === node.parent_id) {
            if (isFollowup(node)) {
              updateThreadItem(node);
              markRead(node);
            } else renderSidebar();
          }
        }
      }
      var p = nodes[node.parent_id];
      if (p && p.bodyEl) upgradeMarks(p.bodyEl, node.id);
      if (isUnread(node) && node.el) node.el.classList.add("unread");
      refreshAmbient();
      updateSince();
    } else if (msg.type === "node_deleted") {
      removeNodesLocal(msg.node_ids || [], null);
    } else if (msg.type === "node_progress") {
      var sn = nodes[msg.node_id];
      if (sn && sn.status === "pending") {
        var firstChunk = !sn.html;
        sn.html = msg.contentHtml || "";
        renderStreamSurfaces(sn, firstChunk);
      }
    } else if (msg.type === "agent_status") {
      setAgentAttached(!!msg.attached);
      setAgentReason(msg.reason || null);
      refreshStatus();
    } else if (msg.type === "session_closed") {
      setClosedState(true, msg.reason || "session_closed");
      if (sse) {
        try {
          sse.close();
        } catch (e) {
        }
        sse = null;
      }
      refreshStatus();
    }
  }
  var bannerKey = null;
  var bannerDismissed = {};
  function setBanner(key, warn, title, msg) {
    bannerKey = key;
    if (bannerDismissed[key]) {
      bannerEl.classList.remove("visible");
      return;
    }
    bannerTitle.textContent = title;
    bannerMsg.textContent = msg;
    bannerEl.classList.toggle("warn", !!warn);
    bannerEl.classList.add("visible");
  }
  function clearBanner() {
    bannerKey = null;
    bannerEl.classList.remove("visible");
  }
  function hasPendingAsks() {
    for (var k in nodes) if (nodes[k].status === "pending") return true;
    return false;
  }
  function refreshStatus() {
    document.body.classList.toggle("agent-down", agentDown());
    document.body.classList.toggle("session-over", closed);
    var savedNote = hasPendingAsks() ? " Your unanswered questions are saved and will be answered there." : "";
    if (frozen) {
      clearBanner();
    } else if (closed) {
      if (closedReason === "done")
        setBanner("done", false, "Session ended", "This Rabbithole is saved. Reopen it from your terminal any time to keep exploring." + savedNote);
      else if (closedReason === "superseded")
        setBanner("superseded", false, "Reopened elsewhere", "This Rabbithole was just reopened in another tab \u2014 continue there. This view is now read-only.");
      else if (closedReason === "timeout")
        setBanner("timeout", true, "Session timed out", "Everything is saved. Reopen this Rabbithole from your terminal to continue." + savedNote);
      else
        setBanner("closed", true, "The agent has left", "Everything answered so far is saved. Reopen this Rabbithole from your terminal to keep exploring." + savedNote);
    } else if (connLost2) {
      setBanner("connlost", true, "Connection lost", "Can't reach the agent session \u2014 it may have exited. Your Rabbithole is saved; reopen it from your terminal to continue.");
    } else if (!agentAttached2) {
      if (agentReason === "stalled")
        setBanner("stalled", true, "The agent went quiet", "No response for a while \u2014 it may have stopped. You can keep asking: questions are saved and answered when the agent returns.");
      else
        setBanner("cancelled", true, "The agent stopped listening", "The tool call was cancelled. You can keep asking \u2014 questions are saved and answered when the agent picks this hole back up.");
    } else {
      clearBanner();
      bannerDismissed = {};
    }
    if (mode === "reader") renderSidebar();
    updateComposerState();
    if (canvasBuilt) for (var cid in nodes) updateCardComposer(nodes[cid]);
  }

  // src/ui/chrome-init.js
  function initChrome() {
    document.addEventListener("keydown", onGlobalKeydown);
    applyInitialTheme();
    hydrateInitialState();
  }
  function onGlobalKeydown(e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      togglePalette();
      return;
    }
    if (e.target && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT")) return;
    if (e.key === "?") {
      flashHint("j / k \u2014 walk the highlights \xB7 \u21B5 open \xB7 \u232B up a level \xB7 \u2318K search");
      return;
    }
    if (e.key === "Escape" && mode === "canvas") {
      openNode(currentNodeId);
      return;
    }
    if ((e.key === "f" || e.key === "F") && mode === "canvas") {
      frameAll(true, "keyboard");
      return;
    }
    if ((e.key === "t" || e.key === "T") && mode === "canvas") {
      tidy("keyboard");
      return;
    }
    if (mode !== "reader") return;
    if (e.key === "j" || e.key === "k") {
      e.preventDefault();
      stepMark(e.key === "j" ? 1 : -1);
    } else if (e.key === "Enter") {
      var m = focusedMark();
      if (m) {
        e.preventDefault();
        var kid = nodes[m.dataset.child];
        if (kid) openNode(kid.id);
      }
    } else if (e.key === "Backspace") {
      var cur = nodes[currentNodeId];
      if (cur && cur.parent_id && nodes[cur.parent_id]) {
        e.preventDefault();
        jumpToOrigin(cur, "keyboard");
      }
    }
  }
  function applyInitialTheme() {
    try {
      var savedTheme = localStorage.getItem("rh-theme");
      if (!savedTheme && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) savedTheme = "dark";
      if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);
    } catch (e) {
    }
  }
  function hydrateInitialState() {
    if (frozen) document.body.classList.add("frozen");
    (hydration.nodes || []).forEach(function(raw) {
      var isRoot = raw.id === rootId;
      var size = raw.size || (isRoot ? DEFAULT_ROOT : DEFAULT_CHILD);
      nodes[raw.id] = {
        id: raw.id,
        parent_id: raw.parent_id,
        title: raw.title,
        html: raw.contentHtml,
        md: raw.markdown || "",
        read: !!raw.read,
        origin: raw.origin,
        x: raw.position && raw.position.x || 0,
        y: raw.position && raw.position.y || 0,
        w: size.w,
        h: size.h,
        font_scale: raw.font_scale || 1,
        collapsed: !!raw.collapsed,
        status: raw.status || "answered",
        _order: 0,
        _startTs: raw.status === "pending" ? Date.now() : 0
      };
    });
    Object.keys(nodes).forEach(function(id) {
      nodes[id]._order = nextOrder();
    });
    var anyRead = false, k;
    for (k in nodes) if (nodes[k].read) anyRead = true;
    if (!anyRead && !hydration.view_state) {
      var legacy = [];
      for (k in nodes) {
        if (nodes[k].status === "answered") {
          nodes[k].read = true;
          legacy.push({ node_id: k, read: true });
        }
      }
      if (!frozen && legacy.length) post({ type: "nodes_update", nodes: legacy });
    }
    var vs = hydration.view_state;
    if (vs && vs.node_id && nodes[vs.node_id]) {
      setCurrentNodeId(vs.node_id);
      if (vs.scroll) nodes[vs.node_id]._scrollTop = vs.scroll;
    }
    if (vs && vs.view) {
      view.x = vs.view.x;
      view.y = vs.view.y;
      view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, vs.view.scale || 1));
      setCanvasFramed(true);
    }
    openNode(currentNodeId);
    if (vs && vs.mode === "canvas") setMode("canvas");
    if (unreadNodes().length) {
      armSince();
      updateSince();
    }
    refreshAmbient();
    refreshStatus();
    if (!frozen) connectSse();
  }

  // src/ui/entry.js
  function startRabbithole(hydration2) {
    initCore(hydration2);
    initVisuals();
    registerCoreHooks({
      post,
      openNode,
      mountVisuals: mountVisuals2,
      mountDocImages,
      ensureCanvasBuilt: function() {
      },
      diveToNode,
      effH
    });
    registerReaderHooks({
      hideAsk,
      hidePeek,
      updateComposerState,
      scheduleViewSave,
      setMode,
      post,
      mountVisuals: mountVisuals2,
      mountDocImages,
      persistNode,
      animateScroll
    });
    registerCanvasHooks({
      hideAsk,
      hidePeek,
      sendFollowup,
      confirmDelete,
      persistNode,
      persistNodesBulk,
      scheduleViewSave
    });
    registerAskHooks({
      post,
      closeShare,
      hideConfirm,
      hidePeek
    });
    registerPaletteHooks({
      hideAsk,
      hidePeek,
      closeShare,
      hideConfirm
    });
    registerBranchHooks({ post });
    initReader();
    initCanvasView();
    initAskFollowups();
    initPalette();
    initBranchSurfaces();
    initTransportStatus();
    initChrome();
  }
  return __toCommonJS(entry_exports);
})();
