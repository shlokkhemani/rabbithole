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
  currentNodeId,
  flashHint,
  frozen,
  lensLabel,
  mode,
  motionSourceFromEvent,
  nextOrder,
  nodeOrder,
  nodes,
  readerMain,
  registerNode,
  refreshAmbient,
  shouldReduceMotion,
  sessionPhase,
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
  ensureThread,
  renderSidebar
} from "./reader.js";
import { charOffset, mountPdfRectMark, wrapInContainer } from "./text-marks.js";
import { easeOutMotion } from "./easing.js";
import { openAnchoredSurface } from "./overlay/anchor.js";
import { cancelFrame, createModuleLifecycle, nextFrame } from "./lifecycle.js";
import { applyComposerState } from "./composer-state.js";
import { teardownNode } from "./node-teardown.js";

function defaultAskHooks(){
  return {
    post: function(){ return Promise.resolve({ ok: true }); },
  };
}

var askLifecycle = createModuleLifecycle({ defaults: defaultAskHooks });

export function registerAskHooks(hooks) {
  askLifecycle.register(hooks);
}

  // ===========================================================================
  // ASK (shared by both views)
  // ===========================================================================
export function initAskFollowups(){
  disposeAskFollowupResources(false);
  var askScope = askLifecycle.beginInit();
  askScope.listen(document, "mouseup", function(e){
    if (inAsk(e)) return;
    if (usesMobileAskSurface()) queueMobileAsk(80);
    else askScope.timeout(maybeShowAsk, 0);
  });
  askScope.listen(document, "selectionchange", function(){
    if (usesMobileAskSurface()) queueMobileAsk(140);
  });
  askScope.listen(document, "touchend", function(e){
    if (!inAsk(e) && usesMobileAskSurface()) queueMobileAsk(80);
  }, { passive: true });
  askScope.listen(askGo, "click", function(e){ submitAsk(null, motionSourceFromEvent(e)); });
  askScope.listen(document.getElementById("ask-lenses"), "click", function(e){
    var b = e.target.closest ? e.target.closest(".lens") : null;
    if (b) submitAsk(b.getAttribute("data-lens"), motionSourceFromEvent(e));
  });
  askScope.listen(askText, "input", function(){ autoGrowEl(askText, 110); });
  askScope.listen(askText, "keydown", onAskTextKeydown);
  askScope.listen(ask, "transitionend", function(e){ if (e.target === ask && askPosition) askPosition.update(); });
  askScope.listen(composerText, "input", function(){ autoGrowComposer(); updateComposerState(); });
  askScope.listen(composerText, "keydown", function(e){
    if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); submitFollowup("keyboard"); }
  });
  askScope.listen(composerSend, "click", function(e){ submitFollowup(motionSourceFromEvent(e)); });
  askScope.listen(readerMain, "wheel", interruptScrollAnimation, { passive: true });
  askScope.listen(readerMain, "touchstart", interruptScrollAnimation, { passive: true });
  askScope.listen(readerMain, "pointerdown", interruptScrollAnimation, { passive: true });
  askScope.listen(readerMain, "scroll", function(){ if (performance.now() > scrollAnimIgnoreUntil) cancelScrollAnimation(); }, { passive: true });
  askScope.listen(document, "keydown", interruptScrollAnimation);
  return disposeAskFollowups;
}

function inAsk(e){ return e.target && e.target.closest && e.target.closest("#ask"); }

  var askPosition = null, askTabOwner = null, askOwnerCleanup = null;
  var mobileSelectionTimer = 0, ignoreMobileSelectionUntil = 0;

  function usesMobileAskSurface(){
    return !!(window.matchMedia && (window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(max-width: 760px)").matches));
  }
  function queueMobileAsk(delay){
    if (Date.now() < ignoreMobileSelectionUntil || !askLifecycle.scope) return;
    if (mobileSelectionTimer) clearTimeout(mobileSelectionTimer);
    mobileSelectionTimer = askLifecycle.scope.timeout(function(){ mobileSelectionTimer = 0; maybeShowAsk(); }, delay);
  }

  function selectionOwner(dc){
    return (dc && dc.closest && dc.closest(".node")) || readerMain;
  }
  function onAskOwnerKeydown(e){
    if (e.key !== "Tab" || e.shiftKey || !ask.classList.contains("visible")) return;
    var active = document.activeElement;
    if (active !== document.body && active !== askTabOwner && !askTabOwner.contains(active)) return;
    e.preventDefault(); askText.focus();
  }
  function focusAskOwner(owner){
    if (!owner || !owner.isConnected) return;
    if (!owner.hasAttribute("tabindex")) owner.setAttribute("tabindex", "-1");
    try { owner.focus({ preventScroll: true }); } catch(e){ owner.focus(); }
  }

  function maybeShowAsk(){
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    var anchor = sel.anchorNode && sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentNode : sel.anchorNode;
    var dc = anchor && anchor.closest ? anchor.closest(".doc-content") : null;
    if (!dc) return;
    if (dc.classList.contains("rh-pdf")) return;
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
    if (ask.classList.contains("visible")) hideAsk();
    pendingAsk = { parentId: parentId, container: dc, selectedText: sel.toString().trim(),
                   startOff: startOff, endOff: endOff, range: range.cloneRange() };
    paintAskHighlight(pendingAsk.range);
    askText.value = "";
    askText.placeholder = "Ask about this… ↵ = Explain";
    ask.classList.add("visible");
    var owner = selectionOwner(dc);
    var virtualAnchor = { getBoundingClientRect: function(){ return pendingAsk.range.getBoundingClientRect(); }, contextElement: dc };
    askTabOwner = owner;
    askOwnerCleanup = askLifecycle.scope
      ? askLifecycle.scope.listen(document, "keydown", onAskOwnerKeydown)
      : function(){ document.removeEventListener("keydown", onAskOwnerKeydown); };
    // The box takes focus on open so the question can be typed immediately —
    // focusing collapses the native selection, so the cloned Range plus the
    // painted highlight carry it, and Escape puts the selection back.
    openAskSurface(virtualAnchor, owner);
  }
  var pendingAsk = null;
export function showAskFromSelection(options){
    var parentId = options && options.parentId;
    var parent = parentId && nodes[parentId];
    if (!parent || parent.status === "pending" || parent.extensions?.pdf?.converting) return false;
    if (closed){
      flashHint(frozen ? "This is a read-only snapshot — asking needs the live Rabbithole."
        : "Session ended — reopen this Rabbithole from your terminal to keep asking.");
      return false;
    }
    var anchorEl = options.anchorRectEl;
    // Virtual anchors (a selection range) carry their element as contextElement.
    var anchorNode = anchorEl && anchorEl.closest ? anchorEl : anchorEl && anchorEl.contextElement ? anchorEl.contextElement : null;
    pendingAsk = { parentId: parentId, container: anchorNode && anchorNode.closest ? anchorNode.closest(".doc-content") : null,
      selectedText: String(options.selectedText || "").trim(), startOff: options.mdStart,
      endOff: options.mdEnd, pdfAnchor: options.pdfAnchor || null, range: options.range || null };
    if (pendingAsk.range) paintAskHighlight(pendingAsk.range);
    askText.value = "";
    askText.placeholder = "Ask about this… ↵ = Explain";
    ask.classList.add("visible");
    var owner = selectionOwner(pendingAsk.container);
    askTabOwner = owner;
    askOwnerCleanup = askLifecycle.scope
      ? askLifecycle.scope.listen(document, "keydown", onAskOwnerKeydown)
      : function(){ document.removeEventListener("keydown", onAskOwnerKeydown); };
    openAskSurface(anchorEl, owner);
    return true;
  }
  function openAskSurface(anchor, owner){
    var mobile = usesMobileAskSurface();
    ask.classList.toggle("mobile-sheet", mobile);
    askText.placeholder = mobile ? "Ask about this…" : "Ask about this… ↵ = Explain";
    var surfaceAnchor = mobile ? mobileViewportAnchor(owner) : anchor;
    askPosition = openAnchoredSurface({ surface: ask, anchor: surfaceAnchor,
      placement: mobile ? "top-center" : "bottom-start", restoreFocus: false, preventOutsidePointerDefault: false,
      onClose: function(reason){
        var escapeOwner = reason === "escape" ? owner : null;
        var keepRange = reason === "escape" && pendingAsk ? pendingAsk.range : null;
        hideAsk();
        if (escapeOwner) focusAskOwner(escapeOwner);
        restoreSelectionRange(keepRange);
      } });
    autoGrowEl(askText, 110); // Must run after the surface leaves display:none.
    if (!mobile) askText.focus({ preventScroll: true });
  }
  function mobileViewportAnchor(owner){
    return { contextElement: owner, getBoundingClientRect: function(){
      var viewport = window.visualViewport;
      var left = viewport ? viewport.offsetLeft : 0;
      var top = viewport ? viewport.offsetTop : 0;
      var width = viewport ? viewport.width : window.innerWidth;
      var height = viewport ? viewport.height : window.innerHeight;
      var bottom = top + height;
      return { left: left, right: left + width, top: bottom, bottom: bottom,
        width: width, height: 0, x: left, y: bottom };
    } };
  }
  function restoreSelectionRange(range){
    if (!range) return;
    ignoreMobileSelectionUntil = Date.now() + 300;
    try { var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); } catch(e){}
  }
export function hideAsk(){
    if (askPosition){ askPosition.dispose(); askPosition = null; }
    if (askOwnerCleanup){ var cleanup = askOwnerCleanup; askOwnerCleanup = null; cleanup(); }
    askTabOwner = null;
    ask.classList.remove("visible"); pendingAsk = null; clearAskHighlight();
  }

export function disposeAskFollowups(){
    disposeAskFollowupResources(true);
  }

  function disposeAskFollowupResources(resetHooks){
    hideAsk();
    cancelScrollAnimation();
    askLifecycle.dispose(resetHooks);
    pendingAsk = null;
    askTabOwner = null;
    askOwnerCleanup = null;
    if (mobileSelectionTimer) clearTimeout(mobileSelectionTimer);
    mobileSelectionTimer = 0;
    ignoreMobileSelectionUntil = 0;
    scrollAnimId = 0;
    scrollAnimIgnoreUntil = 0;
    askText.value = "";
    composerText.value = "";
  }
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
    // Number keys are lens shortcuts only while the box is empty — once the
    // human starts typing a question, digits are just digits.
    else if (askText.value === "" && !e.metaKey && !e.ctrlKey && !e.altKey && LENS_KEYS[e.key]){
      e.preventDefault();
      submitAsk(LENS_KEYS[e.key], "keyboard");
    }
  }

  function retirePdfConversionAction(parent){
    parent?.bodyEl?.querySelector(".rh-pdf-convert")?.remove();
    if (mode === "reader") readerMain.querySelector('.doc-content[data-node-id="' + parent.id + '"] .rh-pdf-convert')?.remove();
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
    if (pendingAsk.pdfAnchor) anchor.pdf = pendingAsk.pdfAnchor;
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
    registerNode(node);
    retirePdfConversionAction(parent);
    if (canvasBuilt){ createNodeEl(node, true); renderVisibility(); drawEdges(); }

    // Mark inline in whichever views currently render the parent doc. Wrap via
    // offsets (always text-node endpoints) — a live Range can end on an element
    // boundary, which the text-walker can't terminate on.
    if (pendingAsk.pdfAnchor) {
      if (mode === "reader") mountPdfRectMark(readerMain.querySelector('.doc-content[data-node-id="' + parent.id + '"]'), anchor, childId, "rh-pdf-mark mark-pending");
      if (parent.bodyEl) mountPdfRectMark(parent.bodyEl.querySelector(".doc-content"), anchor, childId, "rh-pdf-mark mark-pending");
      scheduleEdges();
    } else if (mode === "reader"){
      var rdc = readerMain.querySelector('.doc-content[data-node-id="' + parent.id + '"]');
      wrapInContainer(rdc, anchor, childId, "hl mark-pending");
      if (currentNodeId === parent.id) renderSidebar();
    }
    if (parent.bodyEl){ wrapInContainer(parent.bodyEl.querySelector(".doc-content"), anchor, childId, "hl mark-pending"); scheduleEdges(); }

    var sel = window.getSelection(); if (sel) sel.removeAllRanges();
    hideAsk();
    askLifecycle.hooks.post({ type: "branch_request", request_id: requestId, node_id: childId, parent_id: parent.id,
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
    applyComposerState(
      { text: composerText, send: composerSend, wrap: composerInner },
      { phase: sessionPhase(), pending: !current || current.status === "pending" || !!current.extensions?.pdf?.converting },
      { frozen: "Read-only snapshot — open the live Rabbithole to keep asking",
        closed: "Session ended — reopen this Rabbithole from your terminal; saved questions are answered there",
        pending: "This answer is still being written…",
        away: "The agent is away — questions are saved and answered when it returns…",
        live: "Ask a follow-up about this document…" }
    );
  }
  function autoGrowComposer(){ autoGrowEl(composerText, 140); }

  // Shared follow-up submission: from the reader composer or a card's docked one.
  // The thread turn is only appended when the parent is the document currently
  // open in the reader — otherwise it appears on the next open. A synthesis ask
  // rides the same path but renders as a distinct branch node, not a chat turn.
export function sendFollowup(parent, question, lens, synthesis){
    if (parent?.extensions?.pdf?.converting) return null;
    var requestId = uuid(), childId = uuid();
    var pos = placeChild(parent, BRANCH_FOLLOWUP);
    var node = {
	      id: childId, parent_id: parent.id,
	      title: synthesis ? "Synthesis" : lens ? lensLabel(lens) : truncate(question, 48),
	      html: "", md: "",
	      base_url: parent.base_url || null,
	      base_url_source: parent.base_url ? "inherited" : null,
	      read: false,
      origin: { selected_text: "", question: question, lens: lens, synthesis: !!synthesis, anchor: null, branch_type: BRANCH_FOLLOWUP },
      x: pos.x, y: pos.y, w: DEFAULT_CHILD.w, h: DEFAULT_CHILD.h, font_scale: 1, collapsed: false,
      status: "pending", _order: nextOrder(), _startTs: Date.now()
    };
    registerNode(node);
    retirePdfConversionAction(parent);
    if (canvasBuilt){ createNodeEl(node, true); renderVisibility(); drawEdges(); }
    if (currentNodeId === parent.id && mode === "reader"){
      if (synthesis) renderSidebar();
      else {
        var t = ensureThread();
        if (t) t.appendChild(buildThreadItem(node));
      }
    }
    var payload = { type: "branch_request", request_id: requestId, node_id: childId, parent_id: parent.id,
           selected_text: "", question: question, lens: lens, anchor: null,
           branch_type: BRANCH_FOLLOWUP,
           position: { x: node.x, y: node.y }, size: { w: node.w, h: node.h } };
    if (synthesis) payload.synthesis = true;
    askLifecycle.hooks.post(payload).then(function(res){ if (!res || !res.ok) rollbackBranch(node); });
    refreshAmbient();
    return node;
  }

  // scrollTo({behavior:"smooth"}) proved unreliable here, so the one deliberate
  // scroll in the app (submit → your new question) is driven by hand. rAF never
  // fires in a hidden window — jump instantly there instead of never arriving.
  var scrollAnimId = 0, scrollAnimIgnoreUntil = 0, scrollFrameCleanup = null;
function cancelScrollAnimation(){ scrollAnimId++; clearScrollFrame(); }
  function clearScrollFrame(){
    if (!scrollFrameCleanup) return;
    var cleanup = scrollFrameCleanup;
    scrollFrameCleanup = null;
    cleanup();
  }
  function scheduleScrollFrame(callback){
    clearScrollFrame();
    var id = nextFrame(run);
    var cancel = function(){ cancelFrame(id); };
    scrollFrameCleanup = askLifecycle.scope ? askLifecycle.scope.addCleanup(cancel) : cancel;
    function run(timestamp){
      var cleanup = scrollFrameCleanup;
      scrollFrameCleanup = null;
      if (cleanup) cleanup();
      callback(timestamp);
    }
  }
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
      if (p < 1) scheduleScrollFrame(step);
    }
    scheduleScrollFrame(step);
  }
  function interruptScrollAnimation(){ cancelScrollAnimation(); }
  function submitFollowup(source){
    if (closed){ flashHint(frozen ? "This is a read-only snapshot." : "Session ended — reopen this Rabbithole from your terminal to continue."); return; }
    var parent = nodes[currentNodeId];
    if (!parent || parent.status === "pending" || parent.extensions?.pdf?.converting) return;
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
function rollbackBranch(node){
    var live = nodes[node.id];
    if (!live || live.status === "answered") return;
    teardownNode(node.id);
    if (canvasBuilt) drawEdges();
    if (mode === "reader" && currentNodeId === node.parent_id) renderSidebar();
    refreshAmbient();
    flashHint("Couldn't reach the agent — that ask was undone.");
  }

function subtreeBounds(node){
    return sharedSubtreeBounds(node, { childrenOf: childrenOf, effH: effH, sort: nodeOrder });
  }
function placeChild(parent, branchType){
    return sharedPlaceChild(parent, branchType, {
      childrenOf: childrenOf,
      effH: effH,
      sort: nodeOrder,
      childSize: DEFAULT_CHILD
    });
  }
