import { systemClock } from "../core/clock.js";
import { isNoteNode } from "../core/hole/ask.js";
import { makeNode } from "../core/hole/node.js";
import { DEFAULT_CHILD, DEFAULT_ROOT, DEFAULT_STANDALONE_NOTE } from "../core/layout.js";
import { prebuildCanvas, setMode } from "./canvas/index.js";
import { frozen, hydration, nextOrder, nodes, registerNode, rootId } from "./core.js";
import { setRendererAssetData } from "./renderer.js";
import {
  applyJournaledEdits,
  restoreCanvasSurface,
  restoreReaderSurface,
  seedViewState,
  takeUnloadJournal,
} from "./view-state.js";

export function hydrateInitialState({ connectSse = null, refreshStatus = null, post = null } = {}) {
  setRendererAssetData(hydration.asset_data || null);
  if (frozen) document.body.classList.add("frozen");
  // A refresh taken moments after an edit or a move: what the page could not
  // save as it went comes back from its unload journal.
  const journal = frozen ? null : takeUnloadJournal();
  if (journal) applyJournaledEdits(hydration.nodes, journal.edits);
  (hydration.nodes || []).forEach(function (raw) {
    const isRoot = raw.id === rootId;
    const size =
      raw.size ||
      (isRoot ? DEFAULT_ROOT : isNoteNode(raw) && raw.parent_id == null ? DEFAULT_STANDALONE_NOTE : DEFAULT_CHILD);
    const model = makeNode(Object.assign({}, raw, { size: size }));
    const node = {
      ...model,
      html: "",
      _order: 0,
      delegated: !!raw.delegated,
      queued: !!raw.queued,
      _startTs: raw.status === "pending" ? systemClock.now() : 0,
    };
    registerNode(node);
  });
  Object.keys(nodes).forEach(function (id) {
    nodes[id]._order = nextOrder();
  });
  // Land exactly where the human left off: the same surface, the same
  // current document, every place in every document, the same camera. A
  // first open starts at the root on the canvas, framed, like always.
  const vs = (journal && journal.view) || hydration.view_state || null;
  seedViewState(vs, { viewAdjusted: journal && journal.view ? journal.viewAdjusted : true });
  // A shared snapshot always opens on its map; a live hole reopens wherever
  // its reader was — at once, with the canvas behind it built while the
  // browser is idle, instead of every card first.
  if (!frozen && restoreReaderSurface(vs)) prebuildCanvas();
  else {
    setMode("canvas");
    restoreCanvasSurface(vs, { allowReader: !frozen });
  }
  if (typeof refreshStatus === "function") refreshStatus();
  if (!frozen && typeof connectSse === "function") connectSse();
  if (journal && typeof post === "function") journal.edits.forEach(post);
}
