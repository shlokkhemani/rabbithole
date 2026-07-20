import { openImageLightbox } from "./image-ux.js";
import { resolveAssetUrl } from "./renderer.js";

/** Build the durable PDF clip shown with a branch's origin metadata. */
export function buildOriginCrop(node, surface) {
  const name = node?.origin?.crop_asset;
  if (!name) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = `rh-origin-crop rh-origin-crop-${surface || "card"}`;
  button.setAttribute("aria-label", "Open selected PDF region");
  button.title = "Open selected PDF region";
  const img = document.createElement("img");
  img.src = resolveAssetUrl(name);
  img.alt = "Selected PDF region";
  img.draggable = false;
  const hideIfMissing = function(){ if (!img.naturalWidth) button.hidden = true; };
  img.addEventListener("error", hideIfMissing, { once: true });
  img.addEventListener("load", hideIfMissing, { once: true });
  button.addEventListener("click", function(event){
    event.preventDefault();
    event.stopPropagation();
    openImageLightbox(img.currentSrc || img.src, img.alt, button);
  });
  button.appendChild(img);
  return button;
}
