/*
 * Browser-runtime chunk. These strings are concatenated in order by
 * ../client-script.js so the served page remains self-contained.
 */
export const CLIENT_TRANSPORT_STATUS = `  // ===========================================================================
  // transport
  // ===========================================================================
  function post(payload){
    if (frozen) return Promise.resolve({ ok: true }); // a snapshot has no server
    return fetch("/events", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) }).catch(function(){ return null; });
  }
  // Where-was-I, persisted (debounced) on every meaningful move so a reopen —
  // tomorrow or after a crash — lands exactly here.
  var viewSaveTimer = 0;
  function scheduleViewSave(){
    if (frozen || closed) return;
    if (viewSaveTimer) clearTimeout(viewSaveTimer);
    viewSaveTimer = setTimeout(function(){
      viewSaveTimer = 0;
      if (closed) return;
      var cur = nodes[currentNodeId];
      var scroll = (mode === "reader") ? readerMain.scrollTop : ((cur && cur._scrollTop) || 0);
      post({ type: "view_state", state: { mode: mode, node_id: currentNodeId, scroll: scroll, view: { x: view.x, y: view.y, scale: view.scale } } });
    }, 600);
  }
  var saveTimers = {};
  function persistNode(node){
    if (saveTimers[node.id]) clearTimeout(saveTimers[node.id]);
    saveTimers[node.id] = setTimeout(function(){
      post({ type:"node_update", node_id: node.id, position:{x:node.x,y:node.y}, size:{w:node.w,h:node.h}, collapsed: node.collapsed, font_scale: node.font_scale });
    }, 350);
  }
  // One request for a whole-layout change (Tidy) instead of N debounced posts.
  function persistNodesBulk(list){
    if (!list || !list.length) return;
    post({ type:"nodes_update", nodes: list.map(function(n){
      return { node_id: n.id, position:{x:n.x,y:n.y}, size:{w:n.w,h:n.h}, collapsed: n.collapsed, font_scale: n.font_scale };
    }) });
  }
  var sse = null;
  function connectSse(){
    // Pass the hydration checkpoint so any event broadcast between page-serve and
    // this connect is replayed (the first connect has no Last-Event-ID header).
    var after = hydration.last_event_id || 0;
    sse = new EventSource("/sse?after=" + after);
    sse.onopen = function(){
      sseFails = 0;
      if (connLost){ connLost = false; refreshStatus(); }
    };
    sse.onmessage = function(ev){ try { handleServer(JSON.parse(ev.data)); } catch(e){} };
    // EventSource retries forever on its own; after a couple of failures probe
    // the server once — if it's gone (agent process died), say so instead of
    // letting pending asks shimmer into eternity. Recovers via onopen.
    sse.onerror = function(){
      if (closed) return;
      sseFails++;
      if (sseFails >= 2 && !connLost){
        fetch("/health", { cache: "no-store" })
          .then(function(r){ if (!r.ok) throw new Error("bad status"); })
          .catch(function(){ if (!closed && !connLost){ connLost = true; refreshStatus(); } });
      }
    };
  }
  // Repaint a streaming node everywhere it is currently on screen: the reader
  // main doc, its follow-up thread turn, and its canvas card. Scroll positions
  // are restored exactly on every repaint — arriving text must never move the
  // human's place (an innerHTML swap briefly collapses scrollHeight, which
  // would otherwise clamp the scroll and make the view jump).
  function renderStreamSurfaces(node, firstChunk){
    if (node.bodyEl){
      var cs = node.bodyEl.scrollTop;
      fillBody(node);
      node.bodyEl.scrollTop = cs;
      scheduleEdges();
    }
    if (mode !== "reader") return;
    var keep = readerMain.scrollTop;
    if (currentNodeId === node.id){
      var rdc = readerMain.querySelector('.doc-content[data-node-id="' + node.id + '"]');
      if (rdc){
        rdc.innerHTML = "";
        if (node.html) fillStreaming(rdc, node, "reader:" + node.id);
        else rdc.appendChild(buildLoading(node));
        readerMain.scrollTop = keep;
      }
    } else if (currentNodeId === node.parent_id){
      if (isFollowup(node)){ updateThreadItem(node); readerMain.scrollTop = keep; }
      else {
        // The branch streams live inside its sidebar tile: the first chunk
        // rebuilds the tile (Thinking… → Writing… + the live pane), later
        // chunks just repaint the pane.
        var live = sideEl.querySelector('.side-item[data-child="' + node.id + '"] .si-live .md');
        if (live && !firstChunk) {
          live.innerHTML = node.html || "";
          if (typeof mountVisuals === "function") mountVisuals(live, "reader-side:" + node.id);
        }
        else renderSidebar();
      }
    }
  }

  function handleServer(msg){
    if (msg.type === "node_answered"){
      var node = nodes[msg.node_id];
      if (!node){
        // Self-heal: an answer arrived for a node we don't have (e.g. a branch
        // that was optimistically rolled back after a lost ack). Recreate it from
        // the broadcast so the answer is never silently dropped.
        var pos = msg.position || {};
        node = nodes[msg.node_id] = {
          id: msg.node_id, parent_id: msg.parent_id || null, title: msg.title || "…",
          html: "", md: "", read: false, origin: msg.origin || null, x: pos.x || 0, y: pos.y || 0,
          w: DEFAULT_CHILD.w, h: DEFAULT_CHILD.h, font_scale: msg.font_scale || 1,
          collapsed: false, status: "pending",
          _order: orderCounter++, _startTs: Date.now()
        };
        if (canvasBuilt){ createNodeEl(node); renderVisibility(); drawEdges(); }
        if (node.origin && node.origin.anchor){
          if (mode === "reader")
            wrapInContainer(readerMain.querySelector('.doc-content[data-node-id="' + node.parent_id + '"]'), node.origin.anchor, node.id, "hl mark-pending");
          var pp = nodes[node.parent_id];
          if (pp && pp.bodyEl) wrapInContainer(pp.bodyEl.querySelector(".doc-content"), node.origin.anchor, node.id, "hl mark-pending");
        }
      }
      node.status = "answered"; node.title = msg.title || node.title; node.html = msg.contentHtml || "";
      node.md = msg.markdown || node.md || "";
      node.read = false; // unread until the human actually reaches it
      if (node.titleEl){ node.titleEl.textContent = node.title; node.titleEl.title = node.title; }
      if (node.bodyEl){ fillBody(node); scheduleEdges(); }
      updateCardComposer(node);
      if (mode === "reader"){
        // The answered node itself may be open (e.g. opened pending from canvas).
        if (currentNodeId === node.id){ renderBreadcrumb(); renderReaderBody(); renderSidebar(); updateComposerState(); markRead(node); }
        else {
          // The parent doc may be on screen as the main document OR as a
          // follow-up answer in the thread — upgrade marks wherever they are.
          upgradeMarks(readerMain, node.id);
          if (currentNodeId === node.parent_id){
            if (isFollowup(node)){ updateThreadItem(node); markRead(node); } // you watched it land
            else renderSidebar();
          }
        }
      }
      // Upgrade the inline mark inside the parent's canvas card too.
      var p = nodes[node.parent_id];
      if (p && p.bodyEl) upgradeMarks(p.bodyEl, node.id);
      if (isUnread(node) && node.el) node.el.classList.add("unread");
      refreshAmbient();
      updateSince();
    } else if (msg.type === "node_deleted"){
      // Another surface (or a replayed event) removed a branch — mirror it.
      removeNodesLocal(msg.node_ids || [], null);
    } else if (msg.type === "node_progress"){
      // A chunk of a streaming answer: the payload carries everything written
      // so far, already rendered. Ignore unknown/settled nodes — node_answered
      // is the authoritative end state and self-heals.
      var sn = nodes[msg.node_id];
      if (sn && sn.status === "pending"){
        var firstChunk = !sn.html;
        sn.html = msg.contentHtml || "";
        renderStreamSurfaces(sn, firstChunk);
      }
    } else if (msg.type === "agent_status"){
      agentAttached = !!msg.attached;
      agentReason = msg.reason || null;
      refreshStatus();
    } else if (msg.type === "session_closed"){
      closed = true;
      closedReason = msg.reason || "session_closed";
      // Stop EventSource from reconnecting forever to the now-dead endpoint.
      if (sse) { try { sse.close(); } catch(e){} sse = null; }
      refreshStatus();
    }
  }

  // ===========================================================================
  // status banner (agent liveness / session end) — non-modal, reading stays open
  // ===========================================================================
  var bannerKey = null;
  var bannerDismissed = {};
  function setBanner(key, warn, title, msg){
    bannerKey = key;
    if (bannerDismissed[key]){ bannerEl.classList.remove("visible"); return; }
    bannerTitle.textContent = title;
    bannerMsg.textContent = msg;
    bannerEl.classList.toggle("warn", !!warn);
    bannerEl.classList.add("visible");
  }
  function clearBanner(){
    bannerKey = null;
    bannerEl.classList.remove("visible");
  }
  document.getElementById("banner-x").addEventListener("click", function(){
    if (bannerKey) bannerDismissed[bannerKey] = true;
    bannerEl.classList.remove("visible");
  });

  function hasPendingAsks(){
    for (var k in nodes) if (nodes[k].status === "pending") return true;
    return false;
  }
  function refreshStatus(){
    document.body.classList.toggle("agent-down", agentDown());
    document.body.classList.toggle("session-over", closed);
    // Once the session is over the server is gone, so new asks can't be taken —
    // but every question already asked is saved and re-queued on reopen.
    var savedNote = hasPendingAsks() ? " Your unanswered questions are saved and will be answered there." : "";
    if (frozen){
      clearBanner(); // a snapshot needs no liveness story — the copy explains itself
    } else if (closed){
      if (closedReason === "done")
        setBanner("done", false, "Session ended", "This Rabbithole is saved. Reopen it from your terminal any time to keep exploring." + savedNote);
      else if (closedReason === "superseded")
        setBanner("superseded", false, "Reopened elsewhere", "This Rabbithole was just reopened in another tab — continue there. This view is now read-only.");
      else if (closedReason === "timeout")
        setBanner("timeout", true, "Session timed out", "Everything is saved. Reopen this Rabbithole from your terminal to continue." + savedNote);
      else
        setBanner("closed", true, "The agent has left", "Everything answered so far is saved. Reopen this Rabbithole from your terminal to keep exploring." + savedNote);
    } else if (connLost){
      setBanner("connlost", true, "Connection lost", "Can't reach the agent session — it may have exited. Your Rabbithole is saved; reopen it from your terminal to continue.");
    } else if (!agentAttached){
      if (agentReason === "stalled")
        setBanner("stalled", true, "The agent went quiet", "No response for a while — it may have stopped. You can keep asking: questions are saved and answered when the agent returns.");
      else
        setBanner("cancelled", true, "The agent stopped listening", "The tool call was cancelled. You can keep asking — questions are saved and answered when the agent picks this hole back up.");
    } else {
      clearBanner();
      bannerDismissed = {};
    }
    if (mode === "reader") renderSidebar();
    updateComposerState();
    if (canvasBuilt) for (var cid in nodes) updateCardComposer(nodes[cid]);
  }

`;
