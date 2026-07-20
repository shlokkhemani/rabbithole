function bezierCoord(t, a, b){
  var mt = 1 - t;
  return 3 * mt * mt * t * a + 3 * mt * t * t * b + t * t * t;
}

function bezierSlope(t, a, b){
  return 3 * (1 - t) * (1 - t) * a + 6 * (1 - t) * t * (b - a) + 3 * t * t * (1 - b);
}

function cubicBezier(x1, y1, x2, y2, x){
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  var t = x, i, xAt, slope;
  for (i = 0; i < 5; i++){
    xAt = bezierCoord(t, x1, x2) - x;
    slope = bezierSlope(t, x1, x2);
    if (Math.abs(xAt) < 0.001 || !slope) break;
    t -= xAt / slope;
  }
  if (t < 0 || t > 1){
    var lo = 0, hi = 1;
    t = x;
    for (i = 0; i < 8; i++){
      xAt = bezierCoord(t, x1, x2);
      if (xAt < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
  }
  return bezierCoord(t, y1, y2);
}

export function easeOutMotion(k){ return cubicBezier(0.23, 1, 0.32, 1, k); }
export function easeInOutMotion(k){ return cubicBezier(0.77, 0, 0.175, 1, k); }
