/** @typedef {import("../contracts/artifact.js").PersistedViewState} PersistedViewState */

// Where-was-I is bounded: a hole with thousands of cards must not grow an
// unbounded view record, and nothing in it may be trusted as more than data.
const MAX_ID = 128;
const MAX_TRAIL = 64;
const MAX_PLACES = 256;

/** @param {unknown} value */
function nonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** @param {unknown} value @returns {value is string} */
function isId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID;
}

/** A record of node id → scroll offset, keeping only real, non-zero places. @param {unknown} raw */
function scrollMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  /** @type {Record<string, number>} */
  const out = {};
  let count = 0;
  for (const [id, value] of Object.entries(raw)) {
    if (count >= MAX_PLACES) break;
    const top = nonNegative(value);
    if (!isId(id) || !top) continue;
    out[id] = top;
    count++;
  }
  return count ? out : null;
}

/** PDF reading places: `${nodeId}:${surface}` → page, offset in it, zoom. @param {unknown} raw */
function pdfPlaces(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  /** @type {Record<string, { page: number, offset: number, left: number, zoom: number }>} */
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= MAX_PLACES) break;
    if (typeof key !== "string" || key.length > MAX_ID + 16 || !value || typeof value !== "object") continue;
    const place = /** @type {Record<string, unknown>} */ (value);
    const page = Math.floor(Number(place.page));
    if (!Number.isFinite(page) || page < 1) continue;
    out[key] = {
      page,
      offset: Math.min(1, Math.max(0, Number(place.offset) || 0)),
      left: Math.min(1, Math.max(0, Number(place.left) || 0)),
      zoom: Math.min(8, Math.max(0.5, Number(place.zoom) || 1)),
    };
    count++;
  }
  return count ? out : null;
}

/** The reader's trail: which documents stand side by side, where it rests, and whether one is read alone. @param {unknown} raw */
function readerTrail(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const reader = /** @type {Record<string, unknown>} */ (raw);
  const trail = Array.isArray(reader.trail) ? reader.trail.filter(isId).slice(0, MAX_TRAIL) : [];
  if (!trail.length) return null;
  return { trail, position: nonNegative(reader.position), focused: reader.focused === true };
}

/** @param {unknown} state @returns {Omit<PersistedViewState, "mode"> | null} */
export function normalizeBookmark(state) {
  if (!state || typeof state !== "object") return null;
  const raw = /** @type {Record<string, any>} */ (state);
  /** @type {Omit<PersistedViewState, "mode">} */
  const out = {
    node_id: typeof raw.node_id === "string" ? raw.node_id.slice(0, MAX_ID) : null,
  };
  if (raw.view && typeof raw.view === "object") {
    out.view = {
      x: Number(raw.view.x) || 0,
      y: Number(raw.view.y) || 0,
      scale: Math.min(2.5, Math.max(0.15, Number(raw.view.scale) || 1)),
    };
  }
  const reader = readerTrail(raw.reader);
  if (reader) out.reader = reader;
  const scrolls = scrollMap(raw.scrolls);
  if (scrolls) out.scrolls = scrolls;
  const cards = scrollMap(raw.cards);
  if (cards) out.cards = cards;
  const pdf = pdfPlaces(raw.pdf);
  if (pdf) out.pdf = pdf;
  return out;
}

/** Schema-v2 view state: where the human was, restored exactly on reopen. @param {unknown} state @returns {PersistedViewState | null} */
export function normalizeViewState(state) {
  const bookmark = normalizeBookmark(state);
  if (!bookmark) return null;
  return { mode: /** @type {any} */ (state).mode === "canvas" ? "canvas" : "reader", ...bookmark };
}
