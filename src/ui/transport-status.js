import {
  DEFAULT_CHILD,
  agentReason,
  bannerNotice,
  buildLoading,
  canvasBuilt,
  closed,
  closedReason,
  connLost,
  currentNodeId,
  fillStreaming,
  frozen,
  hydration,
  incrementSseFails,
  isFollowup,
  isUnread,
  markRead,
  mode,
  nextOrder,
  nodes,
  readerMain,
  refreshAmbient,
  resetSseFails,
  setAgentAttached,
  setAgentReason,
  setClosedState,
  setConnLost,
  sessionPhase,
  sideEl,
  updateSince,
  view,
  viewAdjusted
} from "./core.js";
import {
  renderBreadcrumb,
  renderReaderBody,
  renderSidebar,
  updateThreadItem
} from "./reader.js";
import { upgradeMarks, wrapInContainer } from "./text-marks.js";
import {
  createNodeEl,
  drawEdges,
  fillBody,
  renderVisibility,
  scheduleEdges,
  updateCardComposer
} from "./canvas-view.js";
import { updateComposerState } from "./ask-followups.js";
import { removeNodesLocal } from "./branch-surfaces.js";
import { refreshNodeHtml } from "./renderer.js";
import { cancelFrame, nextFrame } from "./lifecycle.js";

  // ===========================================================================
  // transport
  // ===========================================================================
var transportAdapter = null;
var sse = null;
var webTransport = null;
var transportEpoch = 0;
var transportDisposed = true;
var transportDisposePromise = null;
var healthProbeController = null;

export function setTransportAdapter(adapter){
  transportAdapter = adapter && typeof adapter === "object" ? adapter : null;
}

export function initTransportStatus(){
  transportEpoch += 1;
  transportDisposed = false;
  transportDisposePromise = null;
}

export function post(payload){
    if (frozen) return Promise.resolve({ ok: true }); // a snapshot has no server
    if (transportDisposed) return Promise.resolve(null);
    return postWithAdapter(transportAdapter, payload);
  }
  function postWithAdapter(adapter, payload){
    if (adapter && typeof adapter.post === "function") {
      return Promise.resolve(adapter.post(payload)).catch(function(){ return null; });
    }
    return fetch("/events", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) }).catch(function(){ return null; });
  }
  // Where-was-I, persisted (debounced) on every meaningful move so a reopen —
  // tomorrow or after a crash — lands exactly here.
  var viewSaveTimer = 0;
  function currentViewState(){
    var cur = nodes[currentNodeId];
    var scroll = (mode === "reader") ? readerMain.scrollTop : ((cur && cur._scrollTop) || 0);
    var state = { mode: mode, node_id: currentNodeId, scroll: scroll };
    if (viewAdjusted) state.view = { x: view.x, y: view.y, scale: view.scale };
    return state;
  }
export function scheduleViewSave(){
    if (frozen || closed || transportDisposed) return;
    if (viewSaveTimer) clearTimeout(viewSaveTimer);
    viewSaveTimer = setTimeout(function(){
      viewSaveTimer = 0;
      if (closed) return;
      post({ type: "view_state", state: currentViewState() });
    }, 600);
  }
  var saveTimers = {};
export function persistNode(node){
    if (transportDisposed) return;
    if (saveTimers[node.id]) clearTimeout(saveTimers[node.id]);
    saveTimers[node.id] = setTimeout(function(){
      delete saveTimers[node.id];
      post({ type:"node_update", node_id: node.id, position:{x:node.x,y:node.y}, size:{w:node.w,h:node.h}, collapsed: node.collapsed, font_scale: node.font_scale });
    }, 350);
  }
export function flushPendingSaves(){
    return flushPendingSavesWith(post);
  }
  function flushPendingSavesWith(postPending){
    var pending = saveTimers;
    saveTimers = {};
    var posts = Object.keys(pending).map(function(id){
      clearTimeout(pending[id]);
      var node = nodes[id];
      if (!node) return Promise.resolve();
      return postPending({ type:"node_update", node_id: node.id, position:{x:node.x,y:node.y}, size:{w:node.w,h:node.h}, collapsed: node.collapsed, font_scale: node.font_scale });
    });
    if (viewSaveTimer){
      clearTimeout(viewSaveTimer);
      viewSaveTimer = 0;
      posts.push(postPending({ type: "view_state", state: currentViewState() }));
    }
    return Promise.all(posts);
  }
  // One request for a whole-layout change (Tidy) instead of N debounced posts.
export function persistNodesBulk(list){
    if (transportDisposed || !list || !list.length) return;
    post({ type:"nodes_update", nodes: list.map(function(n){
      return { node_id: n.id, position:{x:n.x,y:n.y}, size:{w:n.w,h:n.h}, collapsed: n.collapsed, font_scale: n.font_scale };
    }) });
  }
export function connectSse(){
    if (transportDisposed) return null;
    closeConnections();
    var epoch = ++transportEpoch;
    if (transportAdapter && typeof transportAdapter.connect === "function") {
      webTransport = transportAdapter.connect({
        after: hydration.last_event_id || 0,
        onOpen: function(){
          if (!isCurrentTransport(epoch)) return;
          resetSseFails();
          if (connLost){ setConnLost(false); refreshStatus(); }
        },
        onMessage: function(msg){ if (isCurrentTransport(epoch)) handleServer(msg); },
        onError: function(){
          if (!isCurrentTransport(epoch) || closed) return;
          if (incrementSseFails() >= 2 && !connLost){ setConnLost(true); refreshStatus(); }
        }
      });
      return webTransport;
    }
    // Pass the hydration checkpoint so any event broadcast between page-serve and
    // this connect is replayed (the first connect has no Last-Event-ID header).
    var after = hydration.last_event_id || 0;
    sse = new EventSource("/sse?after=" + after);
    sse.onopen = function(){
      if (!isCurrentTransport(epoch)) return;
      resetSseFails();
      if (connLost){ setConnLost(false); refreshStatus(); }
    };
    sse.onmessage = function(ev){ if (!isCurrentTransport(epoch)) return; try { handleServer(JSON.parse(ev.data)); } catch(e){} };
    // EventSource retries forever on its own; after a couple of failures probe
    // the server once — if it's gone (agent process died), say so instead of
    // letting pending asks shimmer into eternity. Recovers via onopen.
    sse.onerror = function(){
      if (!isCurrentTransport(epoch) || closed) return;
      if (incrementSseFails() >= 2 && !connLost){
        if (healthProbeController) healthProbeController.abort();
        healthProbeController = typeof AbortController === "function" ? new AbortController() : null;
        var probe = healthProbeController;
        fetch("/health", { cache: "no-store", signal: probe ? probe.signal : undefined })
          .then(function(r){ if (!r.ok) throw new Error("bad status"); })
          .catch(function(err){
            if (err && err.name === "AbortError") return;
            if (isCurrentTransport(epoch) && !closed && !connLost){ setConnLost(true); refreshStatus(); }
          })
          .finally(function(){ if (healthProbeController === probe) healthProbeController = null; });
      }
    };
    return sse;
  }
  var streamRenderRaf = 0;
  var streamRenderQueue = {};
  function cancelQueuedStreamRender(nodeId){
    delete streamRenderQueue[nodeId];
  }
  function scheduleStreamRender(node, firstChunk){
    if (transportDisposed) return;
    var epoch = transportEpoch;
    var queued = streamRenderQueue[node.id];
    streamRenderQueue[node.id] = { node: node, firstChunk: queued ? queued.firstChunk : firstChunk };
    if (streamRenderRaf) return;
    streamRenderRaf = nextFrame(function(){
      streamRenderRaf = 0;
      var batch = streamRenderQueue;
      streamRenderQueue = {};
      if (!isCurrentTransport(epoch)) return;
      Object.keys(batch).forEach(function(id){
        var item = batch[id];
        if (!item.node || item.node.status !== "pending") return;
        refreshNodeHtml(item.node);
        renderStreamSurfaces(item.node, item.firstChunk);
      });
    });
  }
  function cancelStreamRender(){
    if (streamRenderRaf) cancelFrame(streamRenderRaf);
    streamRenderRaf = 0;
    streamRenderQueue = {};
  }
  function isCurrentTransport(epoch){
    return !transportDisposed && epoch === transportEpoch;
  }
  function closeConnections(){
    if (healthProbeController){ healthProbeController.abort(); healthProbeController = null; }
    if (sse){ try { sse.close(); } catch(e){} sse = null; }
    if (webTransport && typeof webTransport.close === "function"){
      try { webTransport.close(); } catch(e){}
    }
    webTransport = null;
  }
export function disposeTransportStatus(){
    if (transportDisposePromise) return transportDisposePromise;
    if (transportDisposed){
      transportAdapter = null;
      return Promise.resolve();
    }
    var adapter = transportAdapter;
    transportDisposed = true;
    transportEpoch += 1;
    closeConnections();
    cancelStreamRender();
    transportDisposePromise = Promise.resolve(flushPendingSavesWith(function(payload){
      return postWithAdapter(adapter, payload);
    })).finally(function(){
      if (transportAdapter === adapter) transportAdapter = null;
    });
    return transportDisposePromise;
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
	        if (live && !firstChunk) live.innerHTML = node.html || "";
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
          html: "", md: "", base_url: msg.base_url || null, base_url_source: msg.base_url_source || null,
          read: false, origin: msg.origin || null, x: pos.x || 0, y: pos.y || 0,
          w: DEFAULT_CHILD.w, h: DEFAULT_CHILD.h, font_scale: msg.font_scale || 1,
          collapsed: false, status: "pending",
          _order: nextOrder(), _startTs: Date.now()
        };
        if (canvasBuilt){ createNodeEl(node); renderVisibility(); drawEdges(); }
        if (node.origin && node.origin.anchor){
          if (mode === "reader")
            wrapInContainer(readerMain.querySelector('.doc-content[data-node-id="' + node.parent_id + '"]'), node.origin.anchor, node.id, "hl mark-pending");
          var pp = nodes[node.parent_id];
          if (pp && pp.bodyEl) wrapInContainer(pp.bodyEl.querySelector(".doc-content"), node.origin.anchor, node.id, "hl mark-pending");
        }
      }
      cancelQueuedStreamRender(node.id);
      node.error = null;
      node.status = "answered"; node.title = msg.title || node.title;
      node.md = msg.markdown || node.md || "";
      node.base_url = msg.base_url || null;
      node.base_url_source = msg.base_url_source || null;
      refreshNodeHtml(node);
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
      // A chunk of a streaming answer: the payload carries the full markdown
      // written so far. Ignore unknown/settled nodes — node_answered
      // is the authoritative end state and self-heals.
      var sn = nodes[msg.node_id];
      if (sn && sn.status === "pending"){
        var firstChunk = !sn.md;
        sn.error = null;
        sn.md = msg.markdown || "";
        sn.base_url = msg.base_url || sn.base_url || null;
        sn.base_url_source = msg.base_url_source || sn.base_url_source || null;
        scheduleStreamRender(sn, firstChunk);
      }
    } else if (msg.type === "node_error"){
      var en = nodes[msg.node_id];
      if (en && en.status === "pending"){
        en.error = {
          message: msg.message || "The provider request failed.",
          code: msg.code || null,
          retryable: msg.retryable !== false
        };
        if (msg.markdown != null) en.md = msg.markdown || "";
        cancelQueuedStreamRender(en.id);
        refreshNodeHtml(en);
        renderStreamSurfaces(en, !en.md);
        if (en.bodyEl){ fillBody(en); scheduleEdges(); }
        if (mode === "reader"){
          if (currentNodeId === en.id){ renderReaderBody(); updateComposerState(); }
          else if (currentNodeId === en.parent_id){
            if (isFollowup(en)) updateThreadItem(en);
            else renderSidebar();
          }
        }
        refreshAmbient();
      }
    } else if (msg.type === "agent_status"){
      setAgentAttached(!!msg.attached);
      setAgentReason(msg.reason || null);
      refreshStatus();
    } else if (msg.type === "session_closed"){
      setClosedState(true, msg.reason || "session_closed");
      // Stop EventSource from reconnecting forever to the now-dead endpoint.
      transportEpoch += 1;
      closeConnections();
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
    if (bannerDismissed[key]){ bannerNotice.hide(); return; }
    document.getElementById("banner").classList.toggle("warn", !!warn);
    bannerNotice.show({ title: title, message: msg, onDismiss: function(){
      if (bannerKey) bannerDismissed[bannerKey] = true;
    } });
  }
  function clearBanner(){
    bannerKey = null;
    bannerNotice.hide();
  }
  function hasPendingAsks(){
    for (var k in nodes) if (nodes[k].status === "pending") return true;
    return false;
  }
export function refreshStatus(){
    var phase = sessionPhase();
    document.body.classList.toggle("agent-down", phase !== "live");
    document.body.classList.toggle("session-over", phase === "closed" || phase === "frozen");
    // Once the session is over the server is gone, so new asks can't be taken —
    // but every question already asked is saved and re-queued on reopen.
    var savedNote = hasPendingAsks() ? " Your unanswered questions are saved and will be answered there." : "";
    if (phase === "frozen"){
      clearBanner(); // a snapshot needs no liveness story — the copy explains itself
    } else if (phase === "closed"){
      if (closedReason === "done")
        setBanner("done", false, "Session ended", "This Rabbithole is saved. Reopen it from your terminal any time to keep exploring." + savedNote);
      else if (closedReason === "superseded")
        setBanner("superseded", false, "Reopened elsewhere", "This Rabbithole was just reopened in another tab — continue there. This view is now read-only.");
      else if (closedReason === "timeout")
        setBanner("timeout", true, "Session timed out", "Everything is saved. Reopen this Rabbithole from your terminal to continue." + savedNote);
      else
        setBanner("closed", true, "The agent has left", "Everything answered so far is saved. Reopen this Rabbithole from your terminal to keep exploring." + savedNote);
    } else if (phase === "away"){
      if (connLost)
        setBanner("connlost", true, "Connection lost", "Can't reach the agent session — it may have exited. Your Rabbithole is saved; reopen it from your terminal to continue.");
      else if (agentReason === "stalled")
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
