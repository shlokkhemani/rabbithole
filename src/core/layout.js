import { BRANCH_FOLLOWUP, BRANCH_SELECTION, branchTypeOfNode } from "./model.js";

/** @typedef {Omit<import("./contracts/engine.js").HoleNode, "origin"> & { origin?: { branch_type?: unknown, selected_text?: unknown } | null } & Record<string, any>} LayoutNode */
/** @typedef {{ minX: number, minY: number, maxX: number, maxY: number }} Bounds */
/** @typedef {(nodeId: string) => LayoutNode[]} ChildrenOf */
/** @typedef {(node: LayoutNode) => number} EffectiveHeight */

export const DEFAULT_ROOT = Object.freeze({ w: 480, h: 580 });
export const DEFAULT_CHILD = Object.freeze({ w: 420, h: 460 });
export const TREE_PARENT_GAP = 70;
export const TREE_STACK_GAP = 30;

/** @param {LayoutNode} a @param {LayoutNode} b */
export function nodeOrder(a, b) {
  return ((a?._order || 0) - (b?._order || 0)) || String(a?.id || "").localeCompare(String(b?.id || ""));
}

/** @param {LayoutNode | null | undefined} node */
function nodeX(node) {
  return Number(node?.x ?? node?.position?.x) || 0;
}

/** @param {LayoutNode | null | undefined} node */
function nodeY(node) {
  return Number(node?.y ?? node?.position?.y) || 0;
}

/** @param {LayoutNode | null | undefined} node @param {number} [fallback] */
function nodeW(node, fallback = DEFAULT_CHILD.w) {
  return Number(node?.w ?? node?.size?.w) || fallback;
}

/** @param {LayoutNode | null | undefined} node @param {number} [fallback] */
function nodeH(node, fallback = DEFAULT_CHILD.h) {
  return Number(node?.h ?? node?.size?.h) || fallback;
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
