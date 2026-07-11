import { childrenOf, nodes } from "./core.js";

export function applyChildHighlights(dc, node){
  var kids = childrenOf(node.id).filter(function(k){ return k.origin && k.origin.anchor; });
  kids.sort(function(a,b){ return b.origin.anchor.offset_start - a.origin.anchor.offset_start; });
  kids.forEach(function(k){
    var a = k.origin.anchor;
    var r = rangeFromOffsets(dc, a.offset_start, a.offset_end);
    if (!r) return;
    wrapRange(r, k.id, "hl " + (k.status === "answered" ? "mark-ready" : "mark-pending"));
  });
}

export function wrapInContainer(dc, anchor, childId, cls){
  if (!dc || !anchor) return;
  var rr = rangeFromOffsets(dc, anchor.offset_start, anchor.offset_end);
  if (rr){ try { wrapRange(rr, childId, cls); } catch(e){} }
}

export function upgradeMarks(root, childId){
  if (!root) return;
  var marks = root.querySelectorAll('mark[data-child="' + childId + '"]');
  var child = nodes[childId], label = "Open branch: " + ((child && child.title) || "Untitled");
  for (var i = 0; i < marks.length; i++){
    marks[i].classList.remove("mark-pending"); marks[i].classList.add("mark-ready");
    marks[i].setAttribute("aria-label", label);
  }
}

export function removeMarks(root, childId){
  if (!root) return;
  var marks = root.querySelectorAll('mark[data-child="' + childId + '"]');
  for (var i = 0; i < marks.length; i++){
    var m = marks[i], p = m.parentNode; if (!p) continue;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m); p.normalize();
  }
}

export function rangeFromOffsets(container, startOff, endOff){
  var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  var pos = 0, sN, sO, eN, eO;
  while (walker.nextNode()){
    var node = walker.currentNode, L = node.textContent.length;
    if (sN == null && pos + L > startOff){ sN = node; sO = startOff - pos; }
    if (pos + L >= endOff){ eN = node; eO = endOff - pos; break; }
    pos += L;
  }
  if (sN == null || eN == null) return null;
  var r = document.createRange();
  try { r.setStart(sN, sO); r.setEnd(eN, eO); } catch(e){ return null; }
  return r;
}

export function charOffset(container, node, offset){
  var r = document.createRange();
  r.selectNodeContents(container);
  try { r.setEnd(node, offset); } catch(e){ return 0; }
  return r.toString().length;
}

export function wrapTextNode(textNode, childId, cls){
  var m = document.createElement("mark");
  m.className = cls; m.dataset.child = childId;
  m.tabIndex = 0; m.setAttribute("role", "link");
  var child = nodes[childId];
  m.setAttribute("aria-label", "Open branch: " + ((child && child.title) || "Untitled"));
  textNode.parentNode.insertBefore(m, textNode);
  m.appendChild(textNode);
}

export function wrapRange(range, childId, cls){
  var startC = range.startContainer, endC = range.endContainer, startO = range.startOffset, endO = range.endOffset;
  if (startC === endC && startC.nodeType === 3){
    if (startO === endO) return;
    var mid = startC.splitText(startO); mid.splitText(endO - startO);
    wrapTextNode(mid, childId, cls); return;
  }
  var ancestor = range.commonAncestorContainer; if (ancestor.nodeType === 3) ancestor = ancestor.parentNode;
  var walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT);
  var collected = [], inRange = false;
  while (walker.nextNode()){
    var n = walker.currentNode;
    if (n === startC){ inRange = true; var info = { node:n, start:startO, end:n.textContent.length }; if (n === endC){ info.end = endO; collected.push(info); break; } collected.push(info); continue; }
    if (n === endC){ collected.push({ node:n, start:0, end:endO }); break; }
    if (inRange) collected.push({ node:n, start:0, end:n.textContent.length });
  }
  for (var i = collected.length - 1; i >= 0; i--){
    var c = collected[i], node = c.node, s = c.start, e = c.end, L = node.textContent.length;
    if (s >= e || !L) continue;
    var t = s > 0 ? node.splitText(s) : node;
    if (e < L) t.splitText(e - s);
    wrapTextNode(t, childId, cls);
  }
}
