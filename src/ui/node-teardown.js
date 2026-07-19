import { disposeNodeContent, nodes, readerMain, unregisterNode } from "./core.js";
import { removeMarks } from "./text-marks.js";

/** @param {string} id */
export function teardownNode(id) {
  var node = nodes[id];
  if (!node) return;
  disposeNodeContent(node);
  if (node.el && node.el.parentNode) node.el.parentNode.removeChild(node.el);
  removeMarks(readerMain, id);
  var parent = nodes[node.parent_id];
  if (parent && parent.bodyEl) removeMarks(parent.bodyEl, id);
  unregisterNode(id);
}
