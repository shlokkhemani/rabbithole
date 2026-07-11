import { normalizePdfExtension } from "../core/pdf-shared.js";
import { openImageLightbox } from "./image-ux.js";
import { resolveAssetUrl } from "./renderer.js";
import { childrenOf } from "./core.js";
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
  var live = Array.from(rects).filter(function(r){ return r.width > 0 && r.height > 0; });
  if (!live.length || !pageRect.width || !pageRect.height) return null;
  var left = Math.min.apply(null, live.map(function(r){ return r.left; }));
  var top = Math.min.apply(null, live.map(function(r){ return r.top; }));
  var right = Math.max.apply(null, live.map(function(r){ return r.right; }));
  var bottom = Math.max.apply(null, live.map(function(r){ return r.bottom; }));
  var clamp = function(v){ return Math.min(1, Math.max(0, v)); };
  var x = clamp((left - pageRect.left) / pageRect.width), y = clamp((top - pageRect.top) / pageRect.height);
  return { x: x, y: y, w: Math.min(clamp((right-left)/pageRect.width), 1-x), h: Math.min(clamp((bottom-top)/pageRect.height), 1-y) };
}

export function mountPdfView(container, node) {
  var pdf = normalizePdfExtension(node);
  if (!pdf || pdf.converted) return null;
  var markdown = String(node.markdown ?? node.md ?? "");
  container.className = "doc-content rh-pdf";
  var disposed = false;
  var pageEls = [];
  var observer = null;
  var resizeObserver = null;
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
    pdf.lines.forEach(function(line, lineIndex){
      if (line.p !== page.n) return;
      var span = document.createElement("span"); span.dataset.line = lineIndex; span.textContent = markdown.slice(line.s, line.e);
      span.style.left = (line.x*100) + "%"; span.style.top = (line.y*100) + "%"; span.style.height = (line.h*100) + "%";
      textLayer.appendChild(span);
    });
    pageEl.appendChild(textLayer);
    var marks = document.createElement("div"); marks.className = "rh-pdf-marks"; pageEl.appendChild(marks);
    pageEls.push(pageEl);
    container.appendChild(pageEl);
    if (typeof ResizeObserver === "function") {
      if (!resizeObserver) resizeObserver = new ResizeObserver(function(entries){ entries.forEach(function(entry){ fitText(entry.target); }); });
      resizeObserver.observe(pageEl);
    } else setTimeout(function(){ fitText(pageEl); }, 0);
    if (typeof IntersectionObserver === "function") {
      if (!observer) observer = new IntersectionObserver(function(entries){
        entries.forEach(function(entry){ if (entry.isIntersecting) mountWindow(pageEls.indexOf(entry.target)); });
      }, { root: null, rootMargin: "100% 0px" });
      observer.observe(pageEl);
    }
  });
  childrenOf(node.id).forEach(function(child){ if (child.origin && child.origin.anchor && child.origin.anchor.pdf) mountPdfRectMark(container, child.origin.anchor, child.id, "rh-pdf-mark " + (child.status === "answered" ? "mark-ready" : "mark-pending")); });
  container.addEventListener("mouseup", function(e){
    var sel = window.getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    var range = sel.getRangeAt(0), pageEl = e.target.closest && e.target.closest(".rh-pdf-page");
    if (!pageEl || !pageEl.contains(range.startContainer) || !pageEl.contains(range.endContainer)) return;
    var offsets = pdfSelectionOffsets(range, pdf.lines), rect = normalizeRectUnion(range.getClientRects(), pageEl.getBoundingClientRect());
    if (!offsets || offsets.end <= offsets.start || !rect) return;
    showAskFromSelection({ parentId: node.id, selectedText: sel.toString().trim(), mdStart: offsets.start, mdEnd: offsets.end,
      pdfAnchor: { page: Number(pageEl.dataset.page), rect: rect }, anchorRectEl: { getBoundingClientRect: function(){ return range.getBoundingClientRect(); }, contextElement: pageEl } });
  });
  mountWindow(0);
  return function dispose() {
    if (disposed) return;
    disposed = true;
    if (observer) observer.disconnect();
    if (resizeObserver) resizeObserver.disconnect();
    pageEls.forEach(function(pageEl){
      var img = pageEl.querySelector("img");
      if (img) { img.removeAttribute("src"); img.remove(); }
    });
  };
}
