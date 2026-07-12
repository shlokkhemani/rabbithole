import { enclosedPdfLines, normalizePdfExtension } from "../core/pdf-shared.js";
import { openImageLightbox } from "./image-ux.js";
import { resolveAssetUrl } from "./renderer.js";
import { childrenOf, postBrowserEvent } from "./core.js";
import { mountPdfRectMark } from "./text-marks.js";
import { showAskFromSelection } from "./ask-followups.js";

export function pdfSelectionOffsets(range, spans) {
  var startSpan = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer.closest("span[data-line]");
  var endSpan = range.endContainer.nodeType === 3 ? range.endContainer.parentElement : range.endContainer.closest("span[data-line]");
  if (!startSpan || !endSpan) return null;
  var startLine = spans[Number(startSpan.dataset.line)], endLine = spans[Number(endSpan.dataset.line)];
  if (!startLine || !endLine) return null;
  var start = startLine.s + Math.max(0, Math.min(startLine.e - startLine.s, range.startOffset));
  var end = endLine.s + Math.max(0, Math.min(endLine.e - endLine.s, range.endOffset));
  return start <= end ? { start: start, end: end } : { start: end, end: start };
}

export function normalizeRectUnion(rects, pageRect) {
  var left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity, found = false;
  for (var i = 0; i < rects.length; i++){
    var r = rects[i];
    if (r.width <= 0 || r.height <= 0) continue;
    found = true;
    left = Math.min(left, r.left); top = Math.min(top, r.top);
    right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
  }
  if (!found || !pageRect.width || !pageRect.height) return null;
  var clamp = function(v){ return Math.min(1, Math.max(0, v)); };
  var x = clamp((left - pageRect.left) / pageRect.width), y = clamp((top - pageRect.top) / pageRect.height);
  return { x: x, y: y, w: Math.min(clamp((right-left)/pageRect.width), 1-x), h: Math.min(clamp((bottom-top)/pageRect.height), 1-y) };
}

export function mountPdfView(container, node) {
  var pdf = normalizePdfExtension(node);
  if (!pdf || pdf.converted || pdf.converting) return null;
  var markdown = String(node.markdown ?? node.md ?? "");
  container.className = "doc-content rh-pdf";
  var disposed = false;
  var pageEls = [];
  var observer = null;
  var resizeObserver = null;
  var toolbarScrollRoot = null, toolbarScrollHandler = null, toolbarBindTimer = 0, toolbarPlaceholder = null, toolbarNode = null;
  var boxButton = null, boxHint = null, boxMode = false, draft = null, askWatcher = null;
  var scanned = pdf.pages.length > 0 && pdf.lines.length === 0;
  var spansByPage = [];
  function setBoxMode(active) {
    boxMode = !!active;
    container.classList.toggle("rh-pdf-box-mode", boxMode);
    if (boxButton) { boxButton.classList.toggle("active", boxMode); boxButton.setAttribute("aria-pressed", boxMode ? "true" : "false"); }
    if (boxHint) boxHint.classList.toggle("visible", boxMode);
    if (!boxMode && draft) { draft.remove(); draft = null; }
  }
  // The settled box stays on the page as the visual anchor of the open ask,
  // then retires the moment the ask closes — submit or cancel alike (a submit
  // replaces it with the pending rect mark).
  function retireBoxWhenAskCloses(boxEl) {
    var askEl = document.getElementById("ask");
    if (askWatcher) askWatcher();
    if (!askEl || typeof MutationObserver !== "function") { boxEl.remove(); return; }
    var watcher = new MutationObserver(function(){ if (!askEl.classList.contains("visible")) askWatcher && askWatcher(); });
    askWatcher = function(){ watcher.disconnect(); boxEl.remove(); askWatcher = null; };
    watcher.observe(askEl, { attributes: true, attributeFilter: ["class"] });
  }
  function fitText(pageEl) {
    var spans = pageEl.querySelectorAll(".rh-pdf-textlayer span");
    for (var i = 0; i < spans.length; i++) {
      var span = spans[i], line = pdf.lines[Number(span.dataset.line)];
      span.style.fontSize = (line.h * pageEl.clientHeight) + "px";
      span.style.width = "auto"; span.style.transform = "none";
      var natural = span.scrollWidth || 1, target = line.w * pageEl.clientWidth;
      span.style.transform = "scaleX(" + (target / natural) + ")";
    }
  }
  function mountWindow(index) {
    for (var i = 0; i < pageEls.length; i++) {
      var img = pageEls[i].querySelector("img");
      if (Math.abs(i - index) <= 2) {
        if (!img) {
          img = document.createElement("img");
          img.className = "rh-pdf-img";
          img.alt = "Page " + pdf.pages[i].n;
          img.src = resolveAssetUrl(pdf.pages[i].asset);
          img.addEventListener("click", function(e){ openImageLightbox(e.currentTarget.currentSrc || e.currentTarget.src, e.currentTarget.alt, e.currentTarget); });
          pageEls[i].appendChild(img);
        }
      } else if (img) img.remove();
    }
  }
  pdf.pages.forEach(function(page, index) {
    var pageEl = document.createElement("div");
    pageEl.className = "rh-pdf-page";
    pageEl.dataset.page = page.n;
    pageEl.style.aspectRatio = page.w + " / " + page.h;
    var textLayer = document.createElement("div"); textLayer.className = "rh-pdf-textlayer";
    var pageSpans = []; spansByPage.push(pageSpans);
    pdf.lines.forEach(function(line, lineIndex){
      if (line.p !== page.n) return;
      var span = document.createElement("span"); span.dataset.line = lineIndex; span.textContent = markdown.slice(line.s, line.e);
      span.style.left = (line.x*100) + "%"; span.style.top = (line.y*100) + "%"; span.style.height = (line.h*100) + "%";
      textLayer.appendChild(span);
      if (span.firstChild) pageSpans.push({ index: lineIndex, span: span });
    });
    pageEl.appendChild(textLayer);
    var marks = document.createElement("div"); marks.className = "rh-pdf-marks"; pageEl.appendChild(marks);
    pageEls.push(pageEl);
    container.appendChild(pageEl);
    if (typeof ResizeObserver === "function") {
      if (!resizeObserver) resizeObserver = new ResizeObserver(function(entries){ entries.forEach(function(entry){ fitText(entry.target); }); });
      resizeObserver.observe(pageEl);
    } else setTimeout(function(){ fitText(pageEl); }, 0);
    pageEl.addEventListener("pointerdown", function(event) {
      if (!boxMode || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      var pageRect = pageEl.getBoundingClientRect();
      var startX = Math.min(1, Math.max(0, (event.clientX-pageRect.left)/pageRect.width));
      var startY = Math.min(1, Math.max(0, (event.clientY-pageRect.top)/pageRect.height));
      draft = document.createElement("div"); draft.className = "rh-pdf-box-draft"; pageEl.appendChild(draft);
      pageEl.setPointerCapture?.(event.pointerId);
      function move(moveEvent) {
        var x = Math.min(1, Math.max(0, (moveEvent.clientX-pageRect.left)/pageRect.width));
        var y = Math.min(1, Math.max(0, (moveEvent.clientY-pageRect.top)/pageRect.height));
        var rect = { x: Math.min(startX,x), y: Math.min(startY,y), w: Math.abs(x-startX), h: Math.abs(y-startY) };
        draft.style.left=(rect.x*100)+"%"; draft.style.top=(rect.y*100)+"%"; draft.style.width=(rect.w*100)+"%"; draft.style.height=(rect.h*100)+"%";
        draft._rect = rect;
      }
      function up(upEvent) {
        pageEl.removeEventListener("pointermove", move); pageEl.removeEventListener("pointerup", up); pageEl.removeEventListener("pointercancel", cancel);
        var rect = draft && draft._rect, boxEl = draft;
        draft = null; setBoxMode(false);
        // A sub-8px drop is a stray click, not a region — vanish quietly.
        var bounds = pageEl.getBoundingClientRect();
        if (!rect || rect.w * bounds.width < 8 || rect.h * bounds.height < 8) { if (boxEl) boxEl.remove(); return; }
        var enclosed = enclosedPdfLines(pdf.lines, page.n, rect, markdown);
        boxEl.classList.add("settled");
        var shown = showAskFromSelection({ parentId: node.id, selectedText: enclosed.text, mdStart: enclosed.start, mdEnd: enclosed.end,
          pdfAnchor: { page: page.n, rect: rect }, anchorRectEl: boxEl });
        if (shown) retireBoxWhenAskCloses(boxEl); else boxEl.remove();
        upEvent.preventDefault(); upEvent.stopPropagation();
      }
      function cancel() { pageEl.removeEventListener("pointermove", move); pageEl.removeEventListener("pointerup", up); pageEl.removeEventListener("pointercancel", cancel); setBoxMode(false); }
      pageEl.addEventListener("pointermove", move); pageEl.addEventListener("pointerup", up); pageEl.addEventListener("pointercancel", cancel);
    });
    if (typeof IntersectionObserver === "function") {
      if (!observer) observer = new IntersectionObserver(function(entries){
        entries.forEach(function(entry){ if (entry.isIntersecting) mountWindow(pageEls.indexOf(entry.target)); });
      }, { root: null, rootMargin: "100% 0px" });
      observer.observe(pageEl);
    }
  });
  var toolbar = document.createElement("div"); toolbar.className = "rh-pdf-toolbar";
  var regionActions = document.createElement("div"); regionActions.className = "rh-pdf-toolbar-actions rh-pdf-region-actions"; toolbar.appendChild(regionActions);
  var toolbarInfo = document.createElement("div"); toolbarInfo.className = "rh-pdf-toolbar-info"; toolbar.appendChild(toolbarInfo);
  if (scanned) {
    var scannedNote = document.createElement("span"); scannedNote.className = "rh-pdf-scanned-note";
    scannedNote.textContent = "No selectable text · Ask about an area or create a text version";
    toolbarInfo.appendChild(scannedNote);
  }
  boxHint = document.createElement("span"); boxHint.className = "rh-pdf-box-hint";
  boxHint.textContent = "Drag over anything you want to ask about · Esc cancels";
  toolbarInfo.appendChild(boxHint);
  var documentActions = document.createElement("div"); documentActions.className = "rh-pdf-toolbar-actions rh-pdf-document-actions"; toolbar.appendChild(documentActions);
  boxButton = document.createElement("button"); boxButton.type = "button"; boxButton.className = "node-btn rh-pdf-box-toggle";
  boxButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.6 2.1"/></svg><span>Ask about an area</span>';
  boxButton.title = "Draw over a figure, table, or area to ask about it";
  boxButton.setAttribute("aria-label", "Ask about an area of the PDF"); boxButton.setAttribute("aria-pressed", "false");
  boxButton.addEventListener("click", function(event){ event.stopPropagation(); setBoxMode(!boxMode); }); regionActions.appendChild(boxButton);
  container.prepend(toolbar);
  if (!childrenOf(node.id).length) {
    var convertButton = document.createElement("button"); convertButton.type = "button"; convertButton.className = "node-btn rh-pdf-convert" + (scanned ? " primary" : "");
    convertButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h5l3 3v8H4z" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/><path d="M9 2.5v3h3M6 8h4M6 10.5h4" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Create text version</span>';
    convertButton.setAttribute("aria-label", "Create a searchable text version of this PDF");
    convertButton.title = "Turn every page into clean, searchable text while preserving figures";
    convertButton.addEventListener("click", function(event){ event.stopPropagation(); convertButton.disabled = true; postBrowserEvent({ type: "convert_pdf", node_id: node.id }).then(function(result){ if (!result?.ok) convertButton.disabled = false; }); });
    documentActions.appendChild(convertButton);
  }
  function moveToolbar(mutate, animate){
    var previous = toolbar.getAnimations ? toolbar.getAnimations().filter(function(item){ return item.id === "pdf-toolbar-dock"; }) : [];
    previous.forEach(function(item){ item.cancel(); });
    var from = toolbar.getBoundingClientRect();
    mutate();
    if (!animate || !toolbar.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    var to = toolbar.getBoundingClientRect();
    if (!from.width || !to.width) return;
    var movement = toolbar.animate([
      { transform: "translateY(" + (from.top - to.top) + "px)" },
      { transform: "translateY(0)" }
    ], { duration: 140, easing: "cubic-bezier(.2,0,0,1)" });
    movement.id = "pdf-toolbar-dock";
  }
  toolbarBindTimer = setTimeout(function(){
    if (disposed) return;
    toolbarScrollRoot = container.closest(".node-body") || container.closest("#reader-main");
    if (!toolbarScrollRoot) return;
    toolbarNode = toolbarScrollRoot.classList.contains("node-body") ? toolbarScrollRoot.closest(".node") : null;
    toolbarScrollHandler = function(initial){
      var shouldDock = !!toolbarNode && (toolbarPlaceholder ? toolbarScrollRoot.scrollTop > 4 : toolbarScrollRoot.scrollTop > 20);
      if (shouldDock && !toolbarPlaceholder) {
        moveToolbar(function(){
          toolbarPlaceholder = document.createElement("div"); toolbarPlaceholder.className = "rh-pdf-toolbar-placeholder";
          toolbarPlaceholder.style.height = toolbar.offsetHeight + "px";
          toolbar.before(toolbarPlaceholder);
          toolbarNode.insertBefore(toolbar, toolbarScrollRoot);
          toolbarNode.classList.add("pdf-toolbar-docked"); toolbar.classList.add("is-stuck");
        }, initial !== true);
      } else if (!shouldDock && toolbarPlaceholder) {
        moveToolbar(function(){
          toolbarPlaceholder.replaceWith(toolbar); toolbarPlaceholder = null;
          toolbarNode.classList.remove("pdf-toolbar-docked"); toolbar.classList.remove("is-stuck");
        }, initial !== true);
      }
    };
    toolbarScrollRoot.addEventListener("scroll", toolbarScrollHandler, { passive: true });
    toolbarScrollHandler(true);
  }, 0);
  // Capture phase: while region-select is active, Escape means "exit region
  // select" and nothing else — the app-level Escape (open reader) must not fire.
  function onKeydown(event) { if (event.key === "Escape" && boxMode) { event.preventDefault(); event.stopPropagation(); setBoxMode(false); } }
  document.addEventListener("keydown", onKeydown, true);
  childrenOf(node.id).forEach(function(child){ if (child.origin && child.origin.anchor && child.origin.anchor.pdf) mountPdfRectMark(container, child.origin.anchor, child.id, "rh-pdf-mark " + (child.status === "answered" ? "mark-ready" : "mark-pending")); });
  // --- text selection engine --------------------------------------------------
  // Native DOM selection hit-tests the empty gaps between absolutely-positioned
  // line spans and resolves them in document order, so a drag inside one column
  // sweeps the neighboring column too. We own the selection instead: geometric,
  // column-aware hit-testing against the ingest line map, then a programmatic
  // Selection — the same model Chrome's built-in PDF viewer uses.
  function caretAtPoint(pageEl, pageSpans, clientX, clientY) {
    var rect = pageEl.getBoundingClientRect();
    if (!rect.width || !rect.height || !pageSpans.length) return null;
    var nx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    var ny = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    var best = null, bestScore = Infinity;
    for (var i = 0; i < pageSpans.length; i++) {
      var candidate = pdf.lines[pageSpans[i].index];
      var dx = nx < candidate.x ? candidate.x - nx : nx > candidate.x + candidate.w ? nx - (candidate.x + candidate.w) : 0;
      var dy = ny < candidate.y ? candidate.y - ny : ny > candidate.y + candidate.h ? ny - (candidate.y + candidate.h) : 0;
      // Horizontal misses cost 3x vertical ones: a pointer in the gap between
      // lines of one column must snap within that column, never across the gutter.
      var hx = dx * rect.width * 3, vy = dy * rect.height, score = hx * hx + vy * vy;
      if (score < bestScore) { bestScore = score; best = pageSpans[i]; }
    }
    var text = best && best.span.firstChild;
    if (!text) return null;
    var line = pdf.lines[best.index], len = text.nodeValue.length, offset;
    if (nx <= line.x) offset = 0;
    else if (nx >= line.x + line.w) offset = len;
    else {
      offset = nativeCaretOffset(text, clientX, rect.top + (line.y + line.h / 2) * rect.height);
      if (offset == null) offset = Math.max(0, Math.min(len, Math.round(((nx - line.x) / line.w) * len)));
    }
    return { node: text, offset: offset };
  }
  // Exact glyph-boundary offsets come from the browser's own caret probe, aimed
  // at the line's vertical center so the gap above/below the glyphs can't miss.
  function nativeCaretOffset(textNode, clientX, clientY) {
    var pos = null;
    if (document.caretPositionFromPoint) { var p = document.caretPositionFromPoint(clientX, clientY); if (p) pos = { node: p.offsetNode, offset: p.offset }; }
    else if (document.caretRangeFromPoint) { var r = document.caretRangeFromPoint(clientX, clientY); if (r) pos = { node: r.startContainer, offset: r.startOffset }; }
    return pos && pos.node === textNode ? pos.offset : null;
  }
  function wordBoundsIn(text, index) {
    var isWord = function(ch){ return !!ch && !/[\s.,;:!?()\[\]{}"'`]/.test(ch); };
    var i = Math.max(0, Math.min(index, text.length - 1));
    if (!isWord(text[i]) && isWord(text[i - 1])) i--;
    if (!isWord(text[i])) return { start: i, end: Math.min(text.length, i + 1) };
    var start = i, end = i + 1;
    while (start > 0 && isWord(text[start - 1])) start--;
    while (end < text.length && isWord(text[end])) end++;
    return { start: start, end: end };
  }
  function maybeAskFromSelection() {
    var sel = window.getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    var live = sel.getRangeAt(0);
    var startEl = live.startContainer.nodeType === 3 ? live.startContainer.parentElement : live.startContainer;
    var pageEl = startEl && startEl.closest ? startEl.closest(".rh-pdf-page") : null;
    if (!pageEl || !container.contains(pageEl) || !pageEl.contains(live.endContainer)) return;
    // Clone the range: the live one collapses the moment focus moves into the
    // ask box, and the popup keeps re-anchoring against this rect while open.
    var range = live.cloneRange();
    var offsets = pdfSelectionOffsets(range, pdf.lines), rect = normalizeRectUnion(range.getClientRects(), pageEl.getBoundingClientRect());
    if (!offsets || offsets.end <= offsets.start || !rect) return;
    showAskFromSelection({ parentId: node.id, selectedText: markdown.slice(offsets.start, offsets.end).trim(), mdStart: offsets.start, mdEnd: offsets.end,
      pdfAnchor: { page: Number(pageEl.dataset.page), rect: rect }, range: range,
      anchorRectEl: { getBoundingClientRect: function(){ return range.getBoundingClientRect(); }, contextElement: pageEl } });
  }
  container.addEventListener("mousedown", function(event) {
    if (boxMode || event.button !== 0 || disposed) return;
    if (event.target.closest && event.target.closest(".rh-pdf-toolbar, .rh-pdf-mark")) return;
    var pageEl = event.target.closest ? event.target.closest(".rh-pdf-page") : null;
    event.preventDefault();
    var pageIndex = pageEl ? pageEls.indexOf(pageEl) : -1;
    var sel = window.getSelection();
    if (!sel || pageIndex < 0 || !spansByPage[pageIndex].length) { if (sel && !sel.isCollapsed) sel.removeAllRanges(); return; }
    var anchor = caretAtPoint(pageEl, spansByPage[pageIndex], event.clientX, event.clientY);
    if (!anchor) return;
    if (event.detail >= 2) {
      var bounds = event.detail === 2 ? wordBoundsIn(anchor.node.nodeValue, anchor.offset) : { start: 0, end: anchor.node.nodeValue.length };
      sel.setBaseAndExtent(anchor.node, bounds.start, anchor.node, bounds.end);
    }
    var dragged = false, downX = event.clientX, downY = event.clientY, detail = event.detail;
    function move(moveEvent) {
      if (!dragged && Math.abs(moveEvent.clientX - downX) < 4 && Math.abs(moveEvent.clientY - downY) < 4) return;
      dragged = true;
      var focus = caretAtPoint(pageEl, spansByPage[pageIndex], moveEvent.clientX, moveEvent.clientY);
      if (focus) sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
      moveEvent.preventDefault();
    }
    function up(upEvent) {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      if (!dragged && detail === 1) { if (!sel.isCollapsed) sel.removeAllRanges(); return; }
      // A release outside the container never reaches the container's own mouseup.
      if (upEvent && !container.contains(upEvent.target)) maybeAskFromSelection();
    }
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
  container.addEventListener("mouseup", function(){ maybeAskFromSelection(); });
  mountWindow(0);
  return function dispose() {
    if (disposed) return;
    disposed = true;
    if (observer) observer.disconnect();
    if (resizeObserver) resizeObserver.disconnect();
    clearTimeout(toolbarBindTimer);
    if (toolbarScrollRoot && toolbarScrollHandler) toolbarScrollRoot.removeEventListener("scroll", toolbarScrollHandler);
    if (toolbarPlaceholder) toolbarPlaceholder.remove();
    toolbarNode?.classList.remove("pdf-toolbar-docked");
    document.removeEventListener("keydown", onKeydown, true);
    toolbar.remove(); setBoxMode(false);
    if (askWatcher) askWatcher();
    pageEls.forEach(function(pageEl){
      var img = pageEl.querySelector("img");
      if (img) { img.removeAttribute("src"); img.remove(); }
    });
  };
}
