/*
 * The reader is a trail: the lineage of the document being read, laid out as
 * panes side by side. Everything on screen is a pure function of one number,
 * `p` — the index of the leftmost fully shown pane — so a swipe, a click, a
 * keystroke and a new answer all move the same value and the picture follows.
 *
 * Panes never change width while a window stays one size: they translate,
 * nothing else, so text never re-wraps under the reader's eye. A pane pushed
 * past the band's edge does not leave — it parks there and the next pane
 * slides over it, leaving a spine: the whole path stays one click away.
 */

// Two panes need this much reading measure each before the trail shows two.
const MIN_COLUMN = 480;
const MAX_COLUMN = 680;
const SPINE = 40;
const PAD = 40;
const COMPACT_PAD = 18;

/**
 * Reading geometry for a stage of `width` pixels. Compact stages (phones,
 * coarse pointers) show one full-bleed pane and no spines: a swipe reveals the
 * document underneath instead.
 * @param {number} width
 * @param {{ compact?: boolean }} [options]
 */
export function trailMetrics(width, options = {}) {
  const stage = Math.max(0, width || 0);
  if (options.compact) {
    return {
      cap: 1,
      spine: 0,
      pad: COMPACT_PAD,
      paneWidth: stage,
      column: stage - 2 * COMPACT_PAD,
      band: stage,
      left: 0,
    };
  }
  const twoUp = (stage - 2 * SPINE) / 2 >= MIN_COLUMN + 2 * PAD;
  const cap = twoUp ? 2 : 1;
  const paneWidth = Math.max(0, Math.min(MAX_COLUMN + 2 * PAD, (stage - 2 * SPINE) / cap));
  const band = cap * paneWidth + 2 * SPINE;
  return {
    cap: cap,
    spine: SPINE,
    pad: PAD,
    paneWidth: paneWidth,
    column: paneWidth - 2 * PAD,
    band: band,
    // Wider than two full measures: the band centres and the rest is margin.
    left: Math.max(0, (stage - band) / 2),
  };
}

/** Highest meaningful `p` for a trail of `count` panes. */
export function maxPosition(count, cap) {
  return Math.max(0, count - cap);
}

/**
 * A lone document (fewer panes than the band holds) sits centred; the
 * offset is how far right of the first slot that is.
 */
export function centreOffset(count, metrics) {
  return count < metrics.cap ? ((metrics.cap - count) * metrics.paneWidth) / 2 : 0;
}

/**
 * Where every pane is for a position `p` and centring offset `offset`.
 * Returns, per pane: `x` (left edge, stage coordinates), `z` (paint order),
 * and `exposed` (visible width, after nearer panes cover it).
 * @param {number} count
 * @param {number} p
 * @param {number} offset
 * @param {ReturnType<typeof trailMetrics>} metrics
 */
export function paneFrames(count, p, offset, metrics) {
  const { paneWidth: width, spine, left, band } = metrics;
  const minX = left;
  const maxX = left + band - spine - (spine ? 0 : width);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const natural = left + spine + offset + (i - p) * width;
    const parkedRight = spine > 0 && natural > maxX;
    const x = parkedRight ? maxX : Math.max(minX, natural);
    // Parked on the left, a later pane covers an earlier one; parked on the
    // right, the nearer pane must cover the deeper one instead.
    frames.push({ x: x, z: parkedRight ? count - i : count + i, exposed: 0 });
  }
  const stageRight = left + band;
  for (let i = 0; i < count; i++) {
    const own = frames[i];
    let segments = [[own.x, Math.min(own.x + width, stageRight)]];
    for (let j = 0; j < count; j++) {
      if (j === i || frames[j].z <= own.z) continue;
      segments = subtract(segments, frames[j].x, frames[j].x + width);
    }
    own.exposed = segments.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0);
  }
  return frames;
}

function subtract(segments, from, to) {
  const out = [];
  for (const [a, b] of segments) {
    if (to <= a || from >= b) out.push([a, b]);
    else {
      if (from > a) out.push([a, from]);
      if (to < b) out.push([to, b]);
    }
  }
  return out;
}

/**
 * The `p` that brings pane `index` fully into view while moving as little as
 * possible from `from`.
 */
export function revealPosition(index, from, count, cap) {
  const max = maxPosition(count, cap);
  let p = from;
  if (index < p) p = index;
  else if (index > p + cap - 1) p = index - cap + 1;
  return Math.max(0, Math.min(max, Math.round(p)));
}

/**
 * How far a pane has folded into its spine: 0 fully open, 1 only the spine
 * shows. Continuous, so content fades as it is covered rather than popping.
 */
export function foldAmount(exposed, metrics) {
  const { spine, paneWidth } = metrics;
  if (!spine) return exposed >= paneWidth - 0.5 ? 0 : 1 - exposed / Math.max(1, paneWidth);
  const t = (exposed - spine) / (spine * 2);
  return 1 - Math.max(0, Math.min(1, t));
}

/**
 * Past either end the trail gives way, but with growing resistance, and
 * never more than a fraction of a pane: a rubber band, not a wall.
 */
export function rubberBand(p, max) {
  const limit = 0.18;
  if (p < 0) return -limit * (1 - 1 / (1 + (-p * 0.55) / limit));
  if (p > max) return max + limit * (1 - 1 / (1 + ((p - max) * 0.55) / limit));
  return p;
}
