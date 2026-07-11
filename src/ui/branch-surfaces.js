import {
  confirmEl,
  canvasBuilt,
  childrenOf,
  currentNodeId,
  esc,
  flashHint,
  frozen,
  closed,
  isUnread,
  lensBadgeHtml,
  lensLabel,
  lineageNodes,
  mode,
  motionSourceFromEvent,
  nodes,
  peekEl,
  playLandingCue,
  readerMain,
  refreshAmbient,
  rootId,
  setCurrentNodeId,
  setSurfaceOrigin,
  shareMenu,
  truncate,
  updateSince,
  world
} from "./core.js";
import { sendFollowup } from "./ask-followups.js";
import {
  clearEdgeHighlight,
  drawEdges,
  renderVisibility,
  revealNode
} from "./canvas-view.js";
import {
  openNode,
  removeMarks,
  removeThreadItem,
  renderBreadcrumb,
  renderSidebar
} from "./reader.js";
import { mountVisuals } from "./visuals.js";
import { openPopover } from "./primitives/popover.js";
import { anchorSurface } from "./overlay/anchor.js";
import { registerLayer } from "./overlay/layer-stack.js";
import { createCleanupScope } from "./lifecycle.js";

function defaultBranchHooks(){
  return {
    post: function(){ return Promise.resolve({ ok: true }); },
    exportSnapshot: null,
    exportPortable: null
  };
}

var branchHooks = defaultBranchHooks();
var branchScope = null;

export function registerBranchHooks(hooks) {
  Object.assign(branchHooks, hooks || {});
}

  // ===========================================================================
  // HOVER PEEK — glance at a branch from its mark without leaving the page
  // ===========================================================================
  var peekTimer = 0, peekFor = null, peekPosition = null, peekLayer = null;
export function initBranchSurfaces(){
  disposeBranchSurfaceResources(false);
  branchScope = createCleanupScope();
  try {
  branchScope.listen(readerMain, "mouseover", onReaderMarkMouseover);
  branchScope.listen(readerMain, "mouseout", onReaderMarkMouseout);
  branchScope.listen(world, "mouseover", onReaderMarkMouseover);
  branchScope.listen(world, "mouseout", onReaderMarkMouseout);
  branchScope.listen(readerMain, "focusin", onMarkFocusin);
  branchScope.listen(readerMain, "focusout", onMarkFocusout);
  branchScope.listen(world, "focusin", onMarkFocusin);
  branchScope.listen(world, "focusout", onMarkFocusout);
  branchScope.listen(peekEl, "mouseleave", function(){ hidePeek(); });
  branchScope.listen(peekEl, "click", function(){
    var kid = peekFor && nodes[peekFor];
    hidePeek();
    if (kid) openNode(kid.id);
  });
  branchScope.listen(document.getElementById("r-share"), "click", function(e){ e.stopPropagation(); toggleShare(e.currentTarget, e.detail === 0); });
  branchScope.listen(document.getElementById("t-share"), "click", function(e){ e.stopPropagation(); toggleShare(e.currentTarget, e.detail === 0); });
  branchScope.listen(shareMenu, "keydown", onShareMenuKeydown);
  branchScope.listen(document.getElementById("sm-doc"), "click", onCopyDoc);
  branchScope.listen(document.getElementById("sm-trail"), "click", onCopyTrail);
  branchScope.listen(document.getElementById("sm-export"), "click", onExportSnapshot);
  branchScope.listen(document.getElementById("sm-portable"), "click", onExportPortable);
  branchScope.listen(document.getElementById("sm-synth"), "click", function(e){
    closeShare();
    synthesize(motionSourceFromEvent(e));
  });
  branchScope.listen(document.getElementById("cf-keep"), "click", hideConfirm);
  branchScope.listen(document.getElementById("cf-remove"), "click", function(){
    var node = confirmFor && nodes[confirmFor];
    hideConfirm();
    if (node) deleteBranch(node);
  });
  return disposeBranchSurfaces;
  } catch (error) {
    disposeBranchSurfaces();
    throw error;
  }
}

export function disposeBranchSurfaces(){
  disposeBranchSurfaceResources(true);
}

function disposeBranchSurfaceResources(resetHooks){
  hidePeek();
  closeShare({ restoreFocus: false });
  hideConfirm({ restoreFocus: false });
  var scope = branchScope;
  branchScope = null;
  if (scope) scope.dispose();
  peekFor = null;
  shareOpen = false;
  shareAnchor = null;
  confirmFor = null;
  if (resetHooks) branchHooks = defaultBranchHooks();
}

export function hidePeek(){
    if (peekTimer){ clearTimeout(peekTimer); peekTimer = 0; }
    if (peekPosition){ peekPosition.dispose(); peekPosition = null; }
    if (peekLayer){ peekLayer({ restoreFocus: false }); peekLayer = null; }
    peekFor = null;
    peekEl.classList.remove("visible");
    peekEl.setAttribute("aria-hidden", "true");
  }
  function showPeek(mark){
    var kid = nodes[mark.dataset.child];
    if (!kid || kid.status !== "answered") return;
    hidePeek();
    peekFor = kid.id;
    peekEl.querySelector("[data-peek-unread]").hidden = !isUnread(kid);
    peekEl.querySelector("[data-peek-title]").textContent = kid.title || "Untitled";
    var badge = peekEl.querySelector("[data-peek-badge]");
    var badgeText = (kid.origin && kid.origin.synthesis) ? "✦ Synthesis"
      : (kid.origin && kid.origin.lens) ? lensLabel(kid.origin.lens) : "";
    badge.textContent = badgeText; badge.hidden = !badgeText;
    var peekBody = peekEl.querySelector("[data-peek-body]");
    var fragment = document.createRange().createContextualFragment(kid.html || "");
    peekBody.replaceChildren(fragment);
    if (typeof mountVisuals === "function"){
      mountVisuals(peekBody, "peek:" + kid.id);
    }
    peekEl.classList.add("visible");
    peekEl.setAttribute("aria-hidden", "false");
    setSurfaceOrigin(peekEl, mark.getBoundingClientRect());
    peekPosition = anchorSurface(mark, peekEl, { placement: "bottom-start" });
    peekLayer = registerLayer({ element: peekEl, trigger: mark, restoreFocus: false,
      closeOnOutsidePointer: false, onClose: hidePeek });
  }
  function onReaderMarkMouseover(e){
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (!m) return;
    var kid = nodes[m.dataset.child];
    if (!kid || kid.status !== "answered") return;
    if (peekTimer) clearTimeout(peekTimer);
    peekTimer = branchScope
      ? branchScope.timeout(function(){ peekTimer = 0; showPeek(m); }, 220)
      : 0;
  }
  function onReaderMarkMouseout(e){
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (!m) return;
    if (peekTimer){ clearTimeout(peekTimer); peekTimer = 0; }
    if (!branchScope) return;
    branchScope.timeout(function(){
      if (!peekEl.matches(":hover") && !readerMain.querySelector("mark[data-child]:hover")) hidePeek();
    }, 80);
  }
  function onMarkFocusin(e){
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (!m) return;
    var kid = nodes[m.dataset.child];
    if (!kid || kid.status !== "answered") return;
    if (peekTimer) clearTimeout(peekTimer);
    peekTimer = branchScope
      ? branchScope.timeout(function(){ peekTimer = 0; if (document.activeElement === m) showPeek(m); }, 220)
      : 0;
  }
  function onMarkFocusout(e){
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (!m) return;
    if (peekTimer){ clearTimeout(peekTimer); peekTimer = 0; }
    if (!branchScope) return;
    branchScope.timeout(function(){
      if (!peekEl.matches(":hover") && document.activeElement !== m) hidePeek();
    }, 0);
  }

  // ===========================================================================
  // SHARE — export, copy as Markdown, synthesize
  // ===========================================================================
  var shareOpen = false, shareAnchor = null, sharePopover = null;
  function visibleShareItems(){
    return Array.prototype.slice.call(shareMenu.querySelectorAll('[role="menuitem"]')).filter(function(item){
      return item.style.display !== "none";
    });
  }
  function focusShareItem(item){
    visibleShareItems().forEach(function(candidate){ candidate.tabIndex = candidate === item ? 0 : -1; });
    if (item) item.focus();
  }
  function onShareMenuKeydown(e){
    var items = visibleShareItems();
    if (!items.length) return;
    var index = items.indexOf(document.activeElement), target = null;
    if (e.key === "ArrowDown") target = items[(index + 1 + items.length) % items.length];
    else if (e.key === "ArrowUp") target = items[(index - 1 + items.length) % items.length];
    else if (e.key === "Home") target = items[0];
    else if (e.key === "End") target = items[items.length - 1];
    else if (e.key === "Enter" || e.key === " ") {
      if (index < 0) return;
      e.preventDefault();
      items[index].click();
      return;
    } else if (e.key === "Tab") {
      closeShare();
      return;
    } else return;
    e.preventDefault();
    focusShareItem(target);
  }
export function toggleShare(anchor, openedByKeyboard){
    if (shareOpen){ closeShare(); return; }
    // A frozen snapshot can't export (it IS the export) or reach an agent.
    var noAgent = frozen || closed;
    document.getElementById("sm-export").style.display = frozen ? "none" : "";
    document.getElementById("sm-portable").style.display = (!frozen && typeof branchHooks.exportPortable === "function") ? "" : "none";
    document.getElementById("sm-sep2").style.display = noAgent ? "none" : "";
    document.getElementById("sm-synth").style.display = noAgent ? "none" : "";
    var items = visibleShareItems();
    items.forEach(function(item, index){ item.tabIndex = index === 0 ? 0 : -1; });
    shareAnchor = anchor;
    shareOpen = true;
    shareMenu.classList.add("visible");
    setSurfaceOrigin(shareMenu, anchor.getBoundingClientRect());
    sharePopover = openPopover({ trigger: anchor, surface: shareMenu, placement: "bottom-end",
      initialFocus: openedByKeyboard ? items[0] : null,
      onClose: closeShare
    });
  }
export function closeShare(settings){
    shareOpen = false;
    shareMenu.classList.remove("visible");
    if (sharePopover){ sharePopover.close(settings); sharePopover = null; }
    shareAnchor = null;
  }

  function copyText(text, okMsg){
    function done(){ flashHint(okMsg); }
    function legacy(){
      var previousFocus = document.activeElement;
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch(err){}
      document.body.removeChild(ta);
      if (previousFocus && previousFocus.isConnected){
        try { previousFocus.focus(); } catch(err){}
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done, function(){ legacy(); done(); });
    } else { legacy(); done(); }
  }
  // Markdown reconstructions — the raw source rides in hydration/broadcasts.
  function originLine(n){
    if (!n.origin) return "";
    if (n.origin.synthesis) return "> ✦ Synthesis of the whole Rabbithole\n\n";
    var ask = n.origin.lens ? lensLabel(n.origin.lens) : (n.origin.question || "");
    if (n.origin.selected_text) return "> Asked about: “" + n.origin.selected_text + "”" + (ask ? " — " + ask : "") + "\n\n";
    return ask ? "> Follow-up — " + ask + "\n\n" : "";
  }
  function docMarkdown(n, depth){
    var h = "#";
    for (var i = 0; i < Math.min(depth, 3); i++) h += "#";
    var body = (n.md || "").trim() || "_(still being written)_";
    return h + " " + (n.title || "Untitled") + "\n\n" + originLine(n) + body + "\n";
  }
  function trailMarkdown(id){
    var path = lineageNodes(id), parts = [];
    for (var i = 0; i < path.length; i++) parts.push(docMarkdown(path[i], i));
    return parts.join("\n---\n\n");
  }
  function onCopyDoc(){
    closeShare();
    var n = nodes[currentNodeId];
    if (!n) return;
    copyText(docMarkdown(n, 0), "Copied “" + truncate(n.title || "Untitled", 40) + "” as Markdown");
  }
  function onCopyTrail(){
    closeShare();
    var path = lineageNodes(currentNodeId);
    copyText(trailMarkdown(currentNodeId), path.length === 1
      ? "Copied this document as Markdown"
      : "Copied the trail — " + path.length + " documents");
  }
	  function onExportSnapshot(){
	    closeShare();
	    if (typeof branchHooks.exportSnapshot !== "function"){
	      flashHint("This snapshot is already portable.");
	      return;
	    }
	    flashHint("Preparing snapshot...");
	    Promise.resolve(branchHooks.exportSnapshot()).then(function(){
	      flashHint("Snapshot downloading — a single file that opens anywhere.");
	    }, function(){
	      flashHint("Couldn't prepare the snapshot.");
	    });
	  }
  function onExportPortable(){
    closeShare();
    if (typeof branchHooks.exportPortable !== "function"){
      flashHint("Rabbithole export is only available in the web app.");
      return;
    }
    flashHint("Preparing Rabbithole export...");
    Promise.resolve()
      .then(function(){ return branchHooks.exportPortable(); })
      .then(function(result){
        var name = result && result.filename ? " " + result.filename : "";
        flashHint("Rabbithole export downloading." + name);
      }, function(){
        flashHint("Couldn't prepare the Rabbithole export.");
      });
  }
export function synthesize(source){
    if (closed){ flashHint("Session ended — reopen this Rabbithole from your terminal first."); return; }
    var root = nodes[rootId];
    if (!root) return;
    for (var k in nodes){
      var n = nodes[k];
      if (n.status === "pending" && n.origin && n.origin.synthesis){
        flashHint("A synthesis is already being written…");
        goToNode(n, source);
        return;
      }
    }
    var q = "Step back and write the synthesis of this whole Rabbithole so far: the key ideas we explored, how they connect, and the takeaways worth keeping. Make it a standalone summary of the journey.";
    var kid = sendFollowup(root, q, null, true);
    if (mode === "canvas") revealNode(kid, source);
    flashHint("✦ Synthesizing this journey — it will branch from where this Rabbithole began.");
  }

  // ===========================================================================
  // DELETE — remove a branch (and its subtree) after an inline confirm
  // ===========================================================================
  var confirmFor = null, confirmPopover = null;
export function confirmDelete(node, anchor){
    if (closed){
      flashHint(frozen ? "This is a read-only snapshot." : "Session ended — changes can't be saved anymore.");
      return;
    }
    var subCount = countSubtree(node.id) - 1;
    document.getElementById("cf-msg").textContent = subCount > 0
      ? "Remove this branch and " + subCount + " inside it?"
      : "Remove this branch?";
    hideConfirm({ restoreFocus: false });
    confirmFor = node.id;
    confirmEl.classList.add("visible");
    setSurfaceOrigin(confirmEl, anchor.getBoundingClientRect());
    confirmPopover = openPopover({ trigger: anchor, surface: confirmEl, placement: "bottom-end",
      initialFocus: document.getElementById("cf-keep"), onClose: hideConfirm });
  }
export function hideConfirm(settings){
    confirmFor = null; confirmEl.classList.remove("visible");
    if (confirmPopover){ var popover = confirmPopover; confirmPopover = null; popover.close(settings); }
  }
  function countSubtree(id){
    var c = 1;
    childrenOf(id).forEach(function(k){ c += countSubtree(k.id); });
    return c;
  }
  function collectSubtree(id, out){
    out.push(id);
    childrenOf(id).forEach(function(k){ collectSubtree(k.id, out); });
    return out;
  }
  function deleteBranch(node){
    var title = node.title || "Untitled";
    var ids = collectSubtree(node.id, []);
    branchHooks.post({ type: "delete_node", node_id: node.id });
    removeNodesLocal(ids, node.parent_id);
    flashHint(ids.length > 1
      ? "Removed “" + truncate(title, 40) + "” and " + (ids.length - 1) + " inside it"
      : "Removed “" + truncate(title, 40) + "”");
  }
export function removeNodesLocal(ids, parentId){
    var currentGone = false;
    for (var i = 0; i < ids.length; i++){
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
    if (currentGone){
      setCurrentNodeId((parentId && nodes[parentId]) ? parentId : rootId);
      if (mode === "reader") openNode(currentNodeId);
    }
    if (canvasBuilt){ renderVisibility(); drawEdges(); }
    if (mode === "reader"){ renderBreadcrumb(); renderSidebar(); }
    refreshAmbient();
    updateSince();
  }
