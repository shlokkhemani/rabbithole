/** @typedef {import("./contracts/engine.js").HoleNode} HoleNode */

/**
 * Create a debounced, serialized persistence queue. `save` is called at flush
 * time so hosts can capture their snapshot synchronously; it returns the write
 * operation that is then serialized behind earlier writes.
 *
 * @param {{ save: () => (() => Promise<unknown>), debounceMs: number, onTimerChange?: (timer: ReturnType<typeof setTimeout> | null) => void }} options
 */
export function createSaveChain({ save, debounceMs, onTimerChange = () => {} }) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {Promise<unknown>} */
  let savingChain = Promise.resolve();

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      onTimerChange(null);
    }
    const write = save();
    savingChain = savingChain.catch(() => {}).then(write);
    return savingChain;
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    onTimerChange(timer);
  }

  function cancel() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    onTimerChange(null);
  }

  return { schedule, flush, cancel };
}

/**
 * @param {{ deletedNodes: Iterable<object>, remainingNodes: Iterable<object>, extractRefs: (node: object) => Iterable<string> }} options
 * @returns {string[]}
 */
export function assetsOrphanedByDeletion({ deletedNodes, remainingNodes, extractRefs }) {
  const deletedRefs = new Set();
  for (const node of deletedNodes) {
    for (const name of extractRefs(node)) deletedRefs.add(name);
  }
  if (!deletedRefs.size) return [];

  const remainingRefs = new Set();
  for (const node of remainingNodes) {
    for (const name of extractRefs(node)) remainingRefs.add(name);
  }
  return [...deletedRefs].filter((name) => !remainingRefs.has(name));
}

/** @param {HoleNode} node @param {Record<string, unknown>} [overrides] */
export function buildNodeAnsweredEvent(node, overrides = {}) {
  return {
    type: "node_answered",
    node_id: node.id,
    parent_id: node.parent_id,
    title: node.title,
    markdown: node.markdown,
    base_url: node.base_url,
    base_url_source: node.base_url_source,
    origin: node.origin,
    position: node.position,
    size: node.size,
    font_scale: node.font_scale,
    ...overrides,
  };
}

/**
 * Apply a browser event to canonical state and request its debounced persist.
 * @param {any} payload
 * @param {{ dispatch: (event: any) => unknown, scheduleSave: () => void }} host
 */
export function applyPersistedBrowserEvent(payload, { dispatch, scheduleSave }) {
  dispatch({ ...payload, type: String(payload?.type ?? "") });
  scheduleSave();
  return { ok: true };
}

/**
 * Dispatch the browser event vocabulary while hosts retain the transport and
 * side effects behind each handler.
 *
 * @param {unknown} payload
 * @param {{ handlers: Record<string, (payload: any) => any>, unsupported: (type: string) => never }} options
 */
export function dispatchBrowserEvent(payload, { handlers, unsupported }) {
  const type = String(/** @type {any} */ (payload)?.type ?? "");
  switch (type) {
    case "branch_request":
    case "retry_branch":
    case "node_update":
    case "nodes_update":
    case "block_state":
    case "node_extensions_patch":
    case "delete_node":
    case "view_state":
    case "done": {
      const handler = handlers[type];
      return handler ? handler(payload) : unsupported(type);
    }
    default:
      return unsupported(type);
  }
}
