import { BRANCH_FOLLOWUP, BRANCH_SELECTION, branchTypeOfNode } from "./hole/ask.js";

/** @typedef {Omit<import("./contracts/engine.js").HoleNode, "origin"> & { origin?: { branch_type?: unknown, selected_text?: unknown } | null } & Record<string, any>} LayoutNode */
/** @typedef {{ minX: number, minY: number, maxX: number, maxY: number }} Bounds */
/** @typedef {(nodeId: string) => LayoutNode[]} ChildrenOf */
/** @typedef {(node: LayoutNode) => number} EffectiveHeight */

export const DEFAULT_ROOT = Object.freeze({ w: 480, h: 580 });
export const DEFAULT_CHILD = Object.freeze({ w: 420, h: 460 });
export const DEFAULT_STANDALONE_NOTE = Object.freeze({ w: 300, h: 180 });
export const TREE_PARENT_GAP = 70;
export const TREE_STACK_GAP = 30;

/** @param {LayoutNode} a @param {LayoutNode} b */
export function nodeOrder(a, b) {
  return ((a?._order || 0) - (b?._order || 0)) || String(a?.id || "").localeCompare(String(b?.id || ""));
}

/** @param {LayoutNode | null | undefined} node */
function nodeX(node) {
  return Number(node?.position?.x) || 0;
}

/** @param {LayoutNode | null | undefined} node */
function nodeY(node) {
  return Number(node?.position?.y) || 0;
}

/** @param {LayoutNode | null | undefined} node @param {number} [fallback] */
function nodeW(node, fallback = DEFAULT_CHILD.w) {
  return Number(node?.size?.w) || fallback;
}

/** @param {LayoutNode | null | undefined} node @param {number} [fallback] */
function nodeH(node, fallback = DEFAULT_CHILD.h) {
  return Number(node?.size?.h) || fallback;
}

/** @param {LayoutNode} node @param {{ effH?: EffectiveHeight | null }} [options] @returns {Bounds} */
export function nodeBounds(node, { effH = null } = {}) {
  const x = nodeX(node);
  const y = nodeY(node);
  const w = nodeW(node);
  const h = typeof effH === "function" ? effH(node) : nodeH(node);
  return { minX: x, minY: y, maxX: x + w, maxY: y + h };
}

/**
 * @overload
 * @param {Bounds} a
 * @param {Bounds | null | undefined} b
 * @returns {Bounds}
 */
/**
 * @overload
 * @param {Bounds | null | undefined} a
 * @param {Bounds} b
 * @returns {Bounds}
 */
/** @param {Bounds | null | undefined} a @param {Bounds | null | undefined} b @returns {Bounds | null | undefined} */
export function unionBounds(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** @param {Bounds} bounds @param {number} dx @param {number} dy */
export function shiftBounds(bounds, dx, dy) {
  return {
    minX: bounds.minX + dx,
    minY: bounds.minY + dy,
    maxX: bounds.maxX + dx,
    maxY: bounds.maxY + dy,
  };
}

/** @param {Bounds | null | undefined} a @param {Bounds | null | undefined} b */
export function boundsOverlap(a, b) {
  return !!(a && b && a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY);
}

/** @param {LayoutNode} node @param {{ childrenOf?: ChildrenOf, effH?: EffectiveHeight | null, sort?: typeof nodeOrder }} [options] @returns {Bounds} */
export function subtreeBounds(node, { childrenOf, effH = null, sort = nodeOrder } = {}) {
  let bounds = nodeBounds(node, { effH });
  if (!node?.collapsed && typeof childrenOf === "function") {
    for (const child of childrenOf(node.id).sort(sort)) {
      bounds = unionBounds(bounds, subtreeBounds(child, { childrenOf, effH, sort }));
    }
  }
  return bounds;
}

/**
 * Compute tidy canvas positions for the tree rooted at `root`.
 *
 * The placement rules are the canvas's settled reading order:
 * - selection branches form one rail to the right of their parent, stacked
 *   vertically;
 * - one follow-up branch chains directly below its parent;
 * - two or more follow-up branches fan out into one row below their parent.
 *   Chaining them would put every sibling on one axis, where the cards hide
 *   each other's parent→child edges and a fork reads as a linear list.
 *
 * The fan row is centered on the parent and packed left to right by each
 * sibling's measured subtree, so a descendant that reaches back past its own
 * card cannot overlap the previous sibling. Rows also stay clear of the
 * ancestor cards and rails already placed above them.
 *
 * Deterministic and DOM-free: the caller supplies children and effective
 * heights, then applies the returned map to node state. Only nodes reachable
 * from `root` receive a position.
 *
 * @param {{ root: LayoutNode, childrenOf: ChildrenOf, effH?: EffectiveHeight | null, sort?: typeof nodeOrder }} options
 * @returns {Map<string, { x: number, y: number }>}
 */
export function tidyPositions({ root, childrenOf, effH = null, sort = nodeOrder }) {
  /** @type {Map<string, { x: number, y: number }>} */
  const positions = new Map();
  /** @param {LayoutNode} node */
  const heightOf = (node) => (typeof effH === "function" ? effH(node) : nodeH(node));

  /** @param {LayoutNode} node @returns {Bounds} */
  function placedBounds(node) {
    const position = positions.get(node.id);
    if (!position) throw new Error(`tidyPositions: node ${node.id} has no position`);
    return { minX: position.x, minY: position.y, maxX: position.x + nodeW(node), maxY: position.y + heightOf(node) };
  }

  /** @param {LayoutNode} node @param {number} dx @param {number} dy */
  function moveSubtree(node, dx, dy) {
    for (const child of childrenOf(node.id)) {
      if (positions.has(child.id)) moveSubtree(child, dx, dy);
    }
    const position = positions.get(node.id);
    if (!position) return;
    position.x += dx;
    position.y += dy;
  }

  /** @param {LayoutNode} child @param {number} x @param {number} y @param {Bounds | null} blocked @returns {Bounds} */
  function placeBelow(child, x, y, blocked) {
    let childBounds = place(child, x, y, blocked);
    if (blocked && boundsOverlap(childBounds, blocked)) {
      const dy = blocked.maxY + TREE_STACK_GAP - childBounds.minY;
      moveSubtree(child, 0, dy);
      childBounds = shiftBounds(childBounds, 0, dy);
    }
    return childBounds;
  }

  /** @param {LayoutNode[]} children @param {number} centerX @param {number} y @param {Bounds | null} blocked @returns {Bounds} */
  function placeFan(children, centerX, y, blocked) {
    /** @type {Array<{ child: LayoutNode, bounds: Bounds }>} */
    const row = [];
    let cursor = 0;
    for (const child of children) {
      let childBounds = place(child, cursor, y, blocked);
      // Pack by the whole subtree's left edge, so a descendant that reaches
      // back past the child's own card cannot overlap the previous sibling.
      const dx = cursor - childBounds.minX;
      if (dx) {
        moveSubtree(child, dx, 0);
        childBounds = shiftBounds(childBounds, dx, 0);
      }
      row.push({ child, bounds: childBounds });
      cursor = childBounds.maxX + TREE_STACK_GAP;
    }
    const head = row[0];
    if (!head) throw new Error("tidyPositions: a fan row needs at least one child");
    let rowBounds = head.bounds;
    for (const entry of row.slice(1)) rowBounds = unionBounds(rowBounds, entry.bounds);
    const dx = centerX - (rowBounds.minX + rowBounds.maxX) / 2;
    let dy = 0;
    if (blocked && boundsOverlap(shiftBounds(rowBounds, dx, 0), blocked)) {
      dy = blocked.maxY + TREE_STACK_GAP - rowBounds.minY;
    }
    if (dx || dy) {
      for (const entry of row) moveSubtree(entry.child, dx, dy);
      rowBounds = shiftBounds(rowBounds, dx, dy);
    }
    return rowBounds;
  }

  /** @param {LayoutNode} node @param {number} x @param {number} y @param {Bounds | null} reserved @returns {Bounds} */
  function place(node, x, y, reserved) {
    positions.set(node.id, { x, y });
    const nodeRect = placedBounds(node);
    const children = childrenOf(node.id).slice().sort(sort);
    const selectionKids = children.filter((child) => branchTypeOfNode(child) === BRANCH_SELECTION);
    const followupKids = children.filter((child) => branchTypeOfNode(child) === BRANCH_FOLLOWUP);

    let bounds = nodeRect;
    let railBounds = null;
    const railX = x + nodeW(node) + TREE_PARENT_GAP;
    let railY = y;
    for (const child of selectionKids) {
      const childBounds = place(child, railX, railY, unionBounds(reserved, nodeRect));
      railBounds = unionBounds(railBounds, childBounds);
      bounds = unionBounds(bounds, childBounds);
      railY = childBounds.maxY + TREE_STACK_GAP;
    }

    const blocked = reserved && railBounds ? unionBounds(reserved, railBounds) : reserved || railBounds;
    const belowY = y + heightOf(node) + TREE_PARENT_GAP;
    const single = followupKids.length === 1 ? followupKids[0] : null;
    if (single) {
      bounds = unionBounds(bounds, placeBelow(single, x, belowY, blocked));
    } else if (followupKids.length > 1) {
      bounds = unionBounds(bounds, placeFan(followupKids, x + nodeW(node) / 2, belowY, blocked));
    }
    return bounds;
  }

  place(root, 0, 0, null);
  return positions;
}

/** @param {LayoutNode} parent @param {unknown} branchType @param {{ childrenOf?: ChildrenOf, effH?: EffectiveHeight | null, sort?: typeof nodeOrder, childSize?: { w: number, h: number } }} [options] */
export function placeChild(parent, branchType, { childrenOf, effH = null, sort = nodeOrder, childSize = DEFAULT_CHILD } = {}) {
  const type = branchType === BRANCH_SELECTION ? BRANCH_SELECTION : BRANCH_FOLLOWUP;
  const parentX = nodeX(parent);
  const parentY = nodeY(parent);
  const parentW = nodeW(parent);
  const x = type === BRANCH_SELECTION ? parentX + parentW + TREE_PARENT_GAP : parentX;
  let y = type === BRANCH_SELECTION ? parentY : parentY + (typeof effH === "function" ? effH(parent) : nodeH(parent)) + TREE_PARENT_GAP;
  const siblings = typeof childrenOf === "function" ? childrenOf(parent.id).sort(sort) : [];
  for (const sibling of siblings) {
    if (branchTypeOfNode(sibling) === type) {
      y = Math.max(y, subtreeBounds(sibling, { childrenOf, effH, sort }).maxY + TREE_STACK_GAP);
    }
  }
  const blockers = siblings
    .filter((sibling) => branchTypeOfNode(sibling) !== type)
    .map((sibling) => subtreeBounds(sibling, { childrenOf, effH, sort }))
    .sort((a, b) => (a.minY - b.minY) || (a.minX - b.minX));
  let candidate = { minX: x, minY: y, maxX: x + childSize.w, maxY: y + childSize.h };
  let bumped = true;
  let guard = 0;
  while (bumped && guard++ < 100) {
    bumped = false;
    for (const blocker of blockers) {
      if (boundsOverlap(candidate, blocker)) {
        y = blocker.maxY + TREE_STACK_GAP;
        candidate = { minX: x, minY: y, maxX: x + childSize.w, maxY: y + childSize.h };
        bumped = true;
      }
    }
  }
  return { x, y };
}
