import { normalizePdfExtension } from "../core/pdf-shared.js";
import { openImageLightbox } from "./image-ux.js";
import { resolveAssetUrl } from "./renderer.js";

export function mountPdfView(container, node) {
  var pdf = normalizePdfExtension(node);
  if (!pdf || pdf.converted) return null;
  container.className = "doc-content rh-pdf";
  var disposed = false;
  var pageEls = [];
  var observer = null;
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
    pageEls.push(pageEl);
    container.appendChild(pageEl);
    if (typeof IntersectionObserver === "function") {
      if (!observer) observer = new IntersectionObserver(function(entries){
        entries.forEach(function(entry){ if (entry.isIntersecting) mountWindow(pageEls.indexOf(entry.target)); });
      }, { root: null, rootMargin: "100% 0px" });
      observer.observe(pageEl);
    }
  });
  mountWindow(0);
  return function dispose() {
    if (disposed) return;
    disposed = true;
    if (observer) observer.disconnect();
    pageEls.forEach(function(pageEl){
      var img = pageEl.querySelector("img");
      if (img) { img.removeAttribute("src"); img.remove(); }
    });
  };
}
