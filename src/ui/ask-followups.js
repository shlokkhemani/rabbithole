import {
  BRANCH_FOLLOWUP,
  BRANCH_SELECTION,
  DEFAULT_CHILD,
  LENSES,
  ask,
  askGo,
  askText,
  canvasBuilt,
  childrenOf,
  closed,
  composerInner,
  composerSend,
  composerText,
  connLost,
  currentNodeId,
  easeOutMotion,
  flashHint,
  frozen,
  agentAttached,
  lensLabel,
  mode,
  motionSourceFromEvent,
  nextOrder,
  nodeOrder,
  nodes,
  readerMain,
  refreshAmbient,
  setSurfaceOrigin,
  shouldReduceMotion,
  truncate,
  uuid
} from "./core.js";
import {
  placeChild as sharedPlaceChild,
  subtreeBounds as sharedSubtreeBounds
} from "../core/layout.js";
import {
  autoGrowEl,
  createNodeEl,
  drawEdges,
  effH,
  revealNode,
  renderVisibility,
  scheduleEdges
} from "./canvas-view.js";
import {
  buildThreadItem,
  charOffset,
  ensureThread,
  removeMarks,
  removeThreadItem,
  renderSidebar,
  wrapInContainer
} from "./reader.js";

var askHooks = {
  post: function(){ return Promise.resolve({ ok: true }); },
  closeShare: function(){},
  hideConfirm: function(){},
  hidePeek: function(){}
};

export function registerAskHooks(hooks) {
  Object.assign(askHooks, hooks || {});
}

  // ===========================================================================
  // ASK (shared by both views)
  // ===========================================================================
export function initAskFollowups(){
  document.addEventListener("mousedown", function(e){
    var c = e.target && e.target.closest ? function(sel){ return e.target.closest(sel); } : function(){ return null; };
    if (!c("#sharemenu") && !c("#r-share") && !c("#t-share")) askHooks.closeShare();
    if (!c("#confirm")) askHooks.hideConfirm();
    if (!c("#peek") && !c("mark[data-child]")) askHooks.hidePeek();
    if (inAsk(e)) return;
    hideAsk();
  });
  document.addEventListener("mouseup", function(e){ if (inAsk(e)) return; setTimeout(maybeShowAsk, 0); });
  askGo.addEventListener("click", function(e){ submitAsk(null, motionSourceFromEvent(e)); });
  document.getElementById("ask-lenses").addEventListener("click", function(e){
    var b = e.target.closest ? e.target.closest(".lens") : null;
    if (b) submitAsk(b.getAttribute("data-lens"), motionSourceFromEvent(e));
  });
  askText.addEventListener("input", function(){ autoGrowEl(askText, 110); });
  askText.addEventListener("keydown", onAskTextKeydown);
  composerText.addEventListener("input", function(){ autoGrowComposer(); updateComposerState(); });
  composerText.addEventListener("keydown", function(e){
    if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); submitFollowup("keyboard"); }
  });
  composerSend.addEventListener("click", function(e){ submitFollowup(motionSourceFromEvent(e)); });
  readerMain.addEventListener("wheel", interruptScrollAnimation, { passive: true });
  readerMain.addEventListener("touchstart", interruptScrollAnimation, { passive: true });
  readerMain.addEventListener("pointerdown", interruptScrollAnimation, { passive: true });
  readerMain.addEventListener("scroll", function(){ if (performance.now() > scrollAnimIgnoreUntil) cancelScrollAnimation(); }, { passive: true });
  document.addEventListener("keydown", interruptScrollAnimation);
}

function inAsk(e){ return e.target && e.target.closest && e.target.closest("#ask"); }

  function maybeShowAsk(){
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    var anchor = sel.anchorNode && sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentNode : sel.anchorNode;
    var dc = anchor && anchor.closest ? anchor.closest(".doc-content") : null;
    if (!dc) return;
    var parentId = dc.dataset.nodeId;
    if (!parentId || !nodes[parentId] || nodes[parentId].status === "pending") return;
    // Asks stay open while the agent is merely away (they queue server-side and
    // are answered when it returns) — only a fully closed session can't take them.
    if (closed){
      flashHint(frozen ? "This is a read-only snapshot — asking needs the live Rabbithole."
        : "Session ended — reopen this Rabbithole from your terminal to keep asking.");
      return;
    }
    var range = sel.getRangeAt(0);
    // Both endpoints must live inside this same document — a selection dragged
    // out into the sidebar/another card would otherwise yield offsets past the
    // doc's text (no inline mark, a bad persisted anchor).
    if (!dc.contains(range.startContainer) || !dc.contains(range.endContainer)) return;
    var startOff = charOffset(dc, range.startContainer, range.startOffset);
    var endOff = charOffset(dc, range.endContainer, range.endOffset);
    if (endOff <= startOff) return;
    pendingAsk = { parentId: parentId, container: dc, selectedText: sel.toString().trim(),
                   startOff: startOff, endOff: endOff, range: range.cloneRange() };
    paintAskHighlight(pendingAsk.range);
    askText.value = "";
    askText.placeholder = "Ask about this… ↵ = Explain";
    var rect = range.getBoundingClientRect();
    ask.style.left = Math.min(window.innerWidth - 392, Math.max(10, rect.left)) + "px";
    ask.style.top = Math.min(window.innerHeight - 200, rect.bottom + 8) + "px";
    ask.classList.add("visible");
    setSurfaceOrigin(ask, rect);
    // Grow only once visible — scrollHeight reads 0 inside display:none.
    autoGrowEl(askText, 110);
    askText.focus();
  }
  var pendingAsk = null;
export function hideAsk(){ ask.classList.remove("visible"); pendingAsk = null; clearAskHighlight(); }
  // Custom Highlight API — keeps the selected text visibly marked while the popup
  // has focus. Best-effort: browsers without it just fall back to today's look.
  function paintAskHighlight(range){
    try { if (window.Highlight && window.CSS && CSS.highlights) CSS.highlights.set("rh-ask", new Highlight(range)); } catch(e){}
  }
  function clearAskHighlight(){
    try { if (window.CSS && CSS.highlights) CSS.highlights.delete("rh-ask"); } catch(e){}
  }

  var LENS_KEYS = { "1": "explain", "2": "eli5", "3": "example", "4": "deeper" };
  function onAskTextKeydown(e){
    if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); submitAsk(null, "keyboard"); }
    else if (e.key === "Escape"){ hideAsk(); }
    // Number keys are lens shortcuts only while the box is empty — once the
    // human starts typing a question, digits are just digits.
    else if (askText.value === "" && !e.metaKey && !e.ctrlKey && !e.altKey && LENS_KEYS[e.key]){
      e.preventDefault();
      submitAsk(LENS_KEYS[e.key], "keyboard");
    }
  }

  function submitAsk(lensKey, source){
    if (!pendingAsk || closed) return;
    var parent = nodes[pendingAsk.parentId];
    if (!parent){ hideAsk(); return; }
    var lens = (lensKey && LENSES[lensKey]) ? lensKey : null;
    var question = lens ? LENSES[lens].q : askText.value.trim();
    var requestId = uuid(), childId = uuid();
    var pos = placeChild(parent, BRANCH_SELECTION);
    var anchor = { offset_start: pendingAsk.startOff, offset_end: pendingAsk.endOff };
    var node = {
	      id: childId, parent_id: parent.id,
	      title: lens ? lensLabel(lens) : (question ? truncate(question, 48) : "…"),
	      html: "", md: "",
	      base_url: parent.base_url || null,
	      base_url_source: parent.base_url ? "inherited" : null,
	      read: false,
      origin: { selected_text: pendingAsk.selectedText, question: question, lens: lens, anchor: anchor, branch_type: BRANCH_SELECTION },
      x: pos.x, y: pos.y, w: DEFAULT_CHILD.w, h: DEFAULT_CHILD.h, font_scale: 1, collapsed: false,
      status: "pending", _order: nextOrder(), _startTs: Date.now()
    };
    nodes[childId] = node;
    if (canvasBuilt){ createNodeEl(node, true); renderVisibility(); drawEdges(); }

    // Mark inline in whichever views currently render the parent doc. Wrap via
    // offsets (always text-node endpoints) — a live Range can end on an element
    // boundary, which the text-walker can't terminate on.
    if (mode === "reader"){
      var rdc = readerMain.querySelector('.doc-content[data-node-id="' + parent.id + '"]');
      wrapInContainer(rdc, anchor, childId, "hl mark-pending");
      if (currentNodeId === parent.id) renderSidebar();
    }
    if (parent.bodyEl){ wrapInContainer(parent.bodyEl.querySelector(".doc-content"), anchor, childId, "hl mark-pending"); scheduleEdges(); }

    var sel = window.getSelection(); if (sel) sel.removeAllRanges();
    hideAsk();
    askHooks.post({ type: "branch_request", request_id: requestId, node_id: childId, parent_id: parent.id,
           selected_text: node.origin.selected_text, question: question, lens: lens, anchor: anchor,
           branch_type: BRANCH_SELECTION,
           position: { x: node.x, y: node.y }, size: { w: node.w, h: node.h } })
      .then(function(res){ if (!res || !res.ok) rollbackBranch(node); });
    // On the canvas, the new card must never leave the viewport silently —
    // pan just enough that you see where your question went.
    revealNode(node, source);
    refreshAmbient();
  }

  // ---------- follow-up composer ----------
export function updateComposerState(){
    var current = nodes[currentNodeId];
    // A missing agent doesn't disable asking — questions queue server-side and
    // are answered when it returns. Only a closed session (server gone) does.
    var down = closed || !current || current.status === "pending";
    composerText.disabled = down;
    composerInner.classList.toggle("disabled", down);
    if (frozen) composerText.placeholder = "Read-only snapshot — open the live Rabbithole to keep asking";
    else if (closed) composerText.placeholder = "Session ended — reopen this Rabbithole from your terminal; saved questions are answered there";
    else if (current && current.status === "pending") composerText.placeholder = "This answer is still being written…";
    else if (connLost || !agentAttached) composerText.placeholder = "The agent is away — questions are saved and answered when it returns…";
    else composerText.placeholder = "Ask a follow-up about this document…";
    composerSend.disabled = down || !composerText.value.trim();
  }
  function autoGrowComposer(){ autoGrowEl(composerText, 140); }

  // Shared follow-up submission: from the reader composer or a card's docked one.
  // The thread turn is only appended when the parent is the document currently
  // open in the reader — otherwise it appears on the next open. A synthesis ask
  // rides the same path but renders as a distinct branch node, not a chat turn.
export function sendFollowup(parent, question, lens, synthesis, opts){
    opts = opts || {};
    var requestId = uuid(), childId = uuid();
    var pos = placeChild(parent, BRANCH_FOLLOWUP);
    var node = {
	      id: childId, parent_id: parent.id,
	      title: opts.title || (synthesis ? "Synthesis" : lens ? lensLabel(lens) : truncate(question, 48)),
	      html: "", md: "",
	      base_url: parent.base_url || null,
	      base_url_source: parent.base_url ? "inherited" : null,
	      read: false,
      origin: { selected_text: opts.selectedText || "", question: question, lens: lens, synthesis: !!synthesis, synthesis_mode: opts.synthesisMode || null, synthesis_sources: opts.synthesisSources || null, anchor: null, branch_type: BRANCH_FOLLOWUP },
      x: pos.x, y: pos.y, w: DEFAULT_CHILD.w, h: DEFAULT_CHILD.h, font_scale: 1, collapsed: false,
      status: "pending", _order: nextOrder(), _startTs: Date.now()
    };
    nodes[childId] = node;
    if (canvasBuilt){ createNodeEl(node, true); renderVisibility(); drawEdges(); }
    if (currentNodeId === parent.id && mode === "reader"){
      if (synthesis) renderSidebar();
      else {
        var t = ensureThread();
        if (t) t.appendChild(buildThreadItem(node));
      }
    }
    var payload = { type: "branch_request", request_id: requestId, node_id: childId, parent_id: parent.id,
           selected_text: opts.selectedText || "", question: question, lens: lens, anchor: null,
           branch_type: BRANCH_FOLLOWUP,
           position: { x: node.x, y: node.y }, size: { w: node.w, h: node.h } };
    if (synthesis) payload.synthesis = true;
    if (opts.synthesisMode) payload.synthesis_mode = opts.synthesisMode;
    if (opts.synthesisSources) payload.synthesis_sources = opts.synthesisSources;
    askHooks.post(payload).then(function(res){ if (!res || !res.ok) rollbackBranch(node); });
    refreshAmbient();
    return node;
  }

  // scrollTo({behavior:"smooth"}) proved unreliable here, so the one deliberate
  // scroll in the app (submit → your new question) is driven by hand. rAF never
  // fires in a hidden window — jump instantly there instead of never arriving.
  var scrollAnimId = 0, scrollAnimIgnoreUntil = 0;
export function cancelScrollAnimation(){ scrollAnimId++; }
  function setAnimatedScrollTop(el, value){
    scrollAnimIgnoreUntil = performance.now() + 80;
    el.scrollTop = value;
  }
export function animateScroll(el, target, source){
    var myId = ++scrollAnimId;
    if (document.hidden || shouldReduceMotion() || source !== "pointer"){ el.scrollTop = target; return; }
    var s = el.scrollTop, t0 = performance.now(), D = 240;
    function step(t){
      if (myId !== scrollAnimId) return;
      var p = Math.min(1, (t - t0) / D), k = easeOutMotion(p);
      setAnimatedScrollTop(el, s + (target - s) * k);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function interruptScrollAnimation(){ cancelScrollAnimation(); }
  function submitFollowup(source){
    if (closed){ flashHint(frozen ? "This is a read-only snapshot." : "Session ended — reopen this Rabbithole from your terminal to continue."); return; }
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

  // Undo an optimistic branch whose request the server rejected/never received.
  // No-op if the node is already gone, or if an answer raced in ahead of the
  // failed-POST callback (don't delete a node the agent actually answered).
export function rollbackBranch(node){
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
    flashHint("Couldn't reach the agent — that ask was undone.");
  }

export function subtreeBounds(node){
    return sharedSubtreeBounds(node, { childrenOf: childrenOf, effH: effH, sort: nodeOrder });
  }
export function placeChild(parent, branchType){
    return sharedPlaceChild(parent, branchType, {
      childrenOf: childrenOf,
      effH: effH,
      sort: nodeOrder,
      childSize: DEFAULT_CHILD
    });
  }
