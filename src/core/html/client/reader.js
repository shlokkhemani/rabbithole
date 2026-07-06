/*
 * Browser-runtime chunk. These strings are concatenated in order by
 * ../client-script.js so the served page remains self-contained.
 */
export const CLIENT_READER = `  // ===========================================================================
  // READER
  // ===========================================================================
  function openNode(id){
    if (!nodes[id]) return;
    // Snapshot the outgoing document's position (belt & braces alongside the
    // scroll listener) so every window keeps its place when you come back.
    // Only while the reader is actually visible — hidden (canvas mode) it
    // reads 0 and would clobber the position saved on the way out.
    var prev = nodes[currentNodeId];
    if (prev && !document.body.classList.contains("mode-canvas")) prev._scrollTop = readerMain.scrollTop;
    currentNodeId = id;
    mode = "reader";
    document.body.classList.remove("mode-canvas");
    hideAsk();
    hidePeek();
    kbdMarkIdx = -1;
    renderBreadcrumb();
    renderReaderBody();
    renderSidebar();
    updateComposerState();
    if (nodes[id].status === "answered") markRead(nodes[id]);
    scheduleViewSave();
  }

  function renderBreadcrumb(){
    var path = lineageNodes(currentNodeId), html = "";
    path.forEach(function(n, i){
      if (i > 0) html += '<span class="crumb-sep">›</span>';
      var cur = i === path.length - 1;
      html += '<span class="crumb' + (cur ? ' current' : '') + '" data-id="' + n.id + '">' + esc(n.title || "Untitled") + '</span>';
    });
    breadcrumbEl.innerHTML = html;
  }
  breadcrumbEl.addEventListener("click", function(e){
    var c = e.target.closest(".crumb");
    if (!c || c.classList.contains("current")) return;
    openNode(c.dataset.id);
  });

  function renderReaderBody(){
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
          : (node.origin.question ? " — " + esc(node.origin.question) : "");
        ctx.innerHTML = '<span class="rc-label">From</span>“' + esc(truncate(node.origin.selected_text, 200)) + '”' + tail + '<span class="rc-go">→</span>';
      } else {
        ctx.innerHTML = '<span class="rc-label">Follow-up</span>' +
          (node.origin.lens ? lensBadgeHtml(node.origin.lens) : esc(node.origin.question || ""));
      }
      // The strip is a live link: click it to land on the exact spot in the
      // parent this branch grew from (flashed so the eye finds it).
      if (node.parent_id && nodes[node.parent_id] && !node.origin.synthesis){
        ctx.classList.add("linked");
        ctx.title = "See this in its original context";
        ctx.addEventListener("click", function(e){ jumpToOrigin(node, motionSourceFromEvent(e)); });
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
  function jumpToOrigin(node, source){
    var parent = nodes[node.parent_id];
    if (!parent) return;
    openNode(parent.id);
    var target = readerMain.querySelector('mark[data-child="' + node.id + '"]') ||
                 readerMain.querySelector('[data-turn="' + node.id + '"]');
    if (!target) return;
    var top = target.getBoundingClientRect().top - readerMain.getBoundingClientRect().top + readerMain.scrollTop;
    animateScroll(readerMain, Math.max(0, top - readerMain.clientHeight * 0.38), source);
    if (target.tagName === "MARK"){
      var marks = readerMain.querySelectorAll('mark[data-child="' + node.id + '"]');
      for (var i = 0; i < marks.length; i++) playLandingCue(marks[i], "mark-flash");
    }
  }
  readerMain.addEventListener("scroll", function(){
    var n = nodes[currentNodeId];
    if (n) n._scrollTop = readerMain.scrollTop;
    hidePeek();
    scheduleViewSave();
  }, { passive: true });

  // ---------- follow-up thread ----------
  function buildThreadRule(){
    var r = document.createElement("div");
    r.className = "thread-rule";
    r.textContent = "Conversation";
    return r;
  }
  function buildThreadItem(k){
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
  function ensureThread(){
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
  function updateThreadItem(k){
    var item = readerMain.querySelector('[data-turn="' + k.id + '"]');
    if (!item){
      var t = ensureThread();
      if (t) t.appendChild(buildThreadItem(k));
      return;
    }
    fillTurnAnswer(item.querySelector(".turn-a"), k);
  }
  function removeThreadItem(childId){
    var item = readerMain.querySelector('[data-turn="' + childId + '"]');
    if (item && item.parentNode) item.parentNode.removeChild(item);
    var t = readerMain.querySelector("#thread");
    if (t && !t.querySelector(".turn")) t.parentNode.removeChild(t);
  }

  function applyChildHighlights(dc, node){
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
  function wrapInContainer(dc, anchor, childId, cls){
    if (!dc || !anchor) return;
    var rr = rangeFromOffsets(dc, anchor.offset_start, anchor.offset_end);
    if (rr){ try { wrapRange(rr, childId, cls); } catch(e){} }
  }
  // Promote a child's pending marks to ready within a container.
  function upgradeMarks(root, childId){
    if (!root) return;
    var marks = root.querySelectorAll('mark[data-child="' + childId + '"]');
    for (var i = 0; i < marks.length; i++){ marks[i].classList.remove("mark-pending"); marks[i].classList.add("mark-ready"); }
  }
  // Unwrap a child's marks (used to roll back a failed ask) so offsets stay valid.
  function removeMarks(root, childId){
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
  readerMain.addEventListener("click", onMarkClick);
  world.addEventListener("click", onMarkClick);

  function renderSidebar(){
    var kids = childrenOf(currentNodeId).filter(function(k){ return !isFollowup(k); }).sort(function(a,b){
      return (anchorStart(a) - anchorStart(b)) || ((a._order||0) - (b._order||0));
    });
    if (!kids.length){
      sideEl.innerHTML = '<h3>Branches</h3><div class="side-empty">Select any text in the document and ask about it — the answer opens as a branch here. Or ask a follow-up in the box below the document.</div>';
      return;
    }
    var html = '<h3>Branches (' + kids.length + ')</h3>';
    kids.forEach(function(k, i){
      var pending = k.status !== "answered";
      var qHtml = (k.origin && k.origin.synthesis) ? '<span class="lens-badge">✦ Synthesis</span>'
        : (k.origin && k.origin.lens) ? lensBadgeHtml(k.origin.lens)
        : esc((k.origin && k.origin.question) ? k.origin.question : (k.title || "Untitled"));
      var quote = (k.origin && k.origin.selected_text) ? k.origin.selected_text : "";
      var status = pending ? pendingStatusHtml(k)
        : isUnread(k) ? '<span class="si-new">new — open →</span>'
        : 'open →';
      html += '<div class="side-item' + (pending ? ' pending' : '') + '" data-child="' + k.id + '">';
      html += '<div class="si-q"><span class="si-num">' + (i+1) + '</span><span>' + qHtml + '</span></div>';
      if (quote) html += '<div class="si-quote">“' + esc(truncate(quote, 80)) + '”</div>';
      html += '<div class="si-status">' + status + '</div>';
      // A streaming answer is watchable right here: its last lines render live
      // inside the tile (and the whole tile opens the full streaming view).
      if (pending && k.html) html += '<div class="si-live"><div class="md">' + k.html + '</div></div>';
      html += '</div>';
    });
    sideEl.innerHTML = html;
  }
  function pendingStatusHtml(k){
    if (frozen) return '<span class="si-muted">unanswered in this snapshot</span>';
    if (closed) return '<span class="si-muted">saved — answered when you reopen</span>';
    if (connLost || !agentAttached) return '<span class="si-muted">saved — waiting for the agent</span>';
    if (k && k.html) return '<span class="shimmer-text">Writing…</span>';
    return '<span class="shimmer-text">Thinking…</span>';
  }
  sideEl.addEventListener("click", function(e){
    var it = e.target.closest(".side-item");
    if (!it) return;
    openNode(it.dataset.child); // pending items open too — the answer streams there
  });

  function setReaderFontScale(delta){
    var node = nodes[currentNodeId];
    node.font_scale = Math.min(MAX_FS, Math.max(MIN_FS, (node.font_scale || 1) + delta));
    var dcs = readerMain.querySelectorAll(".doc-content");
    for (var i = 0; i < dcs.length; i++) dcs[i].style.fontSize = fontPx(node, READER_BASE) + "px";
    if (node.bodyEl){ var cdc = node.bodyEl.querySelector(".doc-content"); if (cdc) cdc.style.fontSize = fontPx(node, CANVAS_BASE) + "px"; }
    persistNode(node);
  }
  document.getElementById("r-textdown").addEventListener("click", function(){ setReaderFontScale(-0.1); });
  document.getElementById("r-textup").addEventListener("click", function(){ setReaderFontScale(0.1); });
  document.getElementById("r-canvas").addEventListener("click", function(){ setMode("canvas"); });
  document.getElementById("r-done").addEventListener("click", function(){ if (!closed) post({ type: "done" }); });
  document.getElementById("r-theme").addEventListener("click", toggleTheme);
  document.getElementById("t-theme").addEventListener("click", toggleTheme);

  // ---------- offset <-> range highlighting ----------
  function rangeFromOffsets(container, startOff, endOff){
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
  function charOffset(container, node, offset){
    var r = document.createRange();
    r.selectNodeContents(container);
    try { r.setEnd(node, offset); } catch(e){ return 0; }
    return r.toString().length;
  }
  function wrapTextNode(textNode, childId, cls){
    var m = document.createElement("mark");
    m.className = cls; m.dataset.child = childId;
    textNode.parentNode.insertBefore(m, textNode);
    m.appendChild(textNode);
  }
  // A rendered formula's text lives inside <math>; slipping a <mark> (an HTML
  // element) in there produces invalid MathML and the formula stops rendering.
  // Leave math internals unwrapped — the surrounding prose still highlights and
  // the offsets are unaffected (marking is purely visual).
  function inMath(node){
    for (var p = node; p; p = p.parentNode){
      if (p.localName === "math") return true;
    }
    return false;
  }
  function wrapRange(range, childId, cls){
    var startC = range.startContainer, endC = range.endContainer, startO = range.startOffset, endO = range.endOffset;
    if (startC === endC && startC.nodeType === 3){
      if (startO === endO || inMath(startC)) return;
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
      if (s >= e || !L || inMath(node)) continue;
      var t = s > 0 ? node.splitText(s) : node;
      if (e < L) t.splitText(e - s);
      wrapTextNode(t, childId, cls);
    }
  }

`;
