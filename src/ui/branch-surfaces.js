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
  updateSince
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
import { downloadSnapshot } from "./snapshot.js";

var branchHooks = {
  post: function(){ return Promise.resolve({ ok: true }); }
};

export function registerBranchHooks(hooks) {
  Object.assign(branchHooks, hooks || {});
}

  // ===========================================================================
  // HOVER PEEK — glance at a branch from its mark without leaving the page
  // ===========================================================================
  var peekTimer = 0, peekFor = null;
export function initBranchSurfaces(){
  readerMain.addEventListener("mouseover", onReaderMarkMouseover);
  readerMain.addEventListener("mouseout", onReaderMarkMouseout);
  peekEl.addEventListener("mouseleave", function(){ hidePeek(); });
  peekEl.addEventListener("click", function(){
    var kid = peekFor && nodes[peekFor];
    hidePeek();
    if (kid) openNode(kid.id);
  });
  document.getElementById("r-share").addEventListener("click", function(e){ e.stopPropagation(); toggleShare(e.currentTarget); });
  document.getElementById("t-share").addEventListener("click", function(e){ e.stopPropagation(); toggleShare(e.currentTarget); });
  document.getElementById("sm-doc").addEventListener("click", onCopyDoc);
  document.getElementById("sm-trail").addEventListener("click", onCopyTrail);
  document.getElementById("sm-export").addEventListener("click", onExportSnapshot);
  document.getElementById("sm-synth").addEventListener("click", function(e){
    closeShare();
    synthesize(motionSourceFromEvent(e));
  });
  document.getElementById("cf-keep").addEventListener("click", hideConfirm);
  document.getElementById("cf-remove").addEventListener("click", function(){
    var node = confirmFor && nodes[confirmFor];
    hideConfirm();
    if (node) deleteBranch(node);
  });
}

export function hidePeek(){
    if (peekTimer){ clearTimeout(peekTimer); peekTimer = 0; }
    peekFor = null;
    peekEl.classList.remove("visible");
  }
  function showPeek(mark){
    var kid = nodes[mark.dataset.child];
    if (!kid || kid.status !== "answered") return;
    peekFor = kid.id;
    var badge = (kid.origin && kid.origin.synthesis) ? '<span class="lens-badge">✦ Synthesis</span>'
      : (kid.origin && kid.origin.lens) ? lensBadgeHtml(kid.origin.lens) : "";
    peekEl.innerHTML = '<div class="peek-title">' + (isUnread(kid) ? '<span class="pal-dot"></span>' : "") +
      '<span>' + esc(kid.title || "Untitled") + '</span>' + badge + '</div>' +
      '<div class="peek-body md">' + (kid.html || "") + '</div>' +
      '<div class="peek-hint">Click to open</div>';
    if (typeof mountVisuals === "function"){
      var peekBody = peekEl.querySelector(".peek-body");
      if (peekBody) mountVisuals(peekBody, "peek:" + kid.id);
    }
    var r = mark.getBoundingClientRect();
    var top = r.bottom + 8;
    if (top + peekEl.offsetHeight + 10 > window.innerHeight) top = Math.max(10, r.top - peekEl.offsetHeight - 8);
    peekEl.style.left = Math.min(window.innerWidth - 360, Math.max(10, r.left)) + "px";
    peekEl.style.top = top + "px";
    peekEl.classList.add("visible");
    setSurfaceOrigin(peekEl, r);
  }
  function onReaderMarkMouseover(e){
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (!m) return;
    var kid = nodes[m.dataset.child];
    if (!kid || kid.status !== "answered") return;
    if (peekTimer) clearTimeout(peekTimer);
    peekTimer = setTimeout(function(){ peekTimer = 0; showPeek(m); }, 220);
  }
  function onReaderMarkMouseout(e){
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (!m) return;
    if (peekTimer){ clearTimeout(peekTimer); peekTimer = 0; }
    setTimeout(function(){
      if (!peekEl.matches(":hover") && !readerMain.querySelector("mark[data-child]:hover")) hidePeek();
    }, 80);
  }

  // ===========================================================================
  // SHARE — export, copy as Markdown, synthesize
  // ===========================================================================
  var shareOpen = false;
export function toggleShare(anchor){
    if (shareOpen){ closeShare(); return; }
    // A frozen snapshot can't export (it IS the export) or reach an agent.
    var noAgent = frozen || closed;
    document.getElementById("sm-export").style.display = frozen ? "none" : "";
    document.getElementById("sm-sep2").style.display = noAgent ? "none" : "";
    document.getElementById("sm-synth").style.display = noAgent ? "none" : "";
    var r = anchor.getBoundingClientRect();
    shareMenu.style.left = Math.min(window.innerWidth - shareMenu.offsetWidth - 10, Math.max(10, r.right - shareMenu.offsetWidth)) + "px";
    shareMenu.style.top = (r.bottom + 8) + "px";
    shareOpen = true;
    shareMenu.classList.add("visible");
    setSurfaceOrigin(shareMenu, r);
  }
export function closeShare(){ shareOpen = false; shareMenu.classList.remove("visible"); }

  function copyText(text, okMsg){
    function done(){ flashHint(okMsg); }
    function legacy(){
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch(err){}
      document.body.removeChild(ta);
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
	    flashHint("Preparing snapshot...");
	    downloadSnapshot().then(function(){
	      flashHint("Snapshot downloading — a single file that opens anywhere.");
	    }, function(){
	      flashHint("Couldn't prepare the snapshot.");
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
    flashHint("✦ Synthesizing this journey — it will appear as a branch of the root document.");
  }

  // ===========================================================================
  // DELETE — remove a branch (and its subtree) after an inline confirm
  // ===========================================================================
  var confirmFor = null;
export function confirmDelete(node, anchor){
    if (closed){
      flashHint(frozen ? "This is a read-only snapshot." : "Session ended — changes can't be saved anymore.");
      return;
    }
    confirmFor = node.id;
    var subCount = countSubtree(node.id) - 1;
    document.getElementById("cf-msg").textContent = subCount > 0
      ? "Remove this branch and " + subCount + " inside it?"
      : "Remove this branch?";
    var r = anchor.getBoundingClientRect();
    confirmEl.style.left = Math.min(window.innerWidth - confirmEl.offsetWidth - 10, Math.max(10, r.right - confirmEl.offsetWidth)) + "px";
    confirmEl.style.top = (r.bottom + 8) + "px";
    confirmEl.classList.add("visible");
    setSurfaceOrigin(confirmEl, r);
  }
export function hideConfirm(){ confirmFor = null; confirmEl.classList.remove("visible"); }
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
