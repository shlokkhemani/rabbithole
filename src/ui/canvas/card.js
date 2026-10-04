import { isNoteNode } from "../../core/hole/ask.js";
import { BUNNY_MARK_SVG } from "../../core/html/icons.js";
import { iconButtonMarkup } from "../../core/html/markup.js";
import { currentNodeId, rootId, shouldReduceMotion, world } from "../core.js";
import { closestEl } from "../dom.js";
import { openNode } from "../reader.js";
import { cancelViewAnimation } from "./camera.js";
import { buildCardComposer, cardButton, closeCardDrawer, updateCardComposer } from "./card-composer.js";
import { fillBody } from "./document.js";
import { focusOrigin, scheduleNodeEdges } from "./edges.js";
import { branchAllCollapsed, setBranchCollapsed, toggleCollapse } from "./fold.js";
import { enableDrag, enableResize, layoutNode, onCardControl } from "./gestures.js";
import { startNoteEditing } from "./inline-note.js";
import { nodeMenuButton, syncCollapseButton } from "./menu.js";
import { startTitleEditing } from "./note-convert.js";
import { r } from "./runtime.js";
import { closeCardMenu, raiseCard } from "./shared.js";

export function createNodeEl(node, enter) {
  const el = document.createElement("div");
  el.className = "card" + (node.id === rootId ? " root" : "") + (isNoteNode(node) ? " card-note" : "");
  if (node.id === currentNodeId) el.className += " current";
  if (enter && !document.hidden && !shouldReduceMotion()) el.className += " card-enter";
  el.dataset.id = node.id;
  raiseCard(el);
  const head = document.createElement("div");
  head.className = "card-head";
  head.title = "Drag to move card · Shift-drag to move branch";
  if (node.id === rootId) {
    const badge = document.createElement("span");
    badge.className = "card-badge";
    badge.innerHTML = BUNNY_MARK_SVG;
    badge.title = "Where this Rabbithole begins";
    head.appendChild(badge);
  }
  const titleEl = document.createElement("span");
  titleEl.className = "card-title";
  titleEl.textContent = node.title || "…";
  titleEl.title = node.title || "";
  const collapseBtn = cardButton(
    iconButtonMarkup({
      bare: true,
      className: "card-btn card-collapse",
      svgIconHtml: r.NODE_COLLAPSE_ICON,
      ariaLabel: "Collapse card",
      title: "Collapse card",
    }),
  );
  syncCollapseButton(node, collapseBtn);
  const openBtn = cardButton(
    iconButtonMarkup({
      bare: true,
      className: "card-btn",
      svgIconHtml: r.NODE_EXPAND_ICON,
      ariaLabel: "Expand document",
      title: "Expand document",
    }),
  );
  const divider = document.createElement("span");
  divider.className = "card-act-divider";
  divider.setAttribute("aria-hidden", "true");
  const acts = document.createElement("span");
  acts.className = "card-acts";
  node.actsEl = acts;
  node.actDivider = divider;
  // Window controls first, then the divider, then the ⋮ menu at the outer
  // edge — the rightmost thing in the header, where every card menu lives.
  // Real DOM order, so tab order and reading order are the same order.
  acts.appendChild(collapseBtn);
  acts.appendChild(openBtn);
  acts.appendChild(divider);
  if (!node._ephemeral) acts.appendChild(nodeMenuButton(node));
  head.appendChild(titleEl);
  head.appendChild(acts);
  const body = document.createElement("div");
  body.className = "card-body";
  const comp = buildCardComposer(node);
  const resize = document.createElement("div");
  resize.className = "card-resize";
  el.appendChild(head);
  el.appendChild(body);
  el.appendChild(comp);
  el.appendChild(resize);
  world.appendChild(el);
  node.el = el;
  node.bodyEl = body;
  node.titleEl = titleEl;
  node.collapseBtn = collapseBtn;
  if (r.cardResizeObserver) r.cardResizeObserver.observe(el);
  // Placed before it is filled (a pinned card moves into its window), so its
  // document is laid out once, where it will be read.
  if (node.collapsed) el.classList.add("collapsed");
  layoutNode(node);
  fillBody(node);
  updateCardComposer(node);
  enableDrag(node, head);
  enableResize(node, resize);
  head.addEventListener("dblclick", function (e) {
    let hit = closestEl(e.target, ".card-title");
    if (!hit && e.target === head) {
      const pointHit = document.elementFromPoint(e.clientX, e.clientY);
      hit = pointHit && pointHit.closest && pointHit.closest(".card-title");
    }
    if (hit === titleEl) {
      const titleRange = document.createRange();
      titleRange.selectNodeContents(titleEl);
      const textRect = titleRange.getBoundingClientRect();
      if (
        e.clientX >= textRect.left &&
        e.clientX <= textRect.right &&
        e.clientY >= textRect.top &&
        e.clientY <= textRect.bottom
      ) {
        e.preventDefault();
        e.stopPropagation();
        startTitleEditing(node, titleEl);
        return;
      }
    }
    if (!onCardControl(e)) openNode(node.id);
  });
  openBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    openNode(node.id);
  });
  collapseBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    toggleCollapse(node);
  });
  collapseBtn.addEventListener("contextmenu", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (node._ephemeral) return;
    cancelViewAnimation();
    closeCardMenu({ restoreFocus: false });
    setBranchCollapsed(node, !branchAllCollapsed(node));
  });
  // Scrolling a card moves the inline marks its children's edges start from.
  body.addEventListener(
    "scroll",
    function () {
      scheduleNodeEdges(node);
    },
    { passive: true },
  );
  if (isNoteNode(node))
    body.addEventListener("dblclick", function (e) {
      const dc = closestEl(e.target, ".doc-content");
      if (!dc || !body.contains(dc)) return;
      if (closestEl(e.target, "a, button, input, textarea, select, summary, [role=button], [role=link], [data-child]"))
        return;
      e.stopPropagation();
      startNoteEditing(node, dc, null, { left: e.clientX, top: e.clientY });
    });
  // Hovering a card lights up its edge and the exact text it branched from.
  el.addEventListener("mouseenter", function () {
    focusOrigin(node, true);
  });
  el.addEventListener("mouseleave", function () {
    focusOrigin(node, false);
    if (node.ncComp && !node.ncText.value.trim() && document.activeElement !== node.ncText) closeCardDrawer(node);
  });
  if (el.classList.contains("card-enter")) {
    requestAnimationFrame(function () {
      el.classList.add("entered");
      setTimeout(function () {
        el.classList.remove("card-enter");
        el.classList.remove("entered");
      }, 220);
    });
  }
  return node;
}
