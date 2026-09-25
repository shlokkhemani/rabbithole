function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scrollRange(scroller) {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

export function captureContentPosition(scroller) {
  if (!scroller) return null;
  const range = scrollRange(scroller);
  const position = { progress: range ? scroller.scrollTop / range : 0, block: -1, offset: 0 };
  const content = scroller.querySelector?.(".doc-content");
  if (!content) return position;
  const viewportTop = scroller.getBoundingClientRect().top;
  const blocks = Array.from(content.children);
  for (let i = 0; i < blocks.length; i++) {
    const rect = blocks[i].getBoundingClientRect();
    if (rect.bottom > viewportTop) {
      position.block = i;
      position.offset = (viewportTop - rect.top) / Math.max(1, rect.height);
      break;
    }
  }
  return position;
}

export function restoreContentPosition(scroller, position) {
  if (!scroller || !position) return;
  const range = scrollRange(scroller);
  const content = scroller.querySelector?.(".doc-content");
  const block = content && position.block >= 0 ? content.children[position.block] : null;
  if (block) {
    const scrollerRect = scroller.getBoundingClientRect();
    const viewportTop = scrollerRect.top;
    const rect = block.getBoundingClientRect();
    const targetTop = rect.top + clamp(position.offset, -1, 1) * rect.height;
    const visualScale = scroller.offsetHeight ? scrollerRect.height / scroller.offsetHeight : 1;
    scroller.scrollTop = clamp(scroller.scrollTop + (targetTop - viewportTop) / (visualScale || 1), 0, range);
    return;
  }
  scroller.scrollTop = clamp((Number(position.progress) || 0) * range, 0, range);
}

// Consecutive size steps hold one anchor: re-picking the line start after each
// reflow would let the anchor walk, so A+ then A- would not land back home.
// Held only while it still sits where the last restore put it.
const heldAnchors = new WeakMap();

/*
 * A text-size change reflows every line, so a block-level position drifts by
 * however far the reading line moved inside its paragraph. The reading anchor
 * is finer: the first character whose line starts at or below the scroller's
 * top edge, held at the same on-screen offset across the reflow. Blocks with
 * no text (a figure, a diagram) fall back to the block itself.
 */
export function captureReadingAnchor(scroller) {
  const content = scroller?.querySelector?.(".doc-content");
  if (!content || !scroller.clientHeight) return null;
  const held = heldAnchors.get(scroller);
  if (held && Math.abs(anchorDrift(scroller, held) ?? Infinity) < 1) return held;
  const top = scroller.getBoundingClientRect().top;
  const bottom = top + scroller.clientHeight;
  const blocks = content.children;
  let first = -1;
  for (let i = 0; i < blocks.length; i++) {
    const rect = blocks[i].getBoundingClientRect();
    if (rect.bottom <= top) continue;
    if (rect.top >= bottom) break;
    if (first < 0) first = i;
    const text = firstTextAtOrBelow(blocks[i], top);
    if (text) return { text: text.node, offset: text.offset, dy: text.top - top };
  }
  if (first < 0) return null;
  const rect = blocks[first].getBoundingClientRect();
  return { block: blocks[first], offset: (top - rect.top) / Math.max(1, rect.height) };
}

export function restoreReadingAnchor(scroller, anchor) {
  if (!scroller || !anchor) return;
  // Card bodies live inside the zoomed canvas world: rects are screen pixels,
  // scrollTop is CSS pixels. The ratio is only an estimate (offsetHeight is
  // rounded), so a second pass corrects the residual it leaves.
  heldAnchors.set(scroller, anchor);
  const scrollerRect = scroller.getBoundingClientRect();
  const visualScale = (scroller.offsetHeight && scrollerRect.height / scroller.offsetHeight) || 1;
  for (let pass = 0; pass < 2; pass++) {
    const delta = anchorDrift(scroller, anchor);
    if (delta === null || Math.abs(delta) < 0.5) return;
    // scrollTop truncates fractions; rounding keeps the error under half a pixel.
    scroller.scrollTop = Math.round(clamp(scroller.scrollTop + delta / visualScale, 0, scrollRange(scroller)));
  }
}

function anchorDrift(scroller, anchor) {
  const top = scroller.getBoundingClientRect().top;
  if (anchor.text?.isConnected) {
    const rect = charRect(anchor.text, anchor.offset);
    return rect ? rect.top - top - anchor.dy : null;
  }
  if (anchor.block?.isConnected) {
    const rect = anchor.block.getBoundingClientRect();
    return rect.top + anchor.offset * rect.height - top;
  }
  return null;
}

function charRect(node, offset) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, Math.min(node.length, offset + 1));
  const rect = range.getBoundingClientRect();
  return rect.height ? rect : null;
}

function firstTextAtOrBelow(block, top) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (
    let node = /** @type {Text | null} */ (walker.nextNode());
    node;
    node = /** @type {Text | null} */ (walker.nextNode())
  ) {
    if (!node.data.trim()) continue;
    range.selectNodeContents(node);
    const whole = range.getBoundingClientRect();
    // Hidden text (KaTeX's MathML twin) has no box; text wholly above the
    // edge cannot hold the anchor.
    if (!whole.height || whole.bottom <= top) continue;
    // Lines only move down through a text node, so the first character at or
    // below the edge is a binary search away.
    let lo = 0;
    let hi = node.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const rect = charRect(node, mid);
      if (rect && rect.top >= top - 0.5) hi = mid;
      else lo = mid + 1;
    }
    if (lo >= node.length) continue;
    const rect = charRect(node, lo);
    if (rect) return { node, offset: lo, top: rect.top };
  }
  return null;
}
