import { shouldReduceMotion } from "../core.js";
import { createCleanupScope } from "../kit/scope.js";
import {
  centreOffset,
  foldAmount,
  maxPosition,
  paneFrames,
  revealPosition,
  rubberBand,
  trailMetrics,
} from "./layout.js";

/*
 * The stage turns one number into motion. `p` (which pane leads) and the
 * lone-document centring offset each ride a critically damped spring, so every
 * way of moving — a trackpad swipe, a touch drag, a click, a key, a new
 * answer — shares one physics and can interrupt any other mid-flight without
 * a seam. Direct manipulation is 1:1: while fingers are down, the panes are
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
 *   panes: () => { el: HTMLElement, scroll: HTMLElement, spine: HTMLElement, wide: boolean }[],
 *   compact: () => boolean,
 *   focusIndex?: () => number,
 *   onFrame?: (frames: ReturnType<typeof paneFrames>, metrics: ReturnType<typeof trailMetrics>) => void,
 *   onSettle?: (position: number) => void,
 *   onMetrics?: (metrics: ReturnType<typeof trailMetrics>) => void,
 * }} options
 */
export function createTrailStage(options) {
  const scope = createCleanupScope();
  const { stage } = options;
  let metrics = trailMetrics(stage.clientWidth, { compact: options.compact() });
  const springP = { x: 0, v: 0, target: 0 };
  const springO = { x: 0, v: 0, target: 0 };
  let frame = 0;
  let lastTime = 0;
  let dragging = false; // a finger or a live trackpad gesture owns p
  let wheel = null;
  let touch = null;
  let settledAt = 0;

  function count() {
    return options.panes().length;
  }

  function wideLone(panes) {
    return panes.length === 1 && metrics.cap > 1 && panes[0].wide;
  }

  function measure() {
    const next = trailMetrics(stage.clientWidth, { compact: options.compact() });
    const changed =
      !metrics || next.cap !== metrics.cap || next.paneWidth !== metrics.paneWidth || next.left !== metrics.left;
    metrics = next;
    if (changed && options.onMetrics) options.onMetrics(metrics);
    return changed;
  }

  function paint() {
    const panes = options.panes();
    const shownP = dragging ? rubberBand(springP.x, maxPosition(panes.length, metrics.cap)) : springP.x;
    const frames = paneFrames(panes.length, shownP, springO.x, metrics);
    // A page (a native PDF) alone in the reader takes the whole band: its zoom
    // needs the room, and there is nothing yet to share it with.
    const wide = wideLone(panes);
    if (wide) frames[0].x = metrics.left + metrics.spine;
    for (let i = 0; i < panes.length; i++) {
      const { el, scroll, spine } = panes[i];
      const f = frames[i];
      const fold = foldAmount(f.exposed, metrics);
      el.style.transform = "translate3d(" + f.x.toFixed(2) + "px,0,0)";
      el.style.zIndex = String(f.z);
      el.style.width = (wide ? metrics.band - 2 * metrics.spine : metrics.paneWidth) + "px";
      const covered = f.exposed < 0.5;
      el.style.visibility = covered ? "hidden" : "";
      el.inert = covered;
      scroll.style.opacity = fold ? String(1 - Math.min(1, fold * 1.15)) : "";
      scroll.inert = fold > 0.5;
      spine.style.opacity = metrics.spine ? String(fold) : "0";
      spine.style.pointerEvents = fold > 0.5 ? "auto" : "none";
      spine.tabIndex = fold > 0.5 && !covered ? 0 : -1;
      el.classList.toggle("pane-folded", fold > 0.5);
    }
    if (options.onFrame) options.onFrame(frames, metrics);
  }

  function step(now) {
    frame = 0;
    const dt = Math.min(0.05, Math.max(0.001, (now - (lastTime || now)) / 1000 || 1 / 60));
    lastTime = now;
    let moving = false;
    for (const spring of [springP, springO]) {
      if (dragging && spring === springP) continue;
      advance(spring, dt);
      if (Math.abs(spring.x - spring.target) > REST || Math.abs(spring.v) > REST) moving = true;
      else {
        spring.x = spring.target;
        spring.v = 0;
      }
    }
    paint();
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
      springP.x = springP.target;
      springO.x = springO.target;
      springP.v = springO.v = 0;
      paint();
      settled();
      return;
    }
    frame = requestAnimationFrame(step);
  }

  /**
   * Move to pane position `p` (and centring for `n` panes). `instant` skips
   * the spring — used when the reader first appears, under its own flight.
   */
  function moveTo(p, { instant = false } = {}) {
    const n = count();
    springP.target = Math.max(0, Math.min(maxPosition(n, metrics.cap), p));
    springO.target = centreOffset(n, metrics);
    settledAt = NaN;
    if (instant || shouldReduceMotion()) {
      springP.x = springP.target;
      springO.x = springO.target;
      springP.v = springO.v = 0;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      paint();
      settled();
      return;
    }
    // Paint now: a pane created this tick must never show a frame unplaced.
    paint();
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
    const focus = options.focusIndex ? options.focusIndex() : -1;
    const kept = Math.max(0, Math.min(maxPosition(n, metrics.cap), Math.round(springP.target)));
    springP.target = focus >= 0 ? revealPosition(focus, kept, n, metrics.cap) : kept;
    springP.x = springP.target;
    springO.x = springO.target = centreOffset(n, metrics);
    springP.v = springO.v = 0;
    settledAt = NaN;
    paint();
    settled();
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
    if (count() < 2 && metrics.cap > 1) return;
    dragging = true;
    springP.v = 0;
    springP.x += dx / Math.max(1, metrics.paneWidth);
    wheel.samples.push({ t: now, dx: dx });
    while (wheel.samples.length > 2 && now - wheel.samples[0].t > 100) wheel.samples.shift();
    const max = maxPosition(count(), metrics.cap);
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
      velocity = (distance / Math.max(1, metrics.paneWidth) / span) * 1000;
    }
    release(Math.max(-6, Math.min(6, velocity)));
  }

  function release(velocity) {
    dragging = false;
    const max = maxPosition(count(), metrics.cap);
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
    springP.x = touch.p0 - (e.clientX - touch.x0) / Math.max(1, metrics.paneWidth);
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
    const velocity = (-(last.x - first.x) / ms / Math.max(1, metrics.paneWidth)) * 1000;
    release(Math.max(-6, Math.min(6, velocity)));
  }

  scope.listen(stage, "wheel", onWheel, { passive: false });
  scope.listen(stage, "pointerdown", onPointerDown, { passive: true });
  scope.listen(stage, "pointermove", onPointerMove, { passive: true });
  scope.listen(stage, "pointerup", onPointerUp, { passive: true });
  scope.listen(stage, "pointercancel", onPointerUp, { passive: true });
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
      const panes = options.panes();
      const frames = paneFrames(panes.length, springP.x, springO.x, metrics);
      if (wideLone(panes)) frames[0].x = metrics.left + metrics.spine;
      return frames;
    },
    /** The on-screen width of the pane at `index` (a lone page is wider). */
    paneBoxWidth: function (index) {
      return index === 0 && wideLone(options.panes()) ? metrics.band - 2 * metrics.spine : metrics.paneWidth;
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
