import {
  BRANCH_FOLLOWUP,
  BRANCH_SELECTION,
  CANVAS_BASE,
  DEFAULT_CHILD,
  MAX_FS,
  MAX_SCALE,
  MIN_FS,
  MIN_SCALE,
  READER_BASE,
  SVGNS,
  TREE_PARENT_GAP,
  TREE_STACK_GAP,
  boundsOverlap,
  branchTypeOf,
  buildDocContent,
  canvasBuilt,
  canvasFramed,
  childrenOf,
  closed,
  connLost,
  currentNodeId,
  easeInOutMotion,
  easeOutMotion,
  edgesSvg,
  fontPx,
  flashHint,
  frozen,
  agentAttached,
  isFollowup,
  isSelectionBranch,
  isUnread,
  isVisible,
  lensLabel,
  markRead,
  mode,
  motionSourceFromEvent,
  nodeBounds,
  nodeOrder,
  nodes,
  playLandingCue,
  readerMain,
  registerCoreHooks,
  rootId,
  setCanvasBuilt,
  setCanvasFramed,
  setModeValue,
  shiftBounds,
  shouldReduceMotion,
  unionBounds,
  view,
  viewport,
  world,
  zoomLabel
} from "./core.js";
import { applyChildHighlights, openNode } from "./reader.js";

var canvasHooks = {
  hideAsk: function(){},
  hidePeek: function(){},
  sendFollowup: function(){ return null; },
  confirmDelete: function(){},
  persistNode: function(){},
  persistNodesBulk: function(){},
  scheduleViewSave: function(){},
  onSelectionChange: function(){}
};

var selectedNodeIds = {};

export function registerCanvasHooks(hooks) {
  Object.assign(canvasHooks, hooks || {});
}

export function selectedCanvasNodes(){
  var out = [];
  for (var id in selectedNodeIds){
    if (selectedNodeIds[id] && nodes[id] && nodes[id].status !== "pending") out.push(nodes[id]);
  }
  out.sort(nodeOrder);
  return out;
}

export function clearCanvasSelection(){
  for (var id in selectedNodeIds){
    if (nodes[id] && nodes[id].el) nodes[id].el.classList.remove("selected");
    if (nodes[id] && nodes[id].selectBtn){
      nodes[id].selectBtn.classList.remove("active");
      nodes[id].selectBtn.textContent = "□";
      nodes[id].selectBtn.setAttribute("aria-pressed", "false");
    }
  }
  selectedNodeIds = {};
  notifySelectionChange();
}

function notifySelectionChange(){
  var count = selectedCanvasNodes().length;
  canvasHooks.onSelectionChange(count);
  try { document.dispatchEvent(new CustomEvent("rh-selection-change", { detail: { count: count } })); } catch(_e){}
}

export function initCanvasView(){
  registerCoreHooks({
    ensureCanvasBuilt: ensureCanvasBuilt,
    diveToNode: diveToNode,
    effH: effH
  });
  world.addEventListener("mouseover", onWorldMouseOver);
  world.addEventListener("mouseout", onWorldMouseOut);
  initViewportPan();
  viewport.addEventListener("wheel", onViewportWheel, { passive: false });
  viewport.addEventListener("dblclick", onViewportDblClick);
  document.getElementById("t-reader").addEventListener("click", function(){ openNode(currentNodeId); });
  document.getElementById("t-frame").addEventListener("click", function(e){ frameAll(true, motionSourceFromEvent(e)); });
  document.getElementById("t-tidy").addEventListener("click", function(e){ tidy(motionSourceFromEvent(e)); });
  document.getElementById("t-zin").addEventListener("click", function(){ zoomAt(viewport.clientWidth/2, viewport.clientHeight/2, 1.15); });
  document.getElementById("t-zout").addEventListener("click", function(){ zoomAt(viewport.clientWidth/2, viewport.clientHeight/2, 0.87); });
  zoomLabel.addEventListener("click", function(){ zoomTo(viewport.clientWidth/2, viewport.clientHeight/2, 1); });
  exposeFilmCameraHook();
}

  // ===========================================================================
  // CANVAS
  // ===========================================================================
export function applyTransform(){
    world.style.transform = "translate(" + view.x + "px," + view.y + "px) scale(" + view.scale + ")";
    zoomLabel.textContent = Math.round(view.scale * 100) + "%";
    canvasHooks.scheduleViewSave();
  }
  function exposeFilmCameraHook(){
    var enabled = false;
    try { enabled = localStorage.getItem("rh-film") === "1"; } catch(e){}
    if (!enabled) return;
    Object.defineProperty(window, "__rhFilmCamera", {
      configurable: true,
      value: {
        getView: function(){
          return { x: view.x, y: view.y, scale: view.scale };
        },
        setView: function(x, y, scale){
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
export function screenToWorld(sx, sy){ return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale }; }
  function zoomAt(sx, sy, factor){
    var next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    zoomTo(sx, sy, next);
  }
  function zoomTo(sx, sy, next){
    viewAnimId++; // manual zoom cancels any in-flight glide
    next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    if (next === view.scale) return;
    var w = screenToWorld(sx, sy); view.scale = next; view.x = sx - w.x * view.scale; view.y = sy - w.y * view.scale; applyTransform();
  }
  var NODE_EXPAND_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" aria-hidden="true"><path d="M9.25 3.75h3v3"/><path d="M12.25 3.75 8.75 7.25"/><path d="M6.75 12.25h-3v-3"/><path d="M3.75 12.25l3.5-3.5"/></svg>';
  var NODE_COLLAPSE_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" aria-hidden="true"><path d="M3 8h10"/></svg>';
  var NODE_COPY_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none" aria-hidden="true"><rect x="5" y="4" width="7" height="9" rx="1.2"/><path d="M4 11.5H3.7c-.7 0-1.2-.5-1.2-1.2V3.7c0-.7.5-1.2 1.2-1.2h5.6c.7 0 1.2.5 1.2 1.2V4"/></svg>';

export function createNodeEl(node, enter){
    var el = document.createElement("div");
    el.className = "node" + (node.id === rootId ? " root" : "");
    if (enter && !document.hidden && !shouldReduceMotion()) el.className += " node-enter";
    el.dataset.id = node.id;

    var head = document.createElement("div");
    head.className = "node-head";
    if (node.id === rootId){
      var badge = document.createElement("span"); badge.className = "node-badge"; badge.textContent = "🐇";
      badge.title = "Where this Rabbithole begins";
      head.appendChild(badge);
    }
    var selectBtn = mkBtn("□", "Select for synthesis");
    selectBtn.classList.add("node-select");
    selectBtn.setAttribute("aria-pressed", "false");
    var titleEl = document.createElement("span"); titleEl.className = "node-title"; titleEl.textContent = node.title || "…";
    titleEl.title = node.title || "";
    var aDown = mkBtn("A−", "Smaller text"); var aUp = mkBtn("A+", "Larger text");
    aDown.classList.add("node-font-btn"); aUp.classList.add("node-font-btn");
    var copyBtn = mkIconBtn(NODE_COPY_ICON, "Copy Markdown");
    copyBtn.classList.add("node-copy-btn");
    var collapseBtn = mkIconBtn(NODE_COLLAPSE_ICON, "Collapse");
    var openBtn = mkIconBtn(NODE_EXPAND_ICON, "Expand");
    var divider = document.createElement("span"); divider.className = "node-act-divider"; divider.setAttribute("aria-hidden", "true");
    var acts = document.createElement("span"); acts.className = "node-acts";
    if (node.id !== rootId){
      var delBtn = mkBtn("✕", "Remove this branch");
      delBtn.classList.add("danger");
      delBtn.addEventListener("click", function(e){ e.stopPropagation(); canvasHooks.confirmDelete(node, delBtn); });
      acts.appendChild(delBtn);
    }
    acts.appendChild(aDown); acts.appendChild(aUp); acts.appendChild(divider); acts.appendChild(collapseBtn); acts.appendChild(copyBtn); acts.appendChild(openBtn);
    head.appendChild(selectBtn); head.appendChild(titleEl); head.appendChild(acts);

    var body = document.createElement("div"); body.className = "node-body";
    var comp = buildCardComposer(node);
    var resize = document.createElement("div"); resize.className = "node-resize";
    el.appendChild(head); el.appendChild(body); el.appendChild(comp); el.appendChild(resize);
    world.appendChild(el);

    node.el = el; node.bodyEl = body; node.titleEl = titleEl; node.selectBtn = selectBtn;
    fillBody(node);
    updateCardComposer(node);
    if (node.collapsed) el.classList.add("collapsed");
    if (isUnread(node)) el.classList.add("unread");

    enableDrag(node, head);
    enableResize(node, resize);
    head.addEventListener("dblclick", function(){ openNode(node.id); });
    selectBtn.addEventListener("click", function(e){ e.stopPropagation(); toggleNodeSelected(node); });
    copyBtn.addEventListener("click", function(e){ e.stopPropagation(); copyNodeMarkdown(node); });
    openBtn.addEventListener("click", function(e){ e.stopPropagation(); openNode(node.id); });
    collapseBtn.addEventListener("click", function(e){ e.stopPropagation(); toggleCollapse(node, collapseBtn); });
    aDown.addEventListener("click", function(e){ e.stopPropagation(); setNodeFontScale(node, -0.1); });
    aUp.addEventListener("click", function(e){ e.stopPropagation(); setNodeFontScale(node, 0.1); });
    // Scrolling a card moves the inline marks its children's edges start from.
    body.addEventListener("scroll", scheduleEdges, { passive: true });
    // Engaging with an answered card (reading it in place) counts as reading it.
    body.addEventListener("pointerdown", function(){ if (node.status === "answered") markRead(node); });
    // Hovering a card lights up its edge and the exact text it branched from.
    el.addEventListener("mouseenter", function(){ focusOrigin(node, true); });
    el.addEventListener("mouseleave", function(){
      focusOrigin(node, false);
      if (node.ncComp && !node.ncText.value.trim() && document.activeElement !== node.ncText) closeCardDrawer(node);
    });

    layoutNode(node);
    if (el.classList.contains("node-enter")){
      requestAnimationFrame(function(){
        el.classList.add("entered");
        setTimeout(function(){ el.classList.remove("node-enter"); el.classList.remove("entered"); }, 220);
      });
    }
    return node;
  }

  function toggleNodeSelected(node){
    if (!node || node.status === "pending") return;
    var on = !selectedNodeIds[node.id];
    if (on) selectedNodeIds[node.id] = true;
    else delete selectedNodeIds[node.id];
    if (node.el) node.el.classList.toggle("selected", on);
    if (node.selectBtn){
      node.selectBtn.classList.toggle("active", on);
      node.selectBtn.textContent = on ? "✓" : "□";
      node.selectBtn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    flashHint(on ? "Selected for synthesis" : "Removed from synthesis selection");
    notifySelectionChange();
  }

  // Glide the canvas view into a card at reading scale.
export function diveToNode(node, source){
    var vw = viewport.clientWidth, vh = viewport.clientHeight;
    var ts = Math.min(1, Math.max(0.75, Math.min((vw - 120) / node.w, (vh - 120) / effH(node))));
    var tx = vw / 2 - (node.x + node.w / 2) * ts;
    var ty = vh / 2 - (node.y + effH(node) / 2) * ts;
    animateView(tx, ty, ts, { source: source, duration: 270, ease: "inOut" });
  }
  function mkBtn(txt, title){ var b = document.createElement("button"); b.className = "node-btn"; b.textContent = txt; b.title = title; return b; }
  function mkIconBtn(svg, title){ var b = mkBtn("", title); b.innerHTML = svg; b.setAttribute("aria-label", title); return b; }
  function copyNodeMarkdown(node){
    var title = node.title || "Untitled";
    var body = (node.md || "").trim();
    var text = "# " + title + (body ? "\n\n" + body : "");
    function done(){ flashHint("Copied “" + title.slice(0, 40) + (title.length > 40 ? "…" : "") + "” as Markdown"); }
    function legacy(){
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch(_err) {}
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done, function(){ legacy(); done(); });
    } else {
      legacy(); done();
    }
  }

  // ---------- per-card follow-up composer ----------
  var SEND_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 12.8V3.6M8 3.6 3.9 7.7M8 3.6l4.1 4.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // The scrollbar only appears once the textarea is actually at its cap —
  // otherwise sub-pixel rounding paints a stray thumb next to the send button.
export function autoGrowEl(ta, max){
    ta.style.height = "auto";
    ta.style.height = Math.min(max, ta.scrollHeight) + "px";
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  }
  function buildCardComposer(node){
    var comp = document.createElement("div"); comp.className = "node-composer";
    var clip = document.createElement("div"); clip.className = "nc-clip";
    var inner = document.createElement("div"); inner.className = "nc-inner";
    var ta = document.createElement("textarea"); ta.rows = 1;
    var send = document.createElement("button"); send.className = "send-btn"; send.title = "Send (↵)"; send.setAttribute("aria-label", "Send follow-up"); send.innerHTML = SEND_ICON;
    var handle = document.createElement("button"); handle.type = "button"; handle.className = "nc-handle"; handle.title = "Ask a follow-up about this document";
    var plus = document.createElement("span"); plus.className = "nc-plus"; plus.textContent = "+";
    handle.appendChild(plus); handle.appendChild(document.createTextNode(" Follow-up"));
    inner.appendChild(ta); inner.appendChild(send); clip.appendChild(inner);
    comp.appendChild(clip); comp.appendChild(handle);
    node.ncComp = comp; node.ncInner = inner; node.ncText = ta; node.ncSend = send;
    handle.addEventListener("click", function(e){ e.stopPropagation(); openCardDrawer(node); });
    ta.addEventListener("input", function(){ autoGrowEl(ta, 90); updateCardComposer(node); });
    ta.addEventListener("keydown", function(e){
      if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); submitCardFollowup(node, "keyboard"); }
      else if (e.key === "Escape"){ e.stopPropagation(); closeCardDrawer(node); ta.blur(); }
    });
    // Click-away with an empty drawer tucks it back in (a draft keeps it out).
    ta.addEventListener("blur", function(){
      if (!ta.value.trim() && !(node.el && node.el.matches(":hover"))) closeCardDrawer(node);
    });
    send.addEventListener("click", function(e){ e.stopPropagation(); submitCardFollowup(node, motionSourceFromEvent(e)); });
    return comp;
  }
  // preventScroll matters: a plain focus() would yank the overflow-hidden
  // viewport around to reveal the textarea, fighting the canvas transform.
  function openCardDrawer(node){
    node.ncComp.classList.add("open");
    node.ncText.focus({ preventScroll: true });
  }
  function closeCardDrawer(node){
    node.ncComp.classList.remove("open");
  }
  // Same honest states as the reader's composer: an away agent doesn't disable
  // asking (questions queue server-side); only a pending doc or a dead session does.
export function updateCardComposer(node){
    if (!node.ncText) return;
    var down = closed || node.status === "pending";
    node.ncText.disabled = down;
    node.ncInner.classList.toggle("disabled", down);
    // A draft in progress keeps the drawer out even when the pointer wanders off.
    node.ncComp.classList.toggle("nc-draft", !!node.ncText.value.trim());
    if (frozen) node.ncText.placeholder = "Read-only snapshot";
    else if (closed) node.ncText.placeholder = "Session ended — saved";
    else if (node.status === "pending") node.ncText.placeholder = "Still being written…";
    else if (connLost || !agentAttached) node.ncText.placeholder = "Asks are saved for the agent…";
    else node.ncText.placeholder = "Ask a follow-up…";
    node.ncSend.disabled = down || !node.ncText.value.trim();
  }
  function submitCardFollowup(node, source){
    if (closed){ flashHint("Session ended — reopen this Rabbithole from your terminal to continue."); return; }
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
  // Asking from a card spawns the answer card wherever placeChild puts it —
  // possibly off-screen. Pan just enough to bring it into view (user-initiated,
  // so moving the viewport is expected; streaming never does this).
export function revealNode(n, source){
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
export function animatePan(tx, ty, source, duration, ease){ animateView(tx, ty, view.scale, { source: source, duration: duration, ease: ease }); }
  // One shared view glide (pan + zoom together): frame-all, reveal, and
  // search/activity jumps. A newer glide cancels an in-flight one; hidden windows jump
  // instantly (rAF never fires there).
  var viewAnimId = 0;
export function animateView(tx, ty, ts, opts){
    opts = opts || {};
    var myId = ++viewAnimId;
    if (document.hidden || shouldReduceMotion() || opts.source !== "pointer"){
      view.x = tx; view.y = ty; view.scale = ts; applyTransform(); return;
    }
    var sx = view.x, sy = view.y, ss = view.scale, t0 = performance.now(), D = opts.duration || 270;
    var easeFn = opts.ease === "inOut" ? easeInOutMotion : easeOutMotion;
    function step(t){
      if (myId !== viewAnimId) return;
      var p = Math.min(1, (t - t0) / D), k = easeFn(p);
      view.x = sx + (tx - sx) * k; view.y = sy + (ty - sy) * k; view.scale = ss + (ts - ss) * k; applyTransform();
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

export function fillBody(node){
    var body = node.bodyEl; if (!body) return;
    body.innerHTML = "";
    if (node.origin && node.origin.synthesis){
      var sq = document.createElement("div"); sq.className = "origin-quote"; sq.textContent = node.origin.synthesis_mode === "question_map" ? "✦ Question Map from selected nodes" : "✦ Synthesis from selected nodes";
      body.appendChild(sq);
    } else if (node.origin && node.origin.selected_text){
      var q = document.createElement("div"); q.className = "origin-quote"; q.textContent = "“" + node.origin.selected_text + "”";
      body.appendChild(q);
    } else if (node.origin && (node.origin.question || node.origin.lens)){
      var fq = document.createElement("div"); fq.className = "origin-quote";
      fq.textContent = node.origin.lens ? "Follow-up — " + lensLabel(node.origin.lens) : node.origin.question;
      body.appendChild(fq);
    }
    var dc = buildDocContent(node, CANVAS_BASE);
    body.appendChild(dc);
    applyChildHighlights(dc, node);
  }
  function setNodeFontScale(node, delta){
    node.font_scale = Math.min(MAX_FS, Math.max(MIN_FS, (node.font_scale || 1) + delta));
    var dc = node.bodyEl && node.bodyEl.querySelector(".doc-content"); if (dc) dc.style.fontSize = fontPx(node, CANVAS_BASE) + "px";
    if (mode === "reader" && currentNodeId === node.id){ var rdc = readerMain.querySelector(".doc-content"); if (rdc) rdc.style.fontSize = fontPx(node, READER_BASE) + "px"; }
    scheduleEdges();
    canvasHooks.persistNode(node);
  }

export function layoutNode(node){
    var el = node.el; el.style.left = node.x + "px"; el.style.top = node.y + "px"; el.style.width = node.w + "px";
    if (!node.collapsed) el.style.height = node.h + "px";
  }

  // Shared pointer-gesture wiring: cleans up on pointerup AND pointercancel/
  // lostpointercapture, so an interrupted gesture (touch cancel, window blur)
  // never leaves move listeners or drag state stuck.
  function onPointerGesture(handle, onDown, onMove, onUp){
    handle.addEventListener("pointerdown", function(e){
      if (!onDown(e)) return;
      try { handle.setPointerCapture(e.pointerId); } catch(_e){}
      function move(ev){ onMove(ev); }
      function done(){
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", done);
        handle.removeEventListener("pointercancel", done);
        handle.removeEventListener("lostpointercapture", done);
        try { handle.releasePointerCapture(e.pointerId); } catch(_e){}
        onUp();
      }
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", done);
      handle.addEventListener("pointercancel", done);
      handle.addEventListener("lostpointercapture", done);
    });
  }
  function enableDrag(node, handle){
    var sx, sy, ox, oy;
    onPointerGesture(handle,
      function(e){ if (e.button !== 0 || e.target.closest(".node-btn")) return false; e.preventDefault(); canvasHooks.hideAsk(); sx=e.clientX; sy=e.clientY; ox=node.x; oy=node.y; return true; },
      function(ev){ node.x = ox + (ev.clientX - sx) / view.scale; node.y = oy + (ev.clientY - sy) / view.scale; layoutNode(node); scheduleEdges(); },
      function(){ drawEdges(); canvasHooks.persistNode(node); });
  }
  function enableResize(node, handle){
    var sx, sy, ow, oh;
    onPointerGesture(handle,
      function(e){ if (e.button !== 0) return false; e.preventDefault(); e.stopPropagation(); sx=e.clientX; sy=e.clientY; ow=node.w; oh=node.h; return true; },
      function(ev){ node.w = Math.max(240, ow + (ev.clientX - sx)/view.scale); node.h = Math.max(160, oh + (ev.clientY - sy)/view.scale); layoutNode(node); scheduleEdges(); },
      function(){ drawEdges(); canvasHooks.persistNode(node); });
  }
export function toggleCollapse(node, btn){
    node.collapsed = !node.collapsed;
    node.el.classList.toggle("collapsed", node.collapsed);
    btn.innerHTML = NODE_COLLAPSE_ICON;
    if (!node.collapsed) layoutNode(node);
    renderVisibility(); drawEdges(); canvasHooks.persistNode(node);
  }
export function renderVisibility(){
    for (var id in nodes){ var n = nodes[id]; if (!n.el) continue; if (n.id === rootId){ n.el.style.display = ""; continue; } n.el.style.display = isVisible(n) ? "" : "none"; }
  }
var edgeRaf = 0;           // coalesces edge redraws during drag/resize/scroll
export function scheduleEdges(){
    if (edgeRaf) return;
    edgeRaf = requestAnimationFrame(function(){ edgeRaf = 0; drawEdges(); });
  }

  // Effective on-canvas height: a collapsed card is its head only.
export function effH(n){ return (n.collapsed && n.el) ? (n.el.offsetHeight || 36) : n.h; }
function clamp(lo, hi, v){ return Math.max(lo, Math.min(hi, v)); }

  // Which side the edge leaves the parent from and enters the child on — chosen
  // by where the child actually sits, so a card dragged left of (or above) its
  // parent gets a sensibly routed arrow instead of one that always exits right.
  function edgeSides(p, n){
    var ph = effH(p), nh = effH(n);
    var dx = (n.x + n.w / 2) - (p.x + p.w / 2);
    var dy = (n.y + nh / 2) - (p.y + ph / 2);
    var fx = dx / ((p.w + n.w) / 2 + 1);
    var fy = dy / ((ph + nh) / 2 + 1);
    if (Math.abs(fx) >= Math.abs(fy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
    return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
  }

  // Where an edge leaves its parent: at the inline mark of the exact text the
  // branch was asked from (clamped to the card's visible body while scrolled) —
  // the mark's y for side exits, its x for top/bottom exits — at the composer
  // for follow-ups, or at the side's midpoint as a fallback.
  function edgeStart(p, child, side){
    var ph = effH(p), ax = null, ay = null, anchored = false;
    if (!p.collapsed && p.el && p.bodyEl){
      var mark = p.bodyEl.querySelector('mark[data-child="' + child.id + '"]');
      if (mark){
        var mr = mark.getBoundingClientRect();
        if (mr.height > 0){
          var er = p.el.getBoundingClientRect();
          var br = p.bodyEl.getBoundingClientRect();
          ay = p.y + clamp((br.top - er.top) / view.scale + 10, (br.bottom - er.top) / view.scale - 10,
                           (mr.top + mr.height / 2 - er.top) / view.scale);
          ax = p.x + clamp((br.left - er.left) / view.scale + 10, (br.right - er.left) / view.scale - 10,
                           (mr.left + mr.width / 2 - er.left) / view.scale);
          anchored = true;
        }
      } else if (isFollowup(child)){
        ay = p.y + ph - 22;
      }
    }
    if (side === "right")  return { x: p.x + p.w, y: ay != null ? ay : p.y + ph / 2, anchored: anchored };
    if (side === "left")   return { x: p.x,       y: ay != null ? ay : p.y + ph / 2, anchored: anchored };
    if (side === "bottom") return { x: ax != null ? ax : p.x + p.w / 2, y: p.y + ph, anchored: anchored };
    return { x: ax != null ? ax : p.x + p.w / 2, y: p.y, anchored: anchored };
  }
  function edgeEnd(n, side){
    var nh = effH(n);
    if (side === "left")  return { x: n.x,           y: n.y + nh / 2 };
    if (side === "right") return { x: n.x + n.w,     y: n.y + nh / 2 };
    if (side === "top")   return { x: n.x + n.w / 2, y: n.y };
    return { x: n.x + n.w / 2, y: n.y + nh };
  }
  function ctrlPt(pt, side, d){
    if (side === "right")  return (pt.x + d) + " " + pt.y;
    if (side === "left")   return (pt.x - d) + " " + pt.y;
    if (side === "bottom") return pt.x + " " + (pt.y + d);
    return pt.x + " " + (pt.y - d);
  }

  var edgeEls = {};
  var edgeGeometry = {};
  function ensureEdgeEls(edgeId, childId, className){
    var els = edgeEls[edgeId];
    if (els) return els;
    var path = document.createElementNS(SVGNS, "path");
    path.setAttribute("data-child", childId);
    if (className) path.classList.add(className);
    var dot = document.createElementNS(SVGNS, "circle");
    dot.setAttribute("r", "3");
    dot.setAttribute("data-child", childId);
    if (className) dot.classList.add(className);
    edgesSvg.appendChild(path);
    edgesSvg.appendChild(dot);
    edgeEls[edgeId] = [path, dot];
    return edgeEls[edgeId];
  }
  function removeEdge(edgeId){
    var els = edgeEls[edgeId];
    if (els){
      for (var i = 0; i < els.length; i++) if (els[i].parentNode) els[i].parentNode.removeChild(els[i]);
    }
    delete edgeEls[edgeId];
    delete edgeGeometry[edgeId];
    delete edgeHl[edgeId];
  }
  function applyEdgeClasses(childId, path, dot, anchored){
    path.classList.toggle("edge-hl", !!edgeHl[childId]);
    dot.classList.toggle("edge-hl", !!edgeHl[childId]);
    dot.classList.toggle("anchored", !!anchored);
  }
export function rebuildEdges(){
    while (edgesSvg.firstChild) edgesSvg.removeChild(edgesSvg.firstChild);
    edgeEls = {};
    edgeGeometry = {};
    drawEdges();
  }
export function drawEdges(){
    var live = {};
    var visCache = {};
    function vis(node){ var k = node.id; if (k in visCache) return visCache[k]; return (visCache[k] = isVisible(node)); }
    for (var id in nodes){
      var n = nodes[id]; if (!n.parent_id || !n.el) continue; var p = nodes[n.parent_id]; if (!p || !p.el) continue;
      if (!vis(n) || !vis(p)) continue;
      live[n.id] = true;
      var sides = edgeSides(p, n);
      var start = edgeStart(p, n, sides[0]);
      var end = edgeEnd(n, sides[1]);
      var horiz = sides[0] === "left" || sides[0] === "right";
      var reach = Math.max(40, (horiz ? Math.abs(end.x - start.x) : Math.abs(end.y - start.y)) / 2);
      var d = "M " + start.x + " " + start.y + " C " + ctrlPt(start, sides[0], reach) + " " + ctrlPt(end, sides[1], reach) + " " + end.x + " " + end.y;
      var geom = {
        d: d,
        cx: String(start.x),
        cy: String(start.y),
        anchored: !!start.anchored
      };
      var els = ensureEdgeEls(n.id, n.id, "");
      var path = els[0], dot = els[1], prev = edgeGeometry[n.id];
      if (!prev || prev.d !== geom.d) path.setAttribute("d", geom.d);
      if (!prev || prev.cx !== geom.cx) dot.setAttribute("cx", geom.cx);
      if (!prev || prev.cy !== geom.cy) dot.setAttribute("cy", geom.cy);
      if (!prev || prev.anchored !== geom.anchored) applyEdgeClasses(n.id, path, dot, geom.anchored);
      else if (!!edgeHl[n.id] !== path.classList.contains("edge-hl")) applyEdgeClasses(n.id, path, dot, geom.anchored);
      edgeGeometry[n.id] = geom;
      var sources = (n.origin && n.origin.synthesis_sources) || [];
      for (var si = 0; si < sources.length; si++){
        var sourceId = sources[si];
        if (sourceId === n.parent_id) continue;
        var sp = nodes[sourceId];
        if (!sp || !sp.el || !vis(sp)) continue;
        var edgeId = sourceId + "->" + n.id;
        live[edgeId] = true;
        var ssides = edgeSides(sp, n);
        var sstart = edgeStart(sp, n, ssides[0]);
        var send = edgeEnd(n, ssides[1]);
        var shoriz = ssides[0] === "left" || ssides[0] === "right";
        var sreach = Math.max(40, (shoriz ? Math.abs(send.x - sstart.x) : Math.abs(send.y - sstart.y)) / 2);
        var sd = "M " + sstart.x + " " + sstart.y + " C " + ctrlPt(sstart, ssides[0], sreach) + " " + ctrlPt(send, ssides[1], sreach) + " " + send.x + " " + send.y;
        var sgeom = { d: sd, cx: String(sstart.x), cy: String(sstart.y), anchored: false };
        var sels = ensureEdgeEls(edgeId, n.id, "source-edge");
        var spath = sels[0], sdot = sels[1], sprev = edgeGeometry[edgeId];
        if (!sprev || sprev.d !== sgeom.d) spath.setAttribute("d", sgeom.d);
        if (!sprev || sprev.cx !== sgeom.cx) sdot.setAttribute("cx", sgeom.cx);
        if (!sprev || sprev.cy !== sgeom.cy) sdot.setAttribute("cy", sgeom.cy);
        edgeGeometry[edgeId] = sgeom;
      }
    }
    for (var edgeId in edgeEls){
      if (!live[edgeId]) removeEdge(edgeId);
    }
  }
  // Highlight state lives here, not just on the elements — edges can be removed
  // and recreated when visibility changes, so hover state needs a stable source.
  var edgeHl = {};
export function setEdgeHighlight(childId, on){
    if (on) edgeHl[childId] = true; else delete edgeHl[childId];
    var els = edgeEls[childId];
    if (!els) return;
    for (var i = 0; i < els.length; i++) els[i].classList.toggle("edge-hl", on);
  }
export function clearEdgeHighlight(childId){
    delete edgeHl[childId];
  }
export function focusOrigin(node, on){
    if (mode !== "canvas") return;
    setEdgeHighlight(node.id, on);
    var p = node.parent_id ? nodes[node.parent_id] : null;
    if (p && p.bodyEl){
      var marks = p.bodyEl.querySelectorAll('mark[data-child="' + node.id + '"]');
      for (var i = 0; i < marks.length; i++) marks[i].classList.toggle("mark-focus", on);
    }
  }
  // Hovering the highlighted text lights up the edge to the branch it spawned.
  function onWorldMouseOver(e){
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (m) setEdgeHighlight(m.dataset.child, true);
  }
  function onWorldMouseOut(e){
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (m) setEdgeHighlight(m.dataset.child, false);
  }

  function initViewportPan(){
    var sx, sy, ox, oy;
    onPointerGesture(viewport,
      function(e){ if (e.button !== 0 || e.target.closest(".node")) return false; canvasHooks.hideAsk(); viewAnimId++; viewport.classList.add("panning"); sx=e.clientX; sy=e.clientY; ox=view.x; oy=view.y; return true; },
      function(ev){ view.x = ox + (ev.clientX - sx); view.y = oy + (ev.clientY - sy); applyTransform(); },
      function(){ viewport.classList.remove("panning"); });
  }

  // Can this element still scroll in the direction of the wheel delta?
  function canScroll(el, dx, dy){
    if (dx && el.scrollWidth > el.clientWidth + 1){
      if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
    }
    if (dy && el.scrollHeight > el.clientHeight + 1){
      if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
    }
    return false;
  }
  // A trackpad swipe is one gesture and keeps the target it STARTED on: a pan
  // begun on the background stays a pan while the cursor crosses cards, and a
  // scroll begun inside a card keeps scrolling that card — never the canvas —
  // even if the cursor drifts off it. A pause in wheel events ends the gesture.
  var wheelKind = null, wheelCard = null, wheelTs = 0;
  function onViewportWheel(e){
    if (e.ctrlKey){ e.preventDefault(); wheelKind = null; zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01)); return; }
    if (!wheelKind || e.timeStamp - wheelTs > 180){
      wheelCard = (e.target.closest && e.target.closest(".node")) || null;
      wheelKind = wheelCard ? "card" : "pan";
    }
    wheelTs = e.timeStamp;
    if (wheelKind === "pan"){
      e.preventDefault(); viewAnimId++; view.x -= e.deltaX; view.y -= e.deltaY; applyTransform();
      return;
    }
    var over = (e.target.closest && e.target.closest(".node")) || null;
    if (over !== wheelCard){
      // Drifted off the origin card mid-scroll: keep moving ITS content by hand.
      e.preventDefault();
      var nb = wheelCard ? wheelCard.querySelector(".node-body") : null;
      if (nb){ nb.scrollLeft += e.deltaX; nb.scrollTop += e.deltaY; }
      return;
    }
    // Still over the origin card: allow the browser to scroll the innermost thing
    // that can still move (body, a code block, a wide table); if nothing can,
    // swallow the event so the canvas doesn't lurch mid-read.
    var el = e.target, consumable = false;
    while (el && el.nodeType === 1){
      if (canScroll(el, e.deltaX, e.deltaY)){ consumable = true; break; }
      if (el === over) break;
      el = el.parentNode;
    }
    if (!consumable) e.preventDefault();
  }

export function frameAll(animate, source){
    var ids = Object.keys(nodes).filter(function(id){ return isVisible(nodes[id]); });
    if (!ids.length) return;
    var minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    ids.forEach(function(id){ var n=nodes[id]; minX=Math.min(minX,n.x); minY=Math.min(minY,n.y); maxX=Math.max(maxX,n.x+n.w); maxY=Math.max(maxY,n.y+(n.collapsed?40:n.h)); });
    var vw=viewport.clientWidth||window.innerWidth, vh=viewport.clientHeight||window.innerHeight, pad=100;
    var ts = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min((vw-pad)/(maxX-minX), (vh-pad)/(maxY-minY), 1.2)));
    var tx = vw/2 - (minX+(maxX-minX)/2)*ts, ty = vh/2 - (minY+(maxY-minY)/2)*ts;
    if (animate){ animateView(tx, ty, ts, { source: source, duration: 270, ease: "inOut" }); return; }
    view.scale = ts; view.x = tx; view.y = ty; applyTransform();
  }
  // Double-clicking empty canvas = frame everything (canvas-tool muscle memory).
  function onViewportDblClick(e){
    if (e.target.closest && e.target.closest(".node")) return;
    frameAll(true, motionSourceFromEvent(e));
  }

export function tidy(source){
    var visited={};
    function moveSubtree(node, dx, dy){
      node.x += dx; node.y += dy;
      childrenOf(node.id).filter(function(k){ return visited[k.id]; }).sort(nodeOrder).forEach(function(k){ moveSubtree(k, dx, dy); });
    }
    function place(node, x, y){
      visited[node.id] = true;
      node.x = x; node.y = y;
      var bounds = nodeBounds(node);
      if (node.collapsed) return bounds;

      var kids = childrenOf(node.id).sort(nodeOrder);
      var selectionKids = kids.filter(isSelectionBranch);
      var followupKids = kids.filter(isFollowup);
      var sideBounds = null;
      var sideX = node.x + node.w + TREE_PARENT_GAP;
      var sideY = node.y;
      selectionKids.forEach(function(k){
        var kb = place(k, sideX, sideY);
        sideBounds = unionBounds(sideBounds, kb);
        bounds = unionBounds(bounds, kb);
        sideY = kb.maxY + TREE_STACK_GAP;
      });

      var belowY = node.y + effH(node) + TREE_PARENT_GAP;
      followupKids.forEach(function(k){
        var kb = place(k, node.x, belowY);
        if (boundsOverlap(kb, sideBounds)){
          var dy = sideBounds.maxY + TREE_STACK_GAP - kb.minY;
          moveSubtree(k, 0, dy);
          kb = shiftBounds(kb, 0, dy);
        }
        bounds = unionBounds(bounds, kb);
        belowY = kb.maxY + TREE_STACK_GAP;
      });
      return bounds;
    }
    var root = nodes[rootId]; if (!root) return; place(root, 0, 0);
    // Only nodes actually visited (the visible tree) are laid out — hidden
    // descendants of a collapsed node keep their positions instead of being
    // yanked around by a stale traversal.
    var ids = Object.keys(visited);
    var moved = [];
    ids.forEach(function(id){ var nn=nodes[id]; layoutNode(nn); moved.push(nn); });
    canvasHooks.persistNodesBulk(moved);
    rebuildEdges(); frameAll(true, source);
  }

  // Canvas cards (DOM + rendered markdown for every node) are only built the first
  // time the user actually opens the canvas — Reader is the default, so a large
  // hole pays no canvas cost until/unless it's wanted.
export function ensureCanvasBuilt(){
    if (canvasBuilt) return;
    setCanvasBuilt(true);
    Object.keys(nodes).forEach(function(id){ if (!nodes[id].el) createNodeEl(nodes[id]); });
    renderVisibility();
    applyTransform();
  }
export function setMode(m){
    if (m === "canvas" && mode === "reader"){
      // display:none resets the reader's scrollTop — remember it first so
      // toggling out to the canvas and back lands exactly where you were.
      var cur = nodes[currentNodeId];
      if (cur) cur._scrollTop = readerMain.scrollTop;
    }
    setModeValue(m);
    if (m === "canvas"){
      ensureCanvasBuilt();
      canvasHooks.hidePeek();
      document.body.classList.add("mode-canvas");
      requestAnimationFrame(function(){
        rebuildEdges();
        // Frame everything only the first time; afterwards the canvas keeps the
        // pan/zoom you left it at.
        if (!canvasFramed){ setCanvasFramed(true); frameAll(); }
      });
      canvasHooks.scheduleViewSave();
    }
    else { openNode(currentNodeId); }
  }
