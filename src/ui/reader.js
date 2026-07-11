import {
  CANVAS_BASE,
  MAX_FS,
  MIN_FS,
  READER_BASE,
  anchorStart,
  breadcrumbEl,
  buildDocContent,
  buildLoading,
  childrenOf,
  closed,
  connLost,
  currentNodeId,
  followupsOf,
  fontPx,
  frozen,
  agentAttached,
  isFollowup,
  isUnread,
  lensBadgeHtml,
  lineageNodes,
  markRead,
  mode,
  motionSourceFromEvent,
  nodes,
  playLandingCue,
  readerMain,
  setCurrentNodeId,
  setModeValue,
  sideEl,
  toggleTheme,
  truncate,
  world
} from "./core.js";
import { escapeHtml } from "../core/utils.js";
import { createCleanupScope } from "./lifecycle.js";

function defaultReaderHooks(){
  return {
    hideAsk: function(){},
    hidePeek: function(){},
    updateComposerState: function(){},
    scheduleViewSave: function(){},
    setMode: function(){},
    post: function(){ return Promise.resolve({ ok: true }); },
    mountVisuals: null,
    mountDocImages: null,
    persistNode: function(){},
    animateScroll: function(){}
  };
}

var readerHooks = defaultReaderHooks();
var readerScope = null;

export function registerReaderHooks(hooks) {
  Object.assign(readerHooks, hooks || {});
}

var breadcrumbNodes = {};
var sidebarNodes = {};

  // ===========================================================================
  // READER
  // ===========================================================================
export function openNode(id){
    if (!nodes[id]) return;
    // Snapshot the outgoing document's position (belt & braces alongside the
    // scroll listener) so every window keeps its place when you come back.
    // Only while the reader is actually visible — hidden (canvas mode) it
    // reads 0 and would clobber the position saved on the way out.
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

export function renderBreadcrumb(){
    var path = lineageNodes(currentNodeId);
    var fragment = document.createDocumentFragment();
    path.forEach(function(n, i){
      var crumb = breadcrumbNodes[n.id];
      if (!crumb){
        crumb = document.createElement("span");
        crumb.className = "crumb";
        crumb.dataset.id = n.id;
        crumb._sep = document.createElement("span");
        crumb._sep.className = "crumb-sep";
        crumb._sep.textContent = "›";
        breadcrumbNodes[n.id] = crumb;
      }
      var cur = i === path.length - 1;
      crumb.textContent = n.title || "Untitled";
      crumb.classList.toggle("current", cur);
      if (cur){
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
export function initReader(){
    disposeReaderResources(false);
    readerScope = createCleanupScope();
    try {
    readerScope.listen(breadcrumbEl, "click", function(e){
      var c = e.target.closest(".crumb");
      if (!c || c.classList.contains("current")) return;
      openNode(c.dataset.id);
    });
    readerScope.listen(breadcrumbEl, "keydown", function(e){
      if (e.key !== "Enter") return;
      var c = e.target.closest && e.target.closest('.crumb[role="link"]');
      if (!c) return;
      e.preventDefault();
      openNode(c.dataset.id);
    });
    readerScope.listen(readerMain, "scroll", onReaderScroll, { passive: true });
    readerScope.listen(readerMain, "click", onMarkClick);
    readerScope.listen(world, "click", onMarkClick);
    readerScope.listen(readerMain, "keydown", onMarkKeydown);
    readerScope.listen(world, "keydown", onMarkKeydown);
    readerScope.listen(sideEl, "click", onSidebarClick);
    readerScope.listen(sideEl, "keydown", onSidebarKeydown);
    readerScope.listen(document.getElementById("r-textdown"), "click", function(){ setReaderFontScale(-0.1); });
    readerScope.listen(document.getElementById("r-textup"), "click", function(){ setReaderFontScale(0.1); });
    readerScope.listen(document.getElementById("r-canvas"), "click", function(){ readerHooks.setMode("canvas"); });
    readerScope.listen(document.getElementById("r-done"), "click", function(){ if (!closed) readerHooks.post({ type: "done" }); });
    readerScope.listen(document.getElementById("r-theme"), "click", toggleTheme);
    readerScope.listen(document.getElementById("t-theme"), "click", toggleTheme);
    return disposeReader;
    } catch (error) {
      disposeReader();
      throw error;
    }
  }

export function disposeReader(){
    disposeReaderResources(true);
  }

function disposeReaderResources(resetHooks){
    var scope = readerScope;
    readerScope = null;
    if (scope) scope.dispose();
    breadcrumbNodes = {};
    sidebarNodes = {};
    kbdMarkIdx = -1;
    if (resetHooks) readerHooks = defaultReaderHooks();
  }

export function renderReaderBody(){
    var node = nodes[currentNodeId];
    readerMain.innerHTML = "";
    var col = document.createElement("div");
    col.className = "reader-col";
    if (node.origin && (node.origin.selected_text || node.origin.question)){
      var ctx = document.createElement("div");
      ctx.className = "reader-context";
      if (node.origin.synthesis){
        ctx.innerHTML = '<span class="rc-label">Synthesis</span>The journey so far, distilled';
      } else if (node.origin.selected_text){
        var tail = node.origin.lens ? " — " + lensBadgeHtml(node.origin.lens)
          : (node.origin.question ? " — " + escapeHtml(node.origin.question) : "");
        ctx.innerHTML = '<span class="rc-label">From</span>“' + escapeHtml(truncate(node.origin.selected_text, 200)) + '”' + tail + '<span class="rc-go">→</span>';
      } else {
        ctx.innerHTML = '<span class="rc-label">Follow-up</span>' +
          (node.origin.lens ? lensBadgeHtml(node.origin.lens) : escapeHtml(node.origin.question || ""));
      }
      // The strip is a live link: click it to land on the exact spot in the
      // parent this branch grew from (flashed so the eye finds it).
      if (node.parent_id && nodes[node.parent_id] && !node.origin.synthesis){
        ctx.classList.add("linked");
        ctx.title = "See this in its original context";
        ctx.setAttribute("role", "link");
        ctx.tabIndex = 0;
        ctx.setAttribute("aria-label", "See this in its original context");
        ctx.addEventListener("click", function(e){ jumpToOrigin(node, motionSourceFromEvent(e)); });
        ctx.addEventListener("keydown", function(e){
          if (e.key !== "Enter") return;
          e.preventDefault();
          jumpToOrigin(node, "keyboard");
        });
      }
      col.appendChild(ctx);
    }
    var dc = buildDocContent(node, READER_BASE);
    col.appendChild(dc);
    applyChildHighlights(dc, node);
    var fups = followupsOf(node.id);
    if (fups.length){
      var thread = document.createElement("div");
      thread.id = "thread";
      thread.appendChild(buildThreadRule());
      fups.forEach(function(k){ thread.appendChild(buildThreadItem(k)); });
      col.appendChild(thread);
      // Rendering the thread IS reading it — answered follow-ups shed their dots.
      fups.forEach(function(k){ if (k.status === "answered") markRead(k); });
    }
    readerMain.appendChild(col);
    // Each document remembers where you were; a first open starts at the top.
    readerMain.scrollTop = node._scrollTop || 0;
  }
  // Open the parent and land on the exact origin: the inline mark for a
  // selection branch, the thread turn for a follow-up.
export function jumpToOrigin(node, source){
    var parent = nodes[node.parent_id];
    if (!parent) return;
    openNode(parent.id);
    var target = readerMain.querySelector('mark[data-child="' + node.id + '"]') ||
                 readerMain.querySelector('[data-turn="' + node.id + '"]');
    if (!target) return;
    var top = target.getBoundingClientRect().top - readerMain.getBoundingClientRect().top + readerMain.scrollTop;
    readerHooks.animateScroll(readerMain, Math.max(0, top - readerMain.clientHeight * 0.38), source);
    if (target.tagName === "MARK"){
      var marks = readerMain.querySelectorAll('mark[data-child="' + node.id + '"]');
      for (var i = 0; i < marks.length; i++) playLandingCue(marks[i], "mark-flash");
    }
  }
  function onReaderScroll(){
    var n = nodes[currentNodeId];
    if (n) n._scrollTop = readerMain.scrollTop;
    readerHooks.hidePeek();
    readerHooks.scheduleViewSave();
  }

  // ---------- follow-up thread ----------
export function buildThreadRule(){
    var r = document.createElement("div");
    r.className = "thread-rule";
    r.textContent = "Conversation";
    return r;
  }
export function buildThreadItem(k){
    var item = document.createElement("div");
    item.className = "turn";
    item.dataset.turn = k.id;
    var q = document.createElement("div");
    q.className = "turn-q";
    var qs = document.createElement("span");
    if (k.origin && k.origin.lens) qs.innerHTML = lensBadgeHtml(k.origin.lens);
    else qs.textContent = (k.origin && k.origin.question) || "";
    q.appendChild(qs);
    var a = document.createElement("div");
    a.className = "turn-a";
    fillTurnAnswer(a, k);
    item.appendChild(q);
    item.appendChild(a);
    return item;
  }
export function fillTurnAnswer(a, k){
    a.innerHTML = "";
    if (k.status === "pending" && !k.html){
      a.appendChild(buildLoading(k));
      return;
    }
    var dc = buildDocContent(k, READER_BASE);
    // Thread answers are part of this window: they follow the parent's text zoom.
    var host = nodes[currentNodeId];
    if (host) dc.style.fontSize = fontPx(host, READER_BASE) + "px";
    a.appendChild(dc);
    // Marks only make sense on settled text — a streaming turn gets them when
    // node_answered lands and the turn re-renders.
    if (k.status === "answered") applyChildHighlights(dc, k);
  }
export function ensureThread(){
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
export function updateThreadItem(k){
    var item = readerMain.querySelector('[data-turn="' + k.id + '"]');
    if (!item){
      var t = ensureThread();
      if (t) t.appendChild(buildThreadItem(k));
      return;
    }
    fillTurnAnswer(item.querySelector(".turn-a"), k);
  }
export function removeThreadItem(childId){
    var item = readerMain.querySelector('[data-turn="' + childId + '"]');
    if (item && item.parentNode) item.parentNode.removeChild(item);
    var t = readerMain.querySelector("#thread");
    if (t && !t.querySelector(".turn")) t.parentNode.removeChild(t);
  }

export function applyChildHighlights(dc, node){
    var kids = childrenOf(node.id).filter(function(k){ return k.origin && k.origin.anchor; });
    kids.sort(function(a,b){ return b.origin.anchor.offset_start - a.origin.anchor.offset_start; }); // apply end→start
    kids.forEach(function(k){
      var a = k.origin.anchor;
      var r = rangeFromOffsets(dc, a.offset_start, a.offset_end);
      if (!r) return;
      wrapRange(r, k.id, "hl " + (k.status === "answered" ? "mark-ready" : "mark-pending"));
    });
  }

  // Wrap one selection (by offsets, always text-node endpoints) inside a container.
export function wrapInContainer(dc, anchor, childId, cls){
    if (!dc || !anchor) return;
    var rr = rangeFromOffsets(dc, anchor.offset_start, anchor.offset_end);
    if (rr){ try { wrapRange(rr, childId, cls); } catch(e){} }
  }
  // Promote a child's pending marks to ready within a container.
export function upgradeMarks(root, childId){
    if (!root) return;
    var marks = root.querySelectorAll('mark[data-child="' + childId + '"]');
    var child = nodes[childId], label = "Open branch: " + ((child && child.title) || "Untitled");
    for (var i = 0; i < marks.length; i++){
      marks[i].classList.remove("mark-pending"); marks[i].classList.add("mark-ready");
      marks[i].setAttribute("aria-label", label);
    }
  }
  // Unwrap a child's marks (used to roll back a failed ask) so offsets stay valid.
export function removeMarks(root, childId){
    if (!root) return;
    var marks = root.querySelectorAll('mark[data-child="' + childId + '"]');
    for (var i = 0; i < marks.length; i++){
      var m = marks[i], p = m.parentNode; if (!p) continue;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m); p.normalize();
    }
  }
  function onMarkClick(e){
    var m = e.target.closest("mark[data-child]");
    if (!m) return;
    if (!window.getSelection().isCollapsed) return; // user was selecting, not clicking
    var k = nodes[m.dataset.child];
    // Pending branches open too — the reader shows the answer streaming in live.
    if (k) openNode(k.id);
  }
  function onMarkKeydown(e){
    if (e.key !== "Enter") return;
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (!m) return;
    var k = nodes[m.dataset.child];
    if (!k) return;
    e.preventDefault();
    openNode(k.id);
  }
export function renderSidebar(){
    var kids = childrenOf(currentNodeId).filter(function(k){ return !isFollowup(k); }).sort(function(a,b){
      return (anchorStart(a) - anchorStart(b)) || ((a._order||0) - (b._order||0));
    });
    if (!kids.length){
      var emptyHeading = document.createElement("h3");
      emptyHeading.textContent = "Branches";
      var empty = document.createElement("div");
      empty.className = "side-empty";
      empty.textContent = "Select any text in the document and ask about it — the answer opens as a branch here. Or ask a follow-up in the box below the document.";
      sideEl.replaceChildren(emptyHeading, empty);
      return;
    }
    var heading = sideEl.querySelector(":scope > h3");
    if (!heading) heading = document.createElement("h3");
    heading.textContent = "Branches (" + kids.length + ")";
    var fragment = document.createDocumentFragment();
    fragment.appendChild(heading);
    var newLivePanes = [];
    kids.forEach(function(k, i){
      var pending = k.status !== "answered";
      var qHtml = (k.origin && k.origin.synthesis) ? '<span class="lens-badge">✦ Synthesis</span>'
        : (k.origin && k.origin.lens) ? lensBadgeHtml(k.origin.lens)
        : escapeHtml((k.origin && k.origin.question) ? k.origin.question : (k.title || "Untitled"));
      var quote = (k.origin && k.origin.selected_text) ? k.origin.selected_text : "";
      var status = pending ? pendingStatusHtml(k)
        : isUnread(k) ? '<span class="si-new">new — open →</span>'
        : 'open →';
      var tile = sidebarNodes[k.id];
      if (!tile){
        tile = document.createElement("div");
        tile.className = "side-item";
        tile.dataset.child = k.id;
        tile.setAttribute("role", "link");
        tile.tabIndex = 0;
        tile._question = document.createElement("div"); tile._question.className = "si-q";
        tile._num = document.createElement("span"); tile._num.className = "si-num";
        tile._questionText = document.createElement("span");
        tile._question.append(tile._num, tile._questionText);
        tile._quote = document.createElement("div"); tile._quote.className = "si-quote";
        tile._status = document.createElement("div"); tile._status.className = "si-status";
        tile.append(tile._question, tile._quote, tile._status);
        sidebarNodes[k.id] = tile;
      }
      tile.classList.toggle("pending", pending);
      tile._num.textContent = i + 1;
      tile._questionText.innerHTML = qHtml;
      tile._quote.textContent = quote ? "“" + truncate(quote, 80) + "”" : "";
      tile._quote.hidden = !quote;
      tile._status.innerHTML = status;
      var name = (k.origin && k.origin.synthesis) ? "Synthesis"
        : ((k.origin && k.origin.question) || k.title || "Untitled");
      tile.setAttribute("aria-label", "Open branch: " + name + (pending ? ", pending" : isUnread(k) ? ", new" : ""));
      // A streaming answer is watchable right here: its last lines render live
      // inside the tile (and the whole tile opens the full streaming view).
      if (pending && k.html){
        if (!tile._live){
          tile._live = document.createElement("div"); tile._live.className = "si-live";
          tile._livePane = document.createElement("div"); tile._livePane.className = "md";
          tile._live.appendChild(tile._livePane);
          tile.appendChild(tile._live);
          newLivePanes.push({ pane: tile._livePane, node: k });
        }
        tile._livePane.innerHTML = k.html;
      } else if (tile._live){
        tile._live.remove();
        tile._live = null;
        tile._livePane = null;
      }
      fragment.appendChild(tile);
    });
    sideEl.replaceChildren(fragment);
    mountSidebarVisuals(newLivePanes);
  }
export function mountSidebarVisuals(panes){
    if (typeof readerHooks.mountVisuals !== "function") return;
    for (var i = 0; i < panes.length; i++){
      var key = "reader-side:" + panes[i].node.id;
      readerHooks.mountVisuals(panes[i].pane, key);
      if (typeof readerHooks.mountDocImages === "function") readerHooks.mountDocImages(panes[i].pane, panes[i].node, null, key);
    }
  }
export function pendingStatusHtml(k){
    if (frozen) return '<span class="si-muted">unanswered in this snapshot</span>';
    if (closed) return '<span class="si-muted">saved — answered when you reopen</span>';
    if (connLost || !agentAttached) return '<span class="si-muted">saved — waiting for the agent</span>';
    if (k && k.html) return '<span class="shimmer-text">Writing…</span>';
    return '<span class="shimmer-text">Thinking…</span>';
  }
  function onSidebarClick(e){
    var it = e.target.closest(".side-item");
    if (!it) return;
    openNode(it.dataset.child); // pending items open too — the answer streams there
  }
  function onSidebarKeydown(e){
    if (e.key !== "Enter") return;
    var it = e.target.closest && e.target.closest('.side-item[role="link"]');
    if (!it) return;
    e.preventDefault();
    openNode(it.dataset.child);
  }

export function setReaderFontScale(delta){
    var node = nodes[currentNodeId];
    node.font_scale = Math.min(MAX_FS, Math.max(MIN_FS, (node.font_scale || 1) + delta));
    var dcs = readerMain.querySelectorAll(".doc-content");
    for (var i = 0; i < dcs.length; i++) dcs[i].style.fontSize = fontPx(node, READER_BASE) + "px";
    if (node.bodyEl){ var cdc = node.bodyEl.querySelector(".doc-content"); if (cdc) cdc.style.fontSize = fontPx(node, CANVAS_BASE) + "px"; }
    readerHooks.persistNode(node);
  }

  // ---------- offset <-> range highlighting ----------
export function rangeFromOffsets(container, startOff, endOff){
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    var pos = 0, sN, sO, eN, eO;
    while (walker.nextNode()){
      var node = walker.currentNode, L = node.textContent.length;
      if (sN == null && pos + L > startOff){ sN = node; sO = startOff - pos; }
      if (pos + L >= endOff){ eN = node; eO = endOff - pos; break; }
      pos += L;
    }
    if (sN == null || eN == null) return null;
    var r = document.createRange();
    try { r.setStart(sN, sO); r.setEnd(eN, eO); } catch(e){ return null; }
    return r;
  }
export function charOffset(container, node, offset){
    var r = document.createRange();
    r.selectNodeContents(container);
    try { r.setEnd(node, offset); } catch(e){ return 0; }
    return r.toString().length;
  }
export function wrapTextNode(textNode, childId, cls){
    var m = document.createElement("mark");
    m.className = cls; m.dataset.child = childId;
    m.tabIndex = 0; m.setAttribute("role", "link");
    var child = nodes[childId];
    m.setAttribute("aria-label", "Open branch: " + ((child && child.title) || "Untitled"));
    textNode.parentNode.insertBefore(m, textNode);
    m.appendChild(textNode);
  }
export function wrapRange(range, childId, cls){
    var startC = range.startContainer, endC = range.endContainer, startO = range.startOffset, endO = range.endOffset;
    if (startC === endC && startC.nodeType === 3){
      if (startO === endO) return;
      var mid = startC.splitText(startO); mid.splitText(endO - startO);
      wrapTextNode(mid, childId, cls); return;
    }
    var ancestor = range.commonAncestorContainer; if (ancestor.nodeType === 3) ancestor = ancestor.parentNode;
    var walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT);
    var collected = [], inRange = false;
    while (walker.nextNode()){
      var n = walker.currentNode;
      if (n === startC){ inRange = true; var info = { node:n, start:startO, end:n.textContent.length }; if (n === endC){ info.end = endO; collected.push(info); break; } collected.push(info); continue; }
      if (n === endC){ collected.push({ node:n, start:0, end:endO }); break; }
      if (inRange) collected.push({ node:n, start:0, end:n.textContent.length });
    }
    for (var i = collected.length - 1; i >= 0; i--){
      var c = collected[i], node = c.node, s = c.start, e = c.end, L = node.textContent.length;
      if (s >= e || !L) continue;
      var t = s > 0 ? node.splitText(s) : node;
      if (e < L) t.splitText(e - s);
      wrapTextNode(t, childId, cls);
    }
  }

  // j/k focus ring over the current document's marks (doc order, thread included).
  var kbdMarkIdx = -1;
export function allMarks(){ return readerMain.querySelectorAll("mark[data-child]"); }
export function focusedMark(){
    var marks = allMarks();
    return (kbdMarkIdx >= 0 && kbdMarkIdx < marks.length) ? marks[kbdMarkIdx] : null;
  }
export function stepMark(delta){
    var marks = allMarks();
    if (!marks.length) return;
    var prev = focusedMark();
    if (prev) prev.classList.remove("mark-focus");
    kbdMarkIdx = kbdMarkIdx < 0 ? (delta > 0 ? 0 : marks.length - 1)
      : Math.max(0, Math.min(marks.length - 1, kbdMarkIdx + delta));
    var m = marks[kbdMarkIdx];
    m.classList.add("mark-focus");
    var top = m.getBoundingClientRect().top - readerMain.getBoundingClientRect().top + readerMain.scrollTop;
    readerHooks.animateScroll(readerMain, Math.max(0, top - readerMain.clientHeight * 0.42), "keyboard");
  }
