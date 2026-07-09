import {
  confirmEl,
  canvasBuilt,
  childrenOf,
  currentNodeId,
  esc,
  flashHint,
  frozen,
  closed,
  goToNode,
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
  clearCanvasSelection,
  drawEdges,
  renderVisibility,
  revealNode,
  selectedCanvasNodes
} from "./canvas-view.js";
import {
  openNode,
  removeMarks,
  removeThreadItem,
  renderBreadcrumb,
  renderSidebar
} from "./reader.js";
import { mountVisuals } from "./visuals.js";
import { downloadSnapshot, downloadSnapshotJson } from "./snapshot.js";
import { activateFocusTrap } from "./focus-trap.js";

var branchHooks = {
  post: function(){ return Promise.resolve({ ok: true }); },
  exportPortable: null
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
  document.getElementById("t-synth-prompt").addEventListener("click", function(e){ openSynthesisPrompt(motionSourceFromEvent(e)); });
  document.getElementById("synth-send").addEventListener("click", function(e){ submitSelectedSynthesis(motionSourceFromEvent(e)); });
  document.getElementById("synth-cancel").addEventListener("click", closeSynthesisPrompt);
  document.getElementById("synth-close").addEventListener("click", closeSynthesisPrompt);
  document.getElementById("synth-text").addEventListener("input", updateSynthesisPromptState);
  document.getElementById("synth-mode").addEventListener("change", updateSynthesisModeCopy);
  document.getElementById("synth-text").addEventListener("keydown", function(e){
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)){ e.preventDefault(); submitSelectedSynthesis("keyboard"); }
    else if (e.key === "Escape"){ closeSynthesisPrompt(); }
  });
  document.addEventListener("rh-selection-change", updateSelectedSynthesisUi);
  document.getElementById("sm-doc").addEventListener("click", onCopyDoc);
  document.getElementById("sm-trail").addEventListener("click", onCopyTrail);
  document.getElementById("sm-export").addEventListener("click", onExportSnapshot);
  document.getElementById("sm-json").addEventListener("click", onExportSnapshotJson);
  document.getElementById("sm-portable").addEventListener("click", onExportPortable);
  document.getElementById("sm-synth-selected").addEventListener("click", function(e){
    closeShare();
    openSynthesisPrompt(motionSourceFromEvent(e));
  });
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
  updateSelectedSynthesisUi();
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
    var badge = (kid.origin && kid.origin.synthesis) ? '<span class="lens-badge">✦ ' + (kid.origin.synthesis_mode === "question_map" ? "Question Map" : "Synthesis") + '</span>'
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
  var shareOpen = false, shareTrap = null;
export function toggleShare(anchor){
    if (shareOpen){ closeShare(); return; }
    // A frozen snapshot can't export (it IS the export) or reach an agent.
    var noAgent = frozen || closed;
    document.getElementById("sm-export").style.display = frozen ? "none" : "";
    document.getElementById("sm-json").style.display = frozen ? "none" : "";
    document.getElementById("sm-portable").style.display = (!frozen && typeof branchHooks.exportPortable === "function") ? "" : "none";
    var selected = selectedCanvasNodes();
    document.getElementById("sm-sep2").style.display = noAgent ? "none" : "";
    document.getElementById("sm-synth-selected").style.display = noAgent ? "none" : "";
    document.getElementById("sm-synth-selected").disabled = selected.length < 2;
    document.getElementById("sm-synth-selected").querySelector(".sm-ic").textContent = selected.length >= 2 ? String(selected.length) : "◫";
    document.getElementById("sm-synth").style.display = noAgent ? "none" : "";
    var r = anchor.getBoundingClientRect();
    shareMenu.style.left = Math.min(window.innerWidth - shareMenu.offsetWidth - 10, Math.max(10, r.right - shareMenu.offsetWidth)) + "px";
    shareMenu.style.top = (r.bottom + 8) + "px";
    shareOpen = true;
    shareMenu.classList.add("visible");
    setSurfaceOrigin(shareMenu, r);
    if (shareTrap) shareTrap();
    shareTrap = activateFocusTrap(shareMenu, {
      initialFocus: shareMenu.querySelector("button"),
      onEscape: closeShare
    });
  }
export function closeShare(){
    shareOpen = false;
    shareMenu.classList.remove("visible");
    if (shareTrap){ shareTrap(); shareTrap = null; }
  }

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
    if (n.origin.synthesis) return n.origin.synthesis_mode === "question_map" ? "> ✦ Question Map from selected nodes\n\n" : "> ✦ Synthesis from selected nodes\n\n";
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
  function onExportSnapshotJson(){
    closeShare();
    flashHint("Preparing session JSON...");
    downloadSnapshotJson().then(function(){
      flashHint("Session JSON downloading.");
    }, function(){
      flashHint("Couldn't prepare the session JSON.");
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
    flashHint("✦ Synthesizing this journey — it will appear as a branch of the root document.");
  }

  function hasPendingSynthesis(){
    for (var k in nodes){
      var n = nodes[k];
      if (n.status === "pending" && n.origin && n.origin.synthesis) return n;
    }
    return null;
  }

  function updateSelectedSynthesisUi(){
    var selected = selectedCanvasNodes();
    var btn = document.getElementById("t-synth-prompt");
    var count = document.getElementById("t-synth-count");
    if (count) count.textContent = String(selected.length);
    if (btn) btn.disabled = closed || selected.length < 2;
    var panel = document.getElementById("synth-panel");
    if (panel && panel.classList.contains("visible")){
      var sc = document.getElementById("synth-count");
      if (sc) sc.textContent = String(selected.length);
      updateSynthesisPromptState();
      if (selected.length < 2) closeSynthesisPrompt();
    }
  }

  function openSynthesisPrompt(source){
    if (closed){ flashHint("Session ended — reopen this Rabbithole from your terminal first."); return; }
    var selected = selectedCanvasNodes();
    if (selected.length < 2){ flashHint("Select at least two nodes on the canvas first."); return; }
    var pending = hasPendingSynthesis();
    if (pending){
      flashHint("A synthesis is already being written…");
      goToNode(pending, source);
      return;
    }
    var panel = document.getElementById("synth-panel");
    var count = document.getElementById("synth-count");
    var text = document.getElementById("synth-text");
    var modeSelect = document.getElementById("synth-mode");
    if (count) count.textContent = String(selected.length);
    if (modeSelect && !modeSelect.value) modeSelect.value = "synthesis";
    updateSynthesisModeCopy();
    if (text && !text.value.trim()) text.value = defaultSynthesisPrompt(synthesisMode());
    panel.classList.add("visible");
    updateSynthesisPromptState();
    if (text) text.focus();
  }

  function closeSynthesisPrompt(){
    var panel = document.getElementById("synth-panel");
    if (panel) panel.classList.remove("visible");
  }

  function updateSynthesisPromptState(){
    var selected = selectedCanvasNodes();
    var text = document.getElementById("synth-text");
    var send = document.getElementById("synth-send");
    if (send) send.disabled = selected.length < 2 || !text || !text.value.trim();
  }

  function synthesisMode(){
    var modeSelect = document.getElementById("synth-mode");
    return modeSelect && modeSelect.value === "question_map" ? "question_map" : "synthesis";
  }

  function defaultSynthesisPrompt(mode){
    if (mode === "question_map") return "Map what these nodes answer, what remains unclear, and which next branches should be opened to close the gaps.";
    return "Synthesize only these nodes: connect them into one coherent argument, remove repetition, and close with practical next steps.";
  }

  function updateSynthesisModeCopy(){
    var text = document.getElementById("synth-text");
    var mode = synthesisMode();
    if (text){
      text.placeholder = mode === "question_map"
        ? "What should this question map focus on? e.g. Find gaps, tensions, and next branches for this research direction."
        : "What should the synthesis focus on? e.g. Turn these nodes into one thesis architecture proposal, keep tradeoffs and next steps.";
      var value = text.value.trim();
      if (!value || value === defaultSynthesisPrompt("synthesis") || value === defaultSynthesisPrompt("question_map")) text.value = defaultSynthesisPrompt(mode);
    }
    var send = document.getElementById("synth-send");
    if (send) send.title = mode === "question_map" ? "Create question map" : "Create synthesis";
    updateSynthesisPromptState();
  }

  function submitSelectedSynthesis(source){
    var text = document.getElementById("synth-text");
    var prompt = text ? text.value.trim() : "";
    if (!prompt){ updateSynthesisPromptState(); return; }
    synthesizeSelected(source, prompt, synthesisMode());
    closeSynthesisPrompt();
    if (text) text.value = "";
  }

  function selectedNodeMarkdown(n, index){
    var body = (n.md || "").trim();
    if (body.length > 8000) body = body.slice(0, 8000).trimEnd() + "\n\n[truncated]";
    return "## Source " + index + ": " + (n.title || "Untitled") + "\n\n" +
      "Node ID: " + n.id + "\n\n" +
      (body || "_(no markdown content)_");
  }

  function questionMapPrompt(prompt, sourceText){
    return "Build a Question Map ONLY from the selected Rabbithole nodes below. Do not summarize unrelated nodes.\n\n" +
      "Human focus prompt:\n" + prompt + "\n\n" +
      "Organize the result into these sections:\n" +
      "1. Answered questions\n" +
      "2. Open questions\n" +
      "3. Gaps or assumptions\n" +
      "4. Contradictions or tensions\n" +
      "5. Suggested next branches\n\n" +
      "For each suggested next branch, write the exact question to ask, say which selected source node(s) it should branch from, and explain why answering it would improve the map. Keep it actionable so the reader can open the next branches directly.\n\n" +
      "Selected source nodes:\n\n" + sourceText;
  }

  function synthesisPrompt(prompt, sourceText){
    return "Synthesize ONLY the selected Rabbithole nodes below. Do not summarize unrelated nodes.\n\nHuman synthesis prompt:\n" + prompt + "\n\nSelected source nodes:\n\n" + sourceText;
  }

  function synthesizeSelected(source, prompt, outputMode){
    if (closed){ flashHint("Session ended — reopen this Rabbithole from your terminal first."); return; }
    var root = nodes[rootId];
    if (!root) return;
    var pending = hasPendingSynthesis();
    if (pending){
      flashHint("A synthesis is already being written…");
      goToNode(pending, source);
      return;
    }
    var selected = selectedCanvasNodes();
    if (selected.length < 2){
      flashHint("Select at least two nodes on the canvas first.");
      return;
    }
    var sourceText = selected.map(function(n, i){ return selectedNodeMarkdown(n, i + 1); }).join("\n\n---\n\n");
    if (sourceText.length > 30000) sourceText = sourceText.slice(0, 30000).trimEnd() + "\n\n[remaining selected-node content truncated]";
    outputMode = outputMode === "question_map" ? "question_map" : "synthesis";
    var q = outputMode === "question_map" ? questionMapPrompt(prompt, sourceText) : synthesisPrompt(prompt, sourceText);
    var kid = sendFollowup(root, q, null, true, {
      title: outputMode === "question_map" ? "Question map" : "Selected synthesis",
      selectedText: (outputMode === "question_map" ? "Question map" : "Synthesis") + " requested from " + selected.length + " selected nodes.",
      synthesisMode: outputMode,
      synthesisSources: selected.map(function(n){ return n.id; })
    });
    clearCanvasSelection();
    if (mode === "canvas") revealNode(kid, source);
    flashHint(outputMode === "question_map" ? "✦ Mapping questions from " + selected.length + " selected nodes." : "✦ Synthesizing " + selected.length + " selected nodes.");
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
