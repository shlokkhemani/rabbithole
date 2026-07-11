import { nodes, readerMain } from "./core.js";
import { removeMarks, removeThreadItem } from "./reader.js";

/** @param {string} id */
export function teardownNode(id) {
  var node = nodes[id];
  if (!node) return;
  if (node.el && node.el.parentNode) node.el.parentNode.removeChild(node.el);
  removeMarks(readerMain, id);
  removeThreadItem(id);
  var parent = nodes[node.parent_id];
  if (parent && parent.bodyEl) removeMarks(parent.bodyEl, id);
  delete nodes[id];
}
