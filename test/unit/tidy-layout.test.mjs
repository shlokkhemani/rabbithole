/** @protects tidy layout fan-out and card non-overlap capability contracts. */
import assert from "node:assert/strict";
import { tidyPositions } from "../../src/core/layout.js";

const ROOT_SIZE = { w: 480, h: 580 };
const BRANCH_SIZE = { w: 420, h: 460 };

/**
 * @param {string} id
 * @param {string | null} parentId
 * @param {"selection" | "followup" | null} branchType
 * @param {{ w: number, h: number }} size
 */
function makeNode(id, parentId, branchType, size = BRANCH_SIZE) {
  return { id, parent_id: parentId, size, origin: branchType ? { branch_type: branchType } : null };
}

/** @param {string} id @param {Array<Record<string, any>>} nodes @param {Map<string, { x: number, y: number }>} positions */
function at(nodes, positions, id) {
  const position = positions.get(id);
  assert.ok(position, `node ${id} must be placed`);
  return position;
}

/** @param {Array<Record<string, any>>} nodes */
function childrenIndex(nodes) {
  /** @type {Map<string | null, Array<Record<string, any>>>} */
  const byParent = new Map();
  for (const node of nodes) {
    const siblings = byParent.get(node.parent_id) || [];
    siblings.push(node);
    byParent.set(node.parent_id, siblings);
  }
  /** @param {string} id */
  const childrenOf = (id) => byParent.get(id) || [];
  return childrenOf;
}

/** @param {Array<Record<string, any>>} nodes @param {Map<string, { x: number, y: number }>} positions */
function rectsOf(nodes, positions) {
  return nodes.map((node) => {
    const position = at(nodes, positions, node.id);
    return { id: node.id, x: position.x, y: position.y, w: node.size.w, h: node.size.h };
  });
}

/** @param {Array<{ id: string, x: number, y: number, w: number, h: number }>} rects */
function assertNoOverlaps(rects, label) {
  for (let a = 0; a < rects.length; a++) {
    for (let b = a + 1; b < rects.length; b++) {
      const overlapX = Math.min(rects[a].x + rects[a].w, rects[b].x + rects[b].w) - Math.max(rects[a].x, rects[b].x);
      const overlapY = Math.min(rects[a].y + rects[a].h, rects[b].y + rects[b].h) - Math.max(rects[a].y, rects[b].y);
      assert.ok(
        !(overlapX > 0.5 && overlapY > 0.5),
        `${label}: ${rects[a].id} overlaps ${rects[b].id} by ${overlapX}x${overlapY}`,
      );
    }
  }
}

/** @param {Record<string, any>} root @param {Array<Record<string, any>>} nodes */
function layout(root, nodes) {
  const childrenOf = childrenIndex(nodes);
  return tidyPositions({ root, childrenOf, effH: (node) => node.size.h });
}

// Two or more follow-up branches fan out into one centered row below the parent.
// Chaining them on one axis is what hid the fork's edges.
{
  const root = makeNode("root", null, null, ROOT_SIZE);
  const nodes = [
    root,
    makeNode("a", "root", "followup"),
    makeNode("b", "root", "followup"),
    makeNode("c", "root", "followup"),
  ];
  const positions = layout(root, nodes);
  const [a, b, c] = ["a", "b", "c"].map((id) => at(nodes, positions, id));
  assert.equal(a.y, 650, "the fan row starts one parent gap below the parent");
  assert.equal(b.y, a.y, "fan siblings share the row's top edge");
  assert.equal(c.y, a.y, "fan siblings share the row's top edge");
  assert.equal(b.x - a.x, 450, "siblings are separated by one card width plus the stack gap");
  assert.equal(c.x - b.x, 450, "siblings are separated by one card width plus the stack gap");
  assert.equal((a.x + c.x + BRANCH_SIZE.w) / 2, ROOT_SIZE.w / 2, "the fan row is centered on the parent");
  assertNoOverlaps(rectsOf(nodes, positions), "three-way fan");
  console.log("ok tidy layout: a three-branch fan opens into one centered row");
}

// A single follow-up branch keeps the familiar vertical chain.
{
  const root = makeNode("root", null, null, ROOT_SIZE);
  const nodes = [root, makeNode("a", "root", "followup"), makeNode("b", "a", "followup")];
  const positions = layout(root, nodes);
  assert.deepEqual(at(nodes, positions, "a"), { x: 0, y: 650 }, "a single follow-up chains below the parent");
  assert.deepEqual(at(nodes, positions, "b"), { x: 0, y: 1180 }, "a chain below a chain stays on one axis");
  console.log("ok tidy layout: a single follow-up branch still chains below its parent");
}

// Selection branches keep the right-hand rail, stacked vertically.
{
  const root = makeNode("root", null, null, ROOT_SIZE);
  const nodes = [root, makeNode("s1", "root", "selection"), makeNode("s2", "root", "selection")];
  const positions = layout(root, nodes);
  assert.deepEqual(at(nodes, positions, "s1"), { x: 550, y: 0 }, "the selection rail starts beside the parent");
  assert.deepEqual(at(nodes, positions, "s2"), { x: 550, y: 490 }, "selection siblings stack down the same rail");
  console.log("ok tidy layout: selection branches keep the right-hand rail");
}

// A fan whose children each grow their own fan must not let the rows collide.
{
  const root = makeNode("root", null, null, ROOT_SIZE);
  const nodes = [
    root,
    makeNode("f1", "root", "followup"),
    makeNode("f2", "root", "followup"),
    makeNode("f1a", "f1", "followup"),
    makeNode("f1b", "f1", "followup"),
    makeNode("f2a", "f2", "followup"),
    makeNode("f2b", "f2", "followup"),
    makeNode("f1a1", "f1a", "followup"),
    makeNode("f2a1", "f2a", "followup"),
  ];
  const positions = layout(root, nodes);
  assertNoOverlaps(rectsOf(nodes, positions), "nested fans");
  const f1 = at(nodes, positions, "f1");
  const f2 = at(nodes, positions, "f2");
  const f1a = at(nodes, positions, "f1a");
  assert.ok(f1.x !== f2.x, "the outer fan's siblings must not share an axis");
  assert.ok(f1a.x !== at(nodes, positions, "f1b").x, "the inner fan's siblings must not share an axis");
  console.log("ok tidy layout: nested fans pack without collisions");
}

// A fan below a selection branch must stay clear of the parent's rail instead
// of running under it.
{
  const root = makeNode("root", null, null, ROOT_SIZE);
  const nodes = [
    root,
    makeNode("s", "root", "selection"),
    makeNode("s1", "s", "followup"),
    makeNode("s2", "s", "followup"),
    makeNode("f1", "s", "followup"),
    makeNode("f2", "s", "followup"),
  ];
  const positions = layout(root, nodes);
  assertNoOverlaps(rectsOf(nodes, positions), "fan below a selection branch");
  console.log("ok tidy layout: fans clear the rail they descend beside");
}

// Deterministic fuzz: many random tree shapes keep every pair of cards apart.
{
  let seed = 20261025;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let trial = 0; trial < 200; trial++) {
    const root = makeNode("root", null, null, ROOT_SIZE);
    const nodes = [root];
    const frontier = [root];
    const target = 2 + Math.floor(random() * 14);
    while (nodes.length < target && frontier.length) {
      const parent = frontier[Math.floor(random() * frontier.length)];
      const childCount = Math.floor(random() * 4);
      for (let child = 0; child < childCount && nodes.length < target; child++) {
        const id = `n${nodes.length}`;
        const node = makeNode(id, parent.id, random() < 0.5 ? "selection" : "followup", {
          w: 240 + Math.floor(random() * 560),
          h: 60 + Math.floor(random() * 700),
        });
        nodes.push(node);
        frontier.push(node);
      }
      frontier.splice(frontier.indexOf(parent), 1);
    }
    assertNoOverlaps(rectsOf(nodes, layout(root, nodes)), `fuzz tree ${trial}`);
  }
  console.log("ok tidy layout: 200 deterministic random trees keep every card separate");
}

console.log("ok tidy layout: fan-out, chaining, rails, and non-overlap invariants hold");
