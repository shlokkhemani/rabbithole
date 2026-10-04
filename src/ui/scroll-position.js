function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scrollRange(scroller) {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

/*
 * A long document skips laying out what is off screen (base.css), sizing a
 * block it has never shown by an estimate. A pixel place means the text it
 * meant only against the real layout, so every place is set with the document
 * laid out in full. The browser remembers each block's real size as it lays
 * it out, and skipping resumes a frame later without moving a thing.
 */
/** @type {WeakMap<Element, number>} */
const fullLayoutHolds = new WeakMap();

/** Lay `scroller`'s document out in full until the returned release is called. */
export function holdFullLayout(scroller) {
  fullLayoutHolds.set(scroller, (fullLayoutHolds.get(scroller) || 0) + 1);
  scroller.classList.add("place-exact");
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    // Sizes are remembered when the frame is rendered: let one render first.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        const left = (fullLayoutHolds.get(scroller) || 1) - 1;
        fullLayoutHolds.set(scroller, left);
        if (left) return;
        // Skipping resuming moves nothing (every size is remembered), yet the
        // browser's scroll anchoring nudges the place by a few pixels as it
        // does: it sits out that one frame.
        scroller.style.overflowAnchor = "none";
        scroller.classList.remove("place-exact");
        requestAnimationFrame(function () {
          if (!fullLayoutHolds.get(scroller)) scroller.style.overflowAnchor = "";
        });
      });
    });
  };
}

/** Put `scroller` at pixel place `top`, measured against its real layout. */
export function setScrollPlace(scroller, top) {
  if (!scroller) return;
  // The top is the top whatever the estimates: nothing to lay out.
  if (!(top > 0)) {
    scroller.scrollTop = 0;
    return;
  }
  const release = holdFullLayout(scroller);
  scroller.scrollTop = top;
  release();
}

export function captureContentPosition(scroller) {
  if (!scroller) return null;
  // At the top is at the top on any surface: nothing to measure.
  if (!(scroller.scrollTop > 0)) return { progress: 0, block: -1, offset: 0 };
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
  // A document read from its top opens at its top: aligning its first block
  // with the edge would tuck its title under a pane's bar.
  if (!(position.progress > 0)) {
    scroller.scrollTop = 0;
    return;
  }
  const release = holdFullLayout(scroller);
  placeAtContent(scroller, position);
  release();
}

/*
 * A document has one place, whichever surface shows it. The canvas and the
 * reader measure it differently (a card is narrower than a pane), so a switch
 * reads every place the surface being left shows, by content, while it still
 * shows, and puts each on the surface being entered.
 */
/** @param {Iterable<[string, Element | null | undefined]>} scrollers @returns {Map<string, ReturnType<typeof captureContentPosition>>} */
export function readPlaces(scrollers) {
  const places = new Map();
  for (const [id, scroller] of scrollers) {
    // A scroller not laid out (a folded card) shows no place to carry.
    if (scroller && scroller.clientHeight) places.set(id, captureContentPosition(scroller));
  }
  return places;
}

/** @param {Map<string, ReturnType<typeof captureContentPosition>>} places @param {(id: string) => Element | null | undefined} scrollerOf */
export function putPlaces(places, scrollerOf) {
  places.forEach(function (position, id) {
    const scroller = scrollerOf(id);
    if (scroller && scroller.clientHeight) restoreContentPosition(scroller, position);
  });
}

function placeAtContent(scroller, position) {
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

/**
 * Run `change` — a text-size step, a new measure — and keep every scroller's
 * reading line where it was. The anchor is read from the layout the reader is
 * looking at. With `full`, the reflow is laid out in full so the place, and
 * every margin dot measured against it, lands on real sizes rather than on
 * the estimates of blocks the old size never showed. Without it only what is
 * on screen is laid out again: the line is kept all the same, and text above
 * settles as it is reached (the browser's scroll anchoring holds the view).
 * @param {Element[]} scrollers
 * @param {() => void} change
 * @param {{ full?: boolean }} [options]
 */
export function reflowKeepingPlace(scrollers, change, { full = true } = {}) {
  const held = scrollers.map(function (scroller) {
    return { scroller, anchor: captureReadingAnchor(scroller), release: full ? holdFullLayout(scroller) : null };
  });
  change();
  for (const { scroller, anchor, release } of held) {
    restoreReadingAnchor(scroller, anchor);
    if (release) release();
  }
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
function captureReadingAnchor(scroller) {
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

function restoreReadingAnchor(scroller, anchor) {
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
