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
  closed,
  currentNodeId,
  followupsOf,
  fontPx,
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
  world,
  sessionPhase
} from "./core.js";
import { escapeHtml } from "../core/utils.js";
import { createModuleLifecycle } from "./lifecycle.js";
import { mountVisuals } from "./visuals.js";
import { applyChildHighlights } from "./text-marks.js";

function defaultReaderHooks(){
  return {
    hideAsk: function(){},
    hidePeek: function(){},
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
    readerLifecycle.hooks.hideAsk();
    readerLifecycle.hooks.hidePeek();
    kbdMarkIdx = -1;
    renderBreadcrumb();
    renderReaderBody();
    renderSidebar();
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
    readerScope.listen(world, "click", onMarkClick);
    readerScope.listen(readerMain, "keydown", onMarkKeydown);
    readerScope.listen(world, "keydown", onMarkKeydown);
    readerScope.listen(sideEl, "click", onSidebarClick);
    readerScope.listen(sideEl, "keydown", onSidebarKeydown);
    readerScope.listen(document.getElementById("r-textdown"), "click", function(){ setReaderFontScale(-0.1); });
    readerScope.listen(document.getElementById("r-textup"), "click", function(){ setReaderFontScale(0.1); });
    readerScope.listen(document.getElementById("r-canvas"), "click", function(){ readerLifecycle.hooks.setMode("canvas"); });
    readerScope.listen(document.getElementById("r-done"), "click", function(){ if (!closed) readerLifecycle.hooks.post({ type: "done" }); });
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
    readerLifecycle.dispose(resetHooks);
    breadcrumbNodes = {};
    sidebarNodes = {};
    kbdMarkIdx = -1;
  }

export function renderReaderBody(){
    var node = nodes[currentNodeId];
    var previous = readerMain.querySelector(".doc-content"); if (previous && previous._rhDispose) previous._rhDispose();
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
    readerLifecycle.hooks.animateScroll(readerMain, Math.max(0, top - readerMain.clientHeight * 0.38), source);
    if (target.tagName === "MARK"){
      var marks = readerMain.querySelectorAll('mark[data-child="' + node.id + '"]');
      for (var i = 0; i < marks.length; i++) playLandingCue(marks[i], "mark-flash");
    }
  }
  function onReaderScroll(){
    var n = nodes[currentNodeId];
    if (n) n._scrollTop = readerMain.scrollTop;
    readerLifecycle.hooks.hidePeek();
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
function mountSidebarVisuals(panes){
    for (var i = 0; i < panes.length; i++){
      var key = "reader-side:" + panes[i].node.id;
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
