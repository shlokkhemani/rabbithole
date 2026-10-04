import { isNoteNode, isReactionNote } from "../core/hole/ask.js";
import { childrenOf, nodes } from "./core.js";

const MARK_FRAGMENT_SELECTOR = "mark[data-child], .rh-pdf-mark[data-child]";

function markGroupsAt(target) {
  let el = target && target.nodeType === 1 ? target : target && target.parentElement;
  const groups = [];
  while (el) {
    if (el.matches && el.matches(MARK_FRAGMENT_SELECTOR)) {
      const root = el.closest(".doc-content");
      const childId = el.dataset.child;
      let seen = false;
      for (let i = 0; i < groups.length; i++) {
        if (groups[i].root === root && groups[i].childId === childId) {
          seen = true;
          break;
        }
      }
      if (root && childId != null && !seen) groups.push({ root: root, childId: childId, fragment: el });
    }
    if (el.classList && el.classList.contains("doc-content")) break;
    el = el.parentElement;
  }
  return groups;
}

function sameMarkGroup(groups, group) {
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].root === group.root && groups[i].childId === group.childId) return true;
  }
  return false;
}

function toggleMarkGroup(fragment, stateClass, on) {
  if (!fragment || !fragment.matches || !fragment.matches(MARK_FRAGMENT_SELECTOR)) return;
  const root = fragment.closest(".doc-content"),
    childId = fragment.dataset.child;
  if (!root || childId == null) return;
  const marks = root.querySelectorAll(MARK_FRAGMENT_SELECTOR);
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].dataset.child === childId) marks[i].classList.toggle(stateClass, on);
  }
}

export function transitionMarkGroups(event, entering, stateClass, onTransition) {
  const active = markGroupsAt(event.target);
  const related = markGroupsAt(event.relatedTarget);
  for (let i = 0; i < active.length; i++) {
    const group = active[i];
    if (sameMarkGroup(related, group)) continue;
    toggleMarkGroup(group.fragment, stateClass, entering);
    if (onTransition) onTransition(group.childId, entering);
  }
}

/**
 * Mark every branch and note anchored in `dc`. A note's wash is a measured
 * overlay: `measure` false leaves it to the dot pass that follows (which
 * measures only the surface on screen) and to the document's layout watch.
 */
export function applyChildHighlights(dc, node, measure = true) {
  if (dc && dc.classList.contains("rh-pdf")) return;
  const kids = childrenOf(node.id).filter(function (k) {
    return k.origin && k.origin.anchor && !k.origin.anchor.block;
  });
  kids.sort(function (a, b) {
    return b.origin.anchor.offset_start - a.origin.anchor.offset_start;
  });
  kids.forEach(function (k) {
    const a = k.origin.anchor;
    const r = rangeFromOffsets(dc, a.offset_start, a.offset_end);
    if (!r) return;
    const note = isNoteNode(k);
    const cls =
      "hl " +
      (k.status === "answered" ? "mark-ready" : "mark-pending") +
      (note ? " mark-note" : "") +
      (isReactionNote(k) ? " mark-reaction" : "");
    if (note) overlayRange(r, k.id, cls, measure);
    else wrapRange(r, k.id, cls);
  });
}

export function wrapInContainer(dc, anchor, childId, cls) {
  if (!dc || !anchor || dc.classList.contains("rh-pdf") || anchor.pdf || anchor.block) return;
  const rr = rangeFromOffsets(dc, anchor.offset_start, anchor.offset_end);
  if (rr) {
    try {
      if (/(^|\s)mark-note(\s|$)/.test(cls)) overlayRange(rr, childId, cls);
      else wrapRange(rr, childId, cls);
    } catch (e) {}
  }
}

/* Re-measure note washes after a card/reader resize. The fragments are empty
   paint and hit-test boxes, so this pass cannot feed back into text layout. */
export function syncTextOverlayMarks(root) {
  if (!root || !root.querySelectorAll) return;
  const containers = root.matches && root.matches(".doc-content") ? [root] : root.querySelectorAll(".doc-content");
  for (let c = 0; c < containers.length; c++) {
    const dc = containers[c];
    const marks = dc.querySelectorAll("mark.mark-overlay[data-child]");
    const seen = {};
    for (let i = 0; i < marks.length; i++) {
      const childId = marks[i].dataset.child;
      if (seen[childId]) continue;
      seen[childId] = true;
      const child = nodes[childId],
        anchor = child && child.origin && child.origin.anchor;
      if (!anchor || anchor.pdf || anchor.block) continue;
      const range = rangeFromOffsets(dc, anchor.offset_start, anchor.offset_end);
      if (!range) continue;
      overlayRange(range, childId, marks[i].className.replace(/\s*mark-overlay\b/, ""));
    }
  }
}

export function upgradeMarks(root, childId) {
  if (!root) return;
  const marks = root.querySelectorAll('[data-child="' + childId + '"]');
  const child = nodes[childId],
    label = "Open branch: " + ((child && child.title) || "Untitled");
  for (let i = 0; i < marks.length; i++) {
    marks[i].classList.remove("mark-pending");
    marks[i].classList.add("mark-ready");
    marks[i].setAttribute("aria-label", label);
  }
}

export function setPendingMarks(root, childId) {
  if (!root) return;
  const marks = root.querySelectorAll('[data-child="' + childId + '"]');
  for (let i = 0; i < marks.length; i++) {
    marks[i].classList.remove("mark-ready", "mark-note");
    marks[i].classList.add("mark-pending");
  }
}

export function setNoteMarks(root, childId) {
  if (!root) return;
  const marks = root.querySelectorAll('[data-child="' + childId + '"]');
  for (let i = 0; i < marks.length; i++) {
    marks[i].classList.remove("mark-pending");
    marks[i].classList.add("mark-ready", "mark-note");
  }
}

export function removeMarks(root, childId) {
  if (!root) return;
  const marks = root.querySelectorAll('[data-child="' + childId + '"]');
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i],
      p = m.parentNode;
    if (!p) continue;
    if (m.namespaceURI === "http://www.w3.org/2000/svg") {
      m.remove();
      continue;
    }
    if (m.classList.contains("mark-overlay")) {
      m.remove();
      continue;
    }
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
    p.normalize();
  }
}

function rangeFromOffsets(container, startOff, endOff) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let pos = 0,
    sN,
    sO,
    eN,
    eO;
  while (walker.nextNode()) {
    const node = walker.currentNode,
      L = node.textContent.length;
    if (sN == null && pos + L > startOff) {
      sN = node;
      sO = startOff - pos;
    }
    if (pos + L >= endOff) {
      eN = node;
      eO = endOff - pos;
      break;
    }
    pos += L;
  }
  if (sN == null || eN == null) return null;
  const r = document.createRange();
  try {
    r.setStart(sN, sO);
    r.setEnd(eN, eO);
  } catch (e) {
    return null;
  }
  return r;
}

export function charOffset(container, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(container);
  try {
    r.setEnd(node, offset);
  } catch (e) {
    return 0;
  }
  return r.toString().length;
}

function wrapTextNode(textNode, childId, cls) {
  const m = document.createElement("mark");
  initializeMark(m, childId, cls);
  textNode.parentNode.insertBefore(m, textNode);
  m.appendChild(textNode);
}

function initializeMark(m, childId, cls) {
  if (m.namespaceURI === "http://www.w3.org/2000/svg") m.setAttribute("class", cls);
  else m.className = cls;
  m.dataset.child = childId;
  m.setAttribute("tabindex", "0");
  const child = nodes[childId];
  if (isReactionNote(child)) {
    m.setAttribute("role", "group");
    m.setAttribute("aria-label", child.markdown === "👍" ? "Thumbs up reaction" : "Thumbs down reaction");
  } else {
    m.setAttribute("role", "link");
    m.setAttribute("aria-label", "Open branch: " + ((child && child.title) || "Untitled"));
  }
  return m;
}

function overlayRange(range, childId, cls, measure = true) {
  const ancestor = range.commonAncestorContainer;
  const dc = (ancestor.nodeType === 1 ? ancestor : ancestor.parentElement).closest(".doc-content");
  if (!dc) return;
  const rects = measure
    ? Array.from(range.getClientRects()).filter(function (rect) {
        return rect.width > 0 && rect.height > 0;
      })
    : [];
  const selector = 'mark.mark-overlay[data-child="' + childId + '"]';
  const marks = Array.from(dc.querySelectorAll(selector));
  const fragmentCount = Math.max(1, rects.length);
  while (marks.length < fragmentCount) {
    const mark = document.createElement("mark");
    dc.appendChild(mark);
    marks.push(mark);
  }
  while (marks.length > fragmentCount) marks.pop().remove();
  for (let i = 0; i < marks.length; i++) initializeMark(marks[i], childId, cls + " mark-overlay");
  if (!rects.length) {
    marks[0].style.width = "0";
    marks[0].style.height = "0";
    return;
  }
  const offsetParent = marks[0].offsetParent;
  if (!offsetParent) return;
  const parentRect = offsetParent.getBoundingClientRect();
  let scaleX = offsetParent.offsetWidth ? parentRect.width / offsetParent.offsetWidth : 1;
  let scaleY = offsetParent.offsetHeight ? parentRect.height / offsetParent.offsetHeight : scaleX;
  if (!scaleX) scaleX = 1;
  if (!scaleY) scaleY = scaleX;
  for (let j = 0; j < marks.length; j++) {
    const rect = rects[j],
      current = marks[j];
    current.style.left = (rect.left - parentRect.left) / scaleX + offsetParent.scrollLeft + "px";
    current.style.top = (rect.top - parentRect.top) / scaleY + offsetParent.scrollTop + "px";
    current.style.width = rect.width / scaleX + "px";
    current.style.height = rect.height / scaleY + "px";
  }
}

export function mountPdfRectMark(container, anchor, childId, cls) {
  if (!container || !anchor || !anchor.pdf) return null;
  let first = null,
    fragments = anchor.pdf.fragments || [];
  for (let f = 0; f < fragments.length; f++) {
    const fragment = fragments[f];
    const page = container.querySelector('.rh-pdf-page[data-page="' + Math.floor(Number(fragment.page)) + '"]');
    const viewport = page && page._pdfViewport;
    const layer = page && page.querySelector(".rh-pdf-marks");
    if (!layer || !viewport) continue;
    const group = initializeMark(document.createElementNS("http://www.w3.org/2000/svg", "g"), childId, cls);
    for (let q = 0; q < fragment.quads.length; q++) {
      const quad = fragment.quads[q],
        points = [];
      for (let p = 0; p < quad.length; p++) {
        const converted = viewport.convertToViewportPoint(Number(quad[p][0]), Number(quad[p][1]));
        points.push(converted[0] + "," + converted[1]);
      }
      const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      polygon.setAttribute("points", points.join(" "));
      group.appendChild(polygon);
    }
    layer.appendChild(group);
    if (!first) first = group;
  }
  return first;
}

function wrapRange(range, childId, cls) {
  const startC = range.startContainer,
    endC = range.endContainer,
    startO = range.startOffset,
    endO = range.endOffset;
  if (startC === endC && startC.nodeType === 3) {
    if (startO === endO) return;
    const mid = startC.splitText(startO);
    mid.splitText(endO - startO);
    wrapTextNode(mid, childId, cls);
    return;
  }
  let ancestor = range.commonAncestorContainer;
  if (ancestor.nodeType === 3) ancestor = ancestor.parentNode;
  const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT);
  let collected = [],
    inRange = false;
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (n === startC) {
      inRange = true;
      const info = { node: n, start: startO, end: n.textContent.length };
      if (n === endC) {
        info.end = endO;
        collected.push(info);
        break;
      }
      collected.push(info);
      continue;
    }
    if (n === endC) {
      collected.push({ node: n, start: 0, end: endO });
      break;
    }
    if (inRange) collected.push({ node: n, start: 0, end: n.textContent.length });
  }
  for (let i = collected.length - 1; i >= 0; i--) {
    const c = collected[i],
      node = /** @type {Text} */ (c.node),
      s = c.start,
      e = c.end,
      L = node.textContent.length;
    if (s >= e || !L) continue;
    const t = s > 0 ? node.splitText(s) : node;
    if (e < L) t.splitText(e - s);
    wrapTextNode(t, childId, cls);
  }
}
