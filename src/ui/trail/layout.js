/*
 * The reader is a trail: the lineage of the document being read, laid out as
 * panes side by side. Everything on screen is a pure function of three
 * numbers — `p`, the index of the leftmost open pane; `spine`, how wide each
 * folded pane's tab is; and `extra`, the width every pane gains so the trail
 * always fills the window edge to edge — so a swipe, a click, a key and a new
 * answer all move the same values and the picture follows.
 *
 * A pane's text follows its width (base.css): sliding moves no width, so
 * nothing re-wraps; a pane that widens or narrows as another opens or closes
 * takes its text along in the same motion. A pane pushed past the open panes
 * does not leave — it folds into a tab at that edge, and every ancestor keeps
 * its own tab: the whole path stays one click away.
 */

// Two panes need this much reading measure each before the trail shows two.
const MIN_COLUMN = 480;
const SPINE = 40;
// Below this a tab can no longer carry its title; it narrows to a sliver that
// still opens its document (its name stays in its tooltip).
const TITLED_SPINE = 22;
const PAD = 40;
const COMPACT_PAD = 18;

/**
 * Reading geometry for a stage of `width` pixels. `paneWidth` is the pane's
 * core width, and `column` the measure two documents side by side read at —
 * the least any document is given. Compact stages
 * (phones, coarse pointers) show one full-bleed pane and no tabs: a swipe
 * reveals the document underneath instead.
 * @param {number} width
 * @param {{ compact?: boolean }} [options]
 */
export function trailMetrics(width, options = {}) {
  const stage = Math.max(0, width || 0);
  if (options.compact) {
    const column = stage - 2 * COMPACT_PAD;
    return { stage: stage, cap: 1, spine: 0, pad: COMPACT_PAD, paneWidth: stage, column: column };
  }
  const twoUp = (stage - 2 * SPINE) / 2 >= MIN_COLUMN + 2 * PAD;
  const cap = twoUp ? 2 : 1;
  const paneWidth = Math.max(0, (stage - 2 * SPINE) / cap);
  return {
    stage: stage,
    cap: cap,
    spine: SPINE,
    pad: PAD,
    paneWidth: paneWidth,
    column: paneWidth - 2 * PAD,
  };
}

/**
 * How many panes stand open, how wide the tabs are, and how much every pane
 * widens to fill the window — for `count` panes, optionally focused on one.
 * @param {number} count
 * @param {boolean} focused
 * @param {ReturnType<typeof trailMetrics>} metrics
 */
export function trailShape(count, focused, metrics) {
  const { stage, cap, paneWidth } = metrics;
  const open = Math.max(1, Math.min(focused ? 1 : cap, count));
  if (!metrics.spine) return { open: open, spine: 0, extra: 0 };
  const folded = Math.max(0, count - open);
  const room = stage - open * paneWidth;
  const spine = folded ? Math.min(SPINE, room / folded) : SPINE;
  return { open: open, spine: spine, extra: Math.max(0, (room - spine * folded) / open) };
}

/** Whether a tab this wide still has room for its title. */
export function spineTitled(spine) {
  return spine >= TITLED_SPINE;
}

/** Highest meaningful `p` for a trail of `count` panes with `open` shown. */
export function maxPosition(count, open) {
  return Math.max(0, count - open);
}

/**
 * Where every pane is for position `p`, tab width `spine` and widening
 * `extra`. Per pane: `x` (left edge, stage coordinates), `z` (paint order),
 * `exposed` (visible width once nearer panes cover it). Every pane is `box`
 * wide. Open panes sit side by side after the left tabs; a pane that reaches
 * its tab's place stops there while the next slides over it.
 * @param {number} count
 * @param {number} p
 * @param {number} spine
 * @param {number} extra
 * @param {ReturnType<typeof trailMetrics>} metrics
 */
export function paneFrames(count, p, spine, extra, metrics) {
  const box = metrics.paneWidth + extra;
  const right = metrics.stage;
  const frames = [];
  for (let i = 0; i < count; i++) {
    const natural = spine * p + (i - p) * box;
    const leftStop = spine * i;
    const rightStop = right - spine * (count - i);
    const parkedRight = natural > rightStop;
    const x = parkedRight ? rightStop : Math.max(leftStop, natural);
    // Parked on the left, a later pane covers an earlier one; parked on the
    // right, the nearer pane must cover the deeper one instead.
    frames.push({ x: x, z: parkedRight ? count - i : count + i, exposed: 0, box: box });
  }
  for (let i = 0; i < count; i++) {
    const own = frames[i];
    let segments = [[Math.max(0, own.x), Math.min(own.x + box, right)]];
    for (let j = 0; j < count; j++) {
      if (j === i || frames[j].z <= own.z) continue;
      segments = subtract(segments, frames[j].x, frames[j].x + box);
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
export function revealPosition(index, from, count, open) {
  const max = maxPosition(count, open);
  let p = from;
  if (index < p) p = index;
  else if (index > p + open - 1) p = index - open + 1;
  return Math.max(0, Math.min(max, Math.round(p)));
}

/**
 * How far a pane has folded into its tab: 0 fully open, 1 only the tab
 * shows. Continuous, so content fades as it is covered rather than popping.
 */
export function foldAmount(exposed, spine, box) {
  if (!spine) return exposed >= box - 0.5 ? 0 : 1 - exposed / Math.max(1, box);
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
