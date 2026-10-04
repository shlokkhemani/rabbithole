import { shouldReduceMotion } from "../core.js";
import { createCleanupScope } from "../kit/scope.js";
import {
  foldAmount,
  leanTabs,
  maxPosition,
  paneFrames,
  revealPosition,
  rubberBand,
  spineTitled,
  trailMetrics,
  trailShape,
} from "./layout.js";

/*
 * The stage turns three numbers into motion. `p` (which pane leads), the tab
 * width and the widening that fills the window each ride a critically damped
 * spring, so every way of moving — a trackpad swipe, a touch drag, a click, a
 * key, a new answer, focusing one document — shares one physics and can
 * interrupt any other mid-flight without a seam. Direct manipulation is 1:1: while fingers are down, the panes are
 * exactly where the fingers put them; the spring only takes over on release.
 */

const RESPONSE = 17; // spring stiffness as angular frequency (rad/s): ~0.35s to settle
const WHEEL_IDLE_MS = 140;
const AXIS_LOCK_PX = 6;
const TOUCH_SLOP = 10;
const REST = 0.0005;

/**
 * @param {{
 *   stage: HTMLElement,
 *   panes: () => { el: HTMLElement, scroll: HTMLElement, spine: HTMLElement }[],
 *   compact: () => boolean,
 *   focusIndex?: () => number,
 *   onFrame?: (frames: ReturnType<typeof paneFrames>, metrics: ReturnType<typeof trailMetrics>, extra: number) => void,
 *   onSettle?: (position: number) => void,
 *   onMetrics?: (metrics: ReturnType<typeof trailMetrics>) => void,
 *   keepPlace?: (resize: () => void) => void,
 * }} options
 */
export function createTrailStage(options) {
  const scope = createCleanupScope();
  const { stage } = options;
  let metrics = trailMetrics(stage.clientWidth, { compact: options.compact() });
  const springP = { x: 0, v: 0, target: 0 };
  const springS = { x: metrics.spine, v: 0, target: metrics.spine };
  const springE = { x: 0, v: 0, target: 0 };
  const springs = [springP, springS, springE];
  let focused = false;
  let frame = 0;
  let lastTime = 0;
  let dragging = false; // a finger or a live trackpad gesture owns p
  let wheel = null;
  let touch = null;
  let settledAt = 0;
  let paintedBox = "";
  // Pointing at a tab too narrow for its title leans it open: the other tabs
  // on its edge give up the room, so nothing else moves. Each leaning pane
  // has its own spring, so the lean glides from tab to tab with the pointer.
  const leans = new Map(); // pane element → spring of how far its tab leans open
  let pointed = null; // the pane whose tab is under the pointer
  let keyed = null; // the pane whose tab holds keyboard focus
  let leanAt = null; // the trail position the leaning edges were taken at

  function count() {
    return options.panes().length;
  }

  function shape(n = count()) {
    return trailShape(n, focused, metrics);
  }

  // The tab width and widening the trail should settle into for its panes.
  function aimShape() {
    const next = shape();
    springS.target = next.spine;
    springE.target = next.extra;
    return next;
  }

  function snapAll() {
    for (const spring of springs) {
      spring.x = spring.target;
      spring.v = 0;
    }
  }

  function currentFrames(panes) {
    const shownP = dragging ? rubberBand(springP.x, maxPosition(panes.length, shape(panes.length).open)) : springP.x;
    return paneFrames(panes.length, shownP, springS.x, springE.x, metrics, leanedTabs(panes));
  }

  // --- leaning tabs ----------------------------------------------------------
  function leanedTabs(panes) {
    if (!leanAt) return undefined;
    // Only the left edge is a stack of tabs: on the right, the nearest
    // pane covers the deeper ones and shows as one.
    const weights = panes.map((pane) => (leans.has(pane.el) ? leans.get(pane.el).x : 0));
    return leanTabs(Math.max(0, springS.x), weights, [[0, Math.min(panes.length, leanAt.p)]]);
  }

  // A lean starts only on a trail at rest, and keeps the edges it started
  // with until it has let go: a trail on the move lets every tab go first.
  function leanable() {
    if (dragging || Math.abs(springP.x - springP.target) > 0.01) return false;
    return !leanAt || leanAt.p === Math.round(springP.target);
  }

  function updateLean() {
    const shown = options.panes().map((pane) => pane.el);
    const asked = pointed || keyed;
    const want = asked && shown.includes(asked) && leanable() ? asked : null;
    if (want && !leanAt) leanAt = { p: Math.round(springP.target) };
    if (want && !leans.has(want)) leans.set(want, { x: 0, v: 0, target: 0 });
    let changed = false;
    for (const [el, spring] of leans) {
      if (!shown.includes(el)) {
        leans.delete(el);
        continue;
      }
      const target = el === want ? 1 : 0;
      if (spring.target !== target) changed = true;
      spring.target = target;
      if (shouldReduceMotion()) {
        spring.x = target;
        spring.v = 0;
      }
    }
    if (changed) schedule();
  }

  // Every tab has let go: the edges are forgotten with it.
  function releaseLeans() {
    for (const spring of leans.values()) if (spring.target || spring.x) return;
    leans.clear();
    leanAt = null;
  }

  function paneOfSpine(target) {
    const spine = target instanceof Element ? target.closest(".pane-spine") : null;
    const pane = spine ? options.panes().find((candidate) => candidate.spine === spine) : null;
    return pane ? pane.el : null;
  }

  function onPointerOver(e) {
    if (e.pointerType === "touch") return;
    pointed = paneOfSpine(e.target);
    updateLean();
  }

  // Tabbing along the edge names each tab as the pointer would.
  function onFocusIn(e) {
    keyed = e.target instanceof Element && e.target.matches(":focus-visible") ? paneOfSpine(e.target) : null;
    updateLean();
  }

  function onFocusOut() {
    keyed = null;
    updateLean();
  }

  function onPointerLeave() {
    pointed = null;
    updateLean();
  }

  function measure() {
    const next = trailMetrics(stage.clientWidth, { compact: options.compact() });
    const changed =
      !metrics || next.cap !== metrics.cap || next.paneWidth !== metrics.paneWidth || next.stage !== metrics.stage;
    metrics = next;
    if (changed && options.onMetrics) options.onMetrics(metrics);
    return changed;
  }

  // `rest`: the trail has come to a stop. Making a pane inert or hidden
  // restyles its whole document — tens of milliseconds for a long one — so
  // those wait for the stop and never land mid-slide. Showing a pane cannot
  // wait: it must be there as it slides into view.
  function paint(rest) {
    const panes = options.panes();
    const frames = currentFrames(panes);
    // Every pane is one width. A text's measure follows its pane's (base.css),
    // so a change of width may re-wrap it: whoever reads it keeps their line.
    const box = frames.length ? frames[0].box.toFixed(2) + "px" : "";
    const resize = function () {
      for (const pane of panes) pane.el.style.width = box;
    };
    if (box !== paintedBox && options.keepPlace) options.keepPlace(resize);
    else resize();
    paintedBox = box;
    for (let i = 0; i < panes.length; i++) {
      const { el, scroll, spine } = panes[i];
      const f = frames[i];
      const tab = Math.max(0, f.tab);
      const fold = foldAmount(f.exposed, tab, f.box);
      el.style.transform = "translate3d(" + f.x.toFixed(2) + "px,0,0)";
      el.style.zIndex = String(f.z);
      spine.style.width = tab.toFixed(2) + "px";
      spine.classList.toggle("pane-spine-sliver", !spineTitled(tab));
      const covered = f.exposed < 0.5;
      if (!covered) el.style.visibility = "";
      if (rest) {
        if (covered) el.style.visibility = "hidden";
        if (el.inert !== covered) el.inert = covered;
        if (scroll.inert !== fold > 0.5) scroll.inert = fold > 0.5;
      }
      scroll.style.opacity = fold ? String(1 - Math.min(1, fold * 1.15)) : "";
      spine.style.opacity = metrics.spine ? String(fold) : "0";
      spine.style.pointerEvents = fold > 0.5 ? "auto" : "none";
      spine.tabIndex = fold > 0.5 && !covered ? 0 : -1;
      el.classList.toggle("pane-folded", fold > 0.5);
    }
    if (options.onFrame) options.onFrame(frames, metrics, springE.x);
  }

  function step(now) {
    frame = 0;
    const dt = Math.min(0.05, Math.max(0.001, (now - (lastTime || now)) / 1000 || 1 / 60));
    lastTime = now;
    let moving = false;
    for (const spring of [...springs, ...leans.values()]) {
      if (dragging && spring === springP) continue;
      advance(spring, dt);
      if (Math.abs(spring.x - spring.target) > REST || Math.abs(spring.v) > REST) moving = true;
      else {
        spring.x = spring.target;
        spring.v = 0;
      }
    }
    paint(!moving && !dragging);
    releaseLeans();
    updateLean();
    if (moving || dragging) schedule();
    else {
      lastTime = 0;
      settled();
    }
  }

  function settled() {
    if (settledAt === springP.x) return;
    settledAt = springP.x;
    if (options.onSettle) options.onSettle(springP.x);
  }

  function schedule() {
    if (frame) return;
    // A hidden window never runs rAF; arrive instantly rather than never.
    if (document.hidden) {
      snapAll();
      paint(true);
      settled();
      return;
    }
    frame = requestAnimationFrame(step);
  }

  /**
   * Move to pane position `p`, with the tabs and widths the trail's panes now
   * call for. `instant` skips the spring — used when the reader first
   * appears, under its own flight.
   */
  function moveTo(p, { instant = false } = {}) {
    const n = count();
    const { open } = aimShape();
    springP.target = Math.max(0, Math.min(maxPosition(n, open), p));
    settledAt = NaN;
    if (instant || shouldReduceMotion()) {
      snapAll();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      paint(true);
      settled();
      return;
    }
    // Paint now: a pane created this tick must never show a frame unplaced.
    paint(false);
    schedule();
  }

  function position() {
    return springP.target;
  }

  function relayout() {
    measure();
    const n = count();
    // A window that now holds fewer (or more) panes keeps the document you
    // are in on screen, moving as little as it can.
    const { open } = aimShape();
    const focus = options.focusIndex ? options.focusIndex() : -1;
    const kept = Math.max(0, Math.min(maxPosition(n, open), Math.round(springP.target)));
    springP.target = focus >= 0 ? revealPosition(focus, kept, n, open) : kept;
    snapAll();
    settledAt = NaN;
    paint(true);
    settled();
  }

  /**
   * Focus one document: it alone stands open and everything before and after
   * it folds into tabs. Its text keeps its measure — only its margins grow.
   */
  function setFocused(value, index) {
    focused = !!value;
    const { open } = aimShape();
    const n = count();
    const kept = Math.max(0, Math.min(maxPosition(n, open), Math.round(springP.target)));
    springP.target = index >= 0 ? revealPosition(index, kept, n, open) : kept;
    settledAt = NaN;
    if (shouldReduceMotion()) {
      snapAll();
      paint(true);
      settled();
      return;
    }
    paint(false);
    schedule();
  }

  // One pane's width on screen: what a finger's travel is measured against.
  function boxWidth() {
    return Math.max(1, metrics.paneWidth + springE.x);
  }

  // --- trackpad -------------------------------------------------------------
  function scrollableAlong(target, dx) {
    for (let el = target; el && el !== stage; el = el.parentElement) {
      if (!(el instanceof HTMLElement) || el.scrollWidth <= el.clientWidth + 1) continue;
      const overflow = getComputedStyle(el).overflowX;
      if (overflow !== "auto" && overflow !== "scroll") continue;
      if (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0) return true;
    }
    return false;
  }

  function onWheel(e) {
    if (e.ctrlKey) return; // pinch zoom
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientWidth : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    const now = performance.now();
    if (!wheel || now - wheel.last > WHEEL_IDLE_MS) {
      // A new gesture decides its axis once, from its first decisive motion.
      wheel = { last: now, axis: null, sumX: 0, sumY: 0, native: false, samples: [] };
    }
    wheel.last = now;
    if (!wheel.axis) {
      wheel.sumX += Math.abs(dx);
      wheel.sumY += Math.abs(dy);
      if (wheel.sumX < AXIS_LOCK_PX && wheel.sumY < AXIS_LOCK_PX) {
        if (Math.abs(dx) > Math.abs(dy)) e.preventDefault();
        return;
      }
      wheel.axis = wheel.sumX > wheel.sumY ? "x" : "y";
      wheel.native = wheel.axis === "x" && scrollableAlong(e.target, dx);
    }
    if (wheel.axis !== "x" || wheel.native) return;
    e.preventDefault();
    if (count() < 2) return;
    dragging = true;
    springP.v = 0;
    springP.x += dx / boxWidth();
    wheel.samples.push({ t: now, dx: dx });
    while (wheel.samples.length > 2 && now - wheel.samples[0].t > 100) wheel.samples.shift();
    const max = maxPosition(count(), shape().open);
    springP.x = Math.max(-0.5, Math.min(max + 0.5, springP.x));
    scope.timeout(releaseWheelIfIdle, WHEEL_IDLE_MS + 10);
    schedule();
  }

  function releaseWheelIfIdle() {
    if (!wheel || !dragging || touch) return;
    if (performance.now() - wheel.last < WHEEL_IDLE_MS) return;
    // A flick carries on to the next pane; a hesitant half-swipe settles back.
    // (Trackpad momentum has usually spent itself by now, leaving this ~0.)
    const samples = wheel.samples;
    let velocity = 0;
    if (samples.length > 1) {
      const span = Math.max(16, samples[samples.length - 1].t - samples[0].t);
      const distance = samples.reduce((sum, sample) => sum + sample.dx, 0);
      velocity = (distance / boxWidth() / span) * 1000;
    }
    release(Math.max(-6, Math.min(6, velocity)));
  }

  function release(velocity) {
    dragging = false;
    const max = maxPosition(count(), shape().open);
    const shown = rubberBand(springP.x, max);
    springP.x = shown;
    // Where the motion was heading decides the pane it lands on.
    const projected = shown + velocity * 0.18;
    springP.target = Math.max(0, Math.min(max, Math.round(projected)));
    springP.v = velocity;
    settledAt = NaN;
    if (shouldReduceMotion()) {
      springP.x = springP.target;
      springP.v = 0;
    }
    schedule();
  }

  // --- touch -----------------------------------------------------------------
  function onPointerDown(e) {
    if (e.pointerType !== "touch" || touch) return;
    touch = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      p0: springP.x,
      live: false,
      samples: [{ t: performance.now(), x: e.clientX }],
    };
  }

  function onPointerMove(e) {
    if (!touch || e.pointerId !== touch.id) return;
    const dx = e.clientX - touch.x0;
    const dy = e.clientY - touch.y0;
    if (!touch.live) {
      if (Math.abs(dx) < TOUCH_SLOP || Math.abs(dx) < Math.abs(dy) * 1.2) {
        if (Math.abs(dy) > TOUCH_SLOP) touch = null; // a vertical read, not ours
        return;
      }
      if (scrollableAlong(/** @type {Element} */ (e.target), -dx)) {
        touch = null;
        return;
      }
      touch.live = true;
      touch.x0 = e.clientX;
      touch.p0 = springP.x;
      dragging = true;
      springP.v = 0;
      try {
        stage.setPointerCapture(e.pointerId);
      } catch (err) {}
    }
    const now = performance.now();
    touch.samples.push({ t: now, x: e.clientX });
    while (touch.samples.length > 2 && now - touch.samples[0].t > 90) touch.samples.shift();
    springP.x = touch.p0 - (e.clientX - touch.x0) / boxWidth();
    schedule();
  }

  function onPointerUp(e) {
    if (!touch || e.pointerId !== touch.id) return;
    const t = touch;
    touch = null;
    if (!t.live) return;
    const first = t.samples[0];
    const last = t.samples[t.samples.length - 1];
    const ms = Math.max(1, last.t - first.t);
    // px/ms → panes/s, sign flipped: dragging right walks back up the trail.
    const velocity = (-(last.x - first.x) / ms / boxWidth()) * 1000;
    release(Math.max(-6, Math.min(6, velocity)));
  }

  scope.listen(stage, "wheel", onWheel, { passive: false });
  scope.listen(stage, "pointerdown", onPointerDown, { passive: true });
  scope.listen(stage, "pointermove", onPointerMove, { passive: true });
  scope.listen(stage, "pointerup", onPointerUp, { passive: true });
  scope.listen(stage, "pointercancel", onPointerUp, { passive: true });
  scope.listen(stage, "pointerover", onPointerOver, { passive: true });
  scope.listen(stage, "pointerleave", onPointerLeave, { passive: true });
  scope.listen(stage, "focusin", onFocusIn);
  scope.listen(stage, "focusout", onFocusOut);
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(function () {
      if (measure()) relayout();
    });
    observer.observe(stage);
    scope.addCleanup(function () {
      observer.disconnect();
    });
  }
  scope.addCleanup(function () {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  });

  return {
    moveTo: moveTo,
    position: position,
    relayout: relayout,
    metrics: function () {
      return metrics;
    },
    frames: function () {
      return currentFrames(options.panes());
    },
    /** How many panes stand open once the trail settles. */
    openCount: function () {
      return shape().open;
    },
    /** How many open panes the text is measured for now. */
    setFocused: setFocused,
    focused: function () {
      return focused;
    },
    isMoving: function () {
      return !!frame || dragging;
    },
    dispose: function () {
      scope.dispose();
    },
  };
}

// Critically damped: the fastest approach to the target that never overshoots.
function advance(spring, dt) {
  const w = RESPONSE;
  const delta = spring.x - spring.target;
  const decay = Math.exp(-w * dt);
  const next = (delta + (spring.v + w * delta) * dt) * decay;
  spring.v = (spring.v - w * (spring.v + w * delta) * dt) * decay;
  spring.x = spring.target + next;
}
