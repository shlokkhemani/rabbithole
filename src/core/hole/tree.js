/** @typedef {import("../contracts/engine.js").HoleNode} HoleNode */
/** @typedef {Map<string, HoleNode> | Record<string, HoleNode>} NodeCollection */

/** @param {NodeCollection} nodes @param {string | null} parentId */
export function childrenOf(nodes, parentId) {
  return [...valuesOfNodes(nodes)].filter((node) => (node.parent_id ?? null) === parentId);
}

/** @param {NodeCollection} nodes @param {string} rootId @returns {string[]} */
export function collectSubtreeIds(nodes, rootId) {
  const doomed = new Set();
  const children = new Map();
  for (const node of valuesOfNodes(nodes)) {
    if (!node.parent_id) continue;
    const siblings = children.get(node.parent_id);
    if (siblings) siblings.push(node.id);
    else children.set(node.parent_id, [node.id]);
  }
  const pending = [rootId];
  while (pending.length) {
    const id = pending.pop();
    if (!id || doomed.has(id)) continue;
    doomed.add(id);
    const descendants = children.get(id);
    if (descendants) pending.push(...descendants);
  }
  return [...doomed];
}

/**
 * Return every node in deterministic depth-first order. The document root is
 * visited first, followed by parentless canvas nodes, then any malformed
 * disconnected components so legacy data is never silently omitted.
 * @param {NodeCollection} nodes
 * @param {string | null} rootId
 * @returns {HoleNode[]}
 */
export function depthFirstNodes(nodes, rootId) {
  const all = [...valuesOfNodes(nodes)];
  const byId = new Map(all.map((node) => [node.id, node]));
  /** @type {Map<string | null, HoleNode[]>} */
  const children = new Map();
  for (const node of all) {
    const parentId = node.parent_id ?? null;
    const siblings = children.get(parentId);
    if (siblings) siblings.push(node);
    else children.set(parentId, [node]);
  }
  /** @param {HoleNode} a @param {HoleNode} b */
  const compareByAge = (a, b) => String(a.created_at || "").localeCompare(String(b.created_at || ""))
    || String(a.id).localeCompare(String(b.id));
  for (const siblings of children.values()) siblings.sort(compareByAge);

  /** @type {HoleNode[]} */
  const ordered = [];
  const visited = new Set();
  /** @param {HoleNode | undefined} node */
  const visit = (node) => {
    if (!node || visited.has(node.id)) return;
    visited.add(node.id);
    ordered.push(node);
    for (const child of children.get(node.id) || []) visit(child);
  };

  if (rootId) visit(byId.get(rootId));
  for (const node of children.get(null) || []) {
    if (node.id !== rootId) visit(node);
  }
  for (const node of [...all].sort(compareByAge)) visit(node);
  return ordered;
}

/** @param {NodeCollection} nodes @param {string} nodeId @returns {HoleNode[]} */
export function lineageNodesFromMap(nodes, nodeId) {
  /** @type {HoleNode[]} */
  const path = [];
  /** @type {HoleNode | null | undefined} */
  let current = getNode(nodes, nodeId);
  const guard = new Set();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    path.push(current);
    current = current.parent_id ? getNode(nodes, current.parent_id) : null;
  }
  return path.reverse();
}

/** @param {NodeCollection} nodes @param {string} nodeId */
export function lineageTitlesFromMap(nodes, nodeId) {
  return lineageNodesFromMap(nodes, nodeId).map((node) => node.title || "Untitled");
}

/** @param {NodeCollection} nodes @param {string} id @returns {HoleNode | undefined} */
function getNode(nodes, id) {
  return /** @type {HoleNode | undefined} */ (nodes instanceof Map ? nodes.get(id) : nodes?.[id]);
}

/** @param {NodeCollection} nodes @returns {Iterable<HoleNode>} */
export function valuesOfNodes(nodes) {
  return nodes instanceof Map ? nodes.values() : Object.values(nodes || {});
}
