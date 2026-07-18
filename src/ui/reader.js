import {
  CANVAS_BASE,
  MAX_FS,
  MIN_FS,
  READER_BASE,
  anchorStart,
  breadcrumbEl,
  buildDocContent,
  disposeNodeContent,
  buildLoading,
  childrenOf,
  currentNodeId,
  followupsOf,
  fontPx,
  isFollowup,
  isUnread,
  goToNode,
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
  truncate,
  world,
  sessionPhase
} from "./core.js";
import { escapeHtml } from "../core/utils.js";
import { createModuleLifecycle } from "./lifecycle.js";
import { captureContentPosition, restoreContentPosition } from "./scroll-position.js";
import { mountVisuals } from "./visuals.js";
import { applyChildHighlights } from "./text-marks.js";
import { buildOriginCrop } from "./origin-provenance.js";

function defaultReaderHooks(){
  return {
    hideAsk: function(){},
    updateComposerState: function(){},
    scheduleViewSave: function(){},
    setMode: function(){},
    post: function(){ return Promise.resolve({ ok: true }); },
    mountDocImages: null,
    persistNode: function(){},
    animateScroll: function(){}
  };
}

var readerLifecycle = createModuleLifecycle({ defaults: defaultReaderHooks });

export function registerReaderHooks(hooks) {
  readerLifecycle.register(hooks);
}

var breadcrumbNodes = {};
var noteNodes = {};
var marginObserver = null;

  // ===========================================================================
  // READER
  // ===========================================================================
export function openNode(id){
    if (!nodes[id]) return;
    var transferredPosition = document.body.classList.contains("mode-canvas")
      ? captureContentPosition(nodes[id].bodyEl)
      : null;
    // Snapshot the outgoing document's position (belt & braces alongside the
    // scroll listener) so every window keeps its place when you come back.
    // Only while the reader is actually visible — hidden (canvas mode) it
    // reads 0 and would clobber the position saved on the way out.
    var prev = nodes[currentNodeId];
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
    if (nodes[id].status === "answered") markRead(nodes[id]);
    readerLifecycle.hooks.scheduleViewSave();
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
    var readerScope = readerLifecycle.beginInit();
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
    readerScope.listen(readerMain, "keydown", onMarkKeydown);
    // Canvas marks dive to the answer card in place — never yank into the reader.
    readerScope.listen(world, "click", onCanvasMarkClick);
    readerScope.listen(world, "keydown", onCanvasMarkKeydown);
    readerScope.listen(readerMain, "click", onNoteClick);
    readerScope.listen(readerMain, "keydown", onNoteKeydown);
    // Hovering a margin note lights its highlight so the pair reads as one.
    readerScope.listen(readerMain, "mouseover", function(e){ syncNoteHover(e, true); });
    readerScope.listen(readerMain, "mouseout", function(e){ syncNoteHover(e, false); });
    readerScope.listen(document.getElementById("r-textdown"), "click", function(){ setReaderFontScale(-0.1); });
    readerScope.listen(document.getElementById("r-textup"), "click", function(){ setReaderFontScale(0.1); });
    readerScope.listen(document.getElementById("t-canvas"), "click", function(){ if (mode === "canvas") return; readerLifecycle.hooks.setMode("canvas"); });
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
    readerLifecycle.dispose(resetHooks);
    if (marginObserver){ marginObserver.disconnect(); marginObserver = null; }
    breadcrumbNodes = {};
    noteNodes = {};
    kbdMarkIdx = -1;
  }

export function renderReaderBody(){
    var node = nodes[currentNodeId];
    var previous = readerMain.querySelector(".doc-content"); if (previous && previous._rhDispose) previous._rhDispose();
    readerMain.innerHTML = "";
    var col = document.createElement("div");
    col.className = "reader-col";
    // The lineage trail leads the document column and scrolls with it — the
    // floating taskbar above carries no per-document state.
    if (breadcrumbEl) col.appendChild(breadcrumbEl);
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
    var crop = buildOriginCrop(node, "reader");
    if (crop) col.appendChild(crop);
    var dc = buildDocContent(node, READER_BASE);
    col.appendChild(dc);
    applyChildHighlights(dc, node);
    var fups = followupsOf(node.id);
    var isPdfReader = dc.classList.contains("rh-pdf");
    var isPdfViewport = isPdfReader && !node.parent_id && !node.origin && !crop && !fups.length;
    readerMain.classList.toggle("pdf-reader", isPdfReader);
    readerMain.classList.toggle("pdf-reader-viewport", isPdfViewport);
    col.classList.toggle("pdf-reader-col", isPdfReader);
    col.classList.toggle("pdf-reader-viewport", isPdfViewport);
    if (fups.length){
      var thread = document.createElement("div");
      thread.id = "thread";
      thread.appendChild(buildThreadRule());
      fups.forEach(function(k){ thread.appendChild(buildThreadItem(k)); });
      col.appendChild(thread);
      // Rendering the thread IS reading it — answered follow-ups shed their dots.
      fups.forEach(function(k){ if (k.status === "answered") markRead(k); });
    }
    // The margin-note layer hangs off the column's right edge; renderMarginNotes
    // fills and positions it once the column is in the document.
    var notes = document.createElement("div");
    notes.id = "margin-notes";
    col.appendChild(notes);
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
    readerLifecycle.hooks.animateScroll(readerMain, Math.max(0, top - readerMain.clientHeight * 0.38), source);
    if (target.tagName === "MARK"){
      var marks = readerMain.querySelectorAll('mark[data-child="' + node.id + '"]');
      for (var i = 0; i < marks.length; i++) playLandingCue(marks[i], "mark-flash");
    }
  }
  function onReaderScroll(){
    var n = nodes[currentNodeId];
    if (n) n._scrollTop = readerMain.scrollTop;
    readerLifecycle.hooks.scheduleViewSave();
  }

  // ---------- follow-up thread ----------
function buildThreadRule(){
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
function fillTurnAnswer(a, k){
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
  function onCanvasMarkClick(e){
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (!m) return;
    if (!window.getSelection().isCollapsed) return; // the human was selecting, not clicking
    var k = nodes[m.dataset.child];
    if (k) goToNode(k, motionSourceFromEvent(e));
  }
  function onCanvasMarkKeydown(e){
    if (e.key !== "Enter") return;
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (!m) return;
    var k = nodes[m.dataset.child];
    if (!k) return;
    e.preventDefault();
    goToNode(k, motionSourceFromEvent(e));
  }
  // Branches render as margin notes — comment cards hanging in the right
  // margin, each top-aligned with the highlight it grew from. The layer lives
  // inside .reader-col so the cards scroll with the text; CSS hides it when
  // the window has no margin to spare (the inline marks carry those widths).
export function renderMarginNotes(){
    var layer = readerMain && readerMain.querySelector("#margin-notes");
    if (!layer) return;
    var kids = childrenOf(currentNodeId).filter(function(k){ return !isFollowup(k); }).sort(function(a,b){
      return (anchorStart(a) - anchorStart(b)) || ((a._order||0) - (b._order||0));
    });
    var fragment = document.createDocumentFragment();
    var newLivePanes = [];
    kids.forEach(function(k){
      var pending = k.status !== "answered";
      var qHtml = (k.origin && k.origin.synthesis) ? '<span class="lens-badge">✦ Synthesis</span>'
        : (k.origin && k.origin.lens) ? lensBadgeHtml(k.origin.lens)
        : escapeHtml((k.origin && k.origin.question) ? k.origin.question : (k.title || "Untitled"));
      var quote = (k.origin && k.origin.selected_text) ? k.origin.selected_text : "";
      var status = pending ? pendingStatusHtml(k)
        : isUnread(k) ? '<span class="si-new">new — open →</span>'
        : 'open →';
      var tile = noteNodes[k.id];
      if (!tile){
        tile = document.createElement("div");
        tile.className = "side-item";
        tile.dataset.child = k.id;
        tile.setAttribute("role", "link");
        tile.tabIndex = 0;
        tile._question = document.createElement("div"); tile._question.className = "si-q";
        tile._quote = document.createElement("div"); tile._quote.className = "si-quote";
        tile._status = document.createElement("div"); tile._status.className = "si-status";
        tile.append(tile._question, tile._quote, tile._status);
        noteNodes[k.id] = tile;
      }
      tile.classList.toggle("pending", pending);
      tile._question.innerHTML = qHtml;
      tile._quote.textContent = quote ? "“" + truncate(quote, 80) + "”" : "";
      tile._quote.hidden = !quote;
      tile._status.innerHTML = status;
      var name = (k.origin && k.origin.synthesis) ? "Synthesis"
        : ((k.origin && k.origin.question) || k.title || "Untitled");
      tile.setAttribute("aria-label", "Open branch: " + name + (pending ? ", pending" : isUnread(k) ? ", new" : ""));
      // A streaming answer is watchable right here: its last lines render live
      // inside the note (and the whole note opens the full streaming view).
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
    layer.replaceChildren(fragment);
    mountNoteVisuals(newLivePanes);
    layoutMarginNotes();
  }
  // Each note wants the y of its first mark; stacking resolves collisions in
  // document order. Re-runs whenever the column or a note changes size (fonts,
  // images, streaming text), so alignment holds without any scroll listener.
export function layoutMarginNotes(){
    var layer = readerMain && readerMain.querySelector("#margin-notes");
    if (!layer) return;
    if (!marginObserver && typeof ResizeObserver === "function"){
      marginObserver = new ResizeObserver(function(){ positionNotes(); });
    }
    if (marginObserver){
      marginObserver.disconnect();
      marginObserver.observe(layer.parentNode);
      for (var i = 0; i < layer.children.length; i++) marginObserver.observe(layer.children[i]);
    }
    positionNotes();
  }
function positionNotes(){
    var layer = readerMain && readerMain.querySelector("#margin-notes");
    if (!layer || !layer.clientWidth){ if (layer) layer.classList.remove("settled"); return; }
    var layerTop = layer.getBoundingClientRect().top;
    var cursor = 0;
    for (var i = 0; i < layer.children.length; i++){
      var tile = layer.children[i];
      var mark = readerMain.querySelector('mark[data-child="' + tile.dataset.child + '"]');
      tile.classList.toggle("unanchored", !mark);
      var desired = mark ? Math.round(mark.getBoundingClientRect().top - layerTop) : cursor;
      var top = Math.max(desired, cursor);
      tile.style.top = top + "px";
      cursor = top + tile.offsetHeight + 10;
    }
    layer.classList.add("settled");
  }
function onNoteClick(e){
    var it = e.target.closest && e.target.closest("#margin-notes .side-item");
    if (!it) return;
    openNode(it.dataset.child); // pending notes open too — the answer streams there
  }
function onNoteKeydown(e){
    if (e.key !== "Enter") return;
    var it = e.target.closest && e.target.closest('#margin-notes .side-item[role="link"]');
    if (!it) return;
    e.preventDefault();
    openNode(it.dataset.child);
  }
function syncNoteHover(e, on){
    var tile = e.target.closest && e.target.closest("#margin-notes .side-item");
    if (!tile) return;
    var related = e.relatedTarget;
    if (related && tile.contains(related)) return;
    var marks = readerMain.querySelectorAll('mark[data-child="' + tile.dataset.child + '"]');
    for (var i = 0; i < marks.length; i++) marks[i].classList.toggle("mark-focus", on);
  }
function mountNoteVisuals(panes){
    for (var i = 0; i < panes.length; i++){
      var key = "margin-notes:" + panes[i].node.id;
      mountVisuals(panes[i].pane, key);
      if (typeof readerLifecycle.hooks.mountDocImages === "function") readerLifecycle.hooks.mountDocImages(panes[i].pane, panes[i].node, null, key);
    }
  }
function pendingStatusHtml(k){
    var copy = {
      frozen: '<span class="si-muted">unanswered in this snapshot</span>',
      closed: '<span class="si-muted">saved — answered when you reopen</span>',
      away: '<span class="si-muted">saved — waiting for the agent</span>',
      live: k && k.html ? '<span class="shimmer-text">Writing…</span>' : '<span class="shimmer-text">Thinking…</span>'
    };
    return copy[sessionPhase()];
  }
function setReaderFontScale(delta){
    var node = nodes[currentNodeId];
    node.font_scale = Math.min(MAX_FS, Math.max(MIN_FS, (node.font_scale || 1) + delta));
    var dcs = readerMain.querySelectorAll(".doc-content");
    for (var i = 0; i < dcs.length; i++) dcs[i].style.fontSize = fontPx(node, READER_BASE) + "px";
    if (node.bodyEl){ var cdc = node.bodyEl.querySelector(".doc-content"); if (cdc) cdc.style.fontSize = fontPx(node, CANVAS_BASE) + "px"; }
    readerLifecycle.hooks.persistNode(node);
  }

  // j/k focus ring over the current document's marks (doc order, thread included).
  var kbdMarkIdx = -1;
function allMarks(){ return readerMain.querySelectorAll("mark[data-child]"); }
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
    readerLifecycle.hooks.animateScroll(readerMain, Math.max(0, top - readerMain.clientHeight * 0.42), "keyboard");
  }
