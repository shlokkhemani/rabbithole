import { systemClock } from "../../core/clock.js";
import { nodeNeedsReading } from "../../core/hole/node.js";
import { currentNodeId, nodes, postBrowserEvent, rootId, world } from "../core.js";

function cardIdFromTarget(target) {
  const element = target && target.nodeType === 1 ? target : target?.parentElement;
  const card = element && typeof element.closest === "function" ? element.closest(".card") : null;
  return card ? card.dataset.nodeId || card.dataset.id || null : null;
}

export function createCanvasAttention() {
  let hoveredCardId = null;
  let disposed = false;
  const engageListeners = new Set();
  const seenWriteCycles = new Map();

  function markSeen(id) {
    const node = nodes[id];
    if (!nodeNeedsReading(node)) return;
    const previous = seenWriteCycles.get(id);
    if (previous && (previous.pending || previous.extensions === node.extensions)) return;
    const cycle = { extensions: node.extensions, pending: true };
    seenWriteCycles.set(id, cycle);
    postBrowserEvent({
      type: "node_extensions_patch",
      node_id: id,
      namespace: "attention",
      value: { seen_at: systemClock.now() },
    }).then(function (result) {
      cycle.pending = false;
      if ((!result || !result.ok) && seenWriteCycles.get(id) === cycle) seenWriteCycles.delete(id);
    });
  }

  function engageCard(id) {
    if (disposed || !id || !nodes[id]) return;
    markSeen(id);
    engageListeners.forEach(function (listener) {
      listener(id);
    });
  }

  function onAttention(event) {
    engageCard(cardIdFromTarget(event.target));
  }

  function onSelectionChange() {
    engageCard(cardIdFromTarget(document.getSelection()?.anchorNode));
  }

  function onMouseOver(event) {
    const id = cardIdFromTarget(event.target);
    if (id) hoveredCardId = id;
  }

  function onMouseOut(event) {
    const from = cardIdFromTarget(event.target);
    const to = cardIdFromTarget(event.relatedTarget);
    if (from && from !== to && hoveredCardId === from) hoveredCardId = to;
  }

  world.addEventListener("pointerdown", onAttention, true);
  world.addEventListener("focusin", onAttention, true);
  world.addEventListener("mouseover", onMouseOver);
  world.addEventListener("mouseout", onMouseOut);
  document.addEventListener("selectionchange", onSelectionChange);

  return {
    onEngage: function (listener) {
      if (disposed) return function () {};
      engageListeners.add(listener);
      return function () {
        engageListeners.delete(listener);
      };
    },
    getHoveredCardId: function () {
      return hoveredCardId;
    },
    engageCard: engageCard,
    cardScrolled: function (card) {
      engageCard(cardIdFromTarget(card));
    },
    modeChanged: function (nextMode) {
      if (nextMode === "reader") engageCard(currentNodeId || rootId);
    },
    dispose: function () {
      if (disposed) return;
      disposed = true;
      world.removeEventListener("pointerdown", onAttention, true);
      world.removeEventListener("focusin", onAttention, true);
      world.removeEventListener("mouseover", onMouseOver);
      world.removeEventListener("mouseout", onMouseOut);
      document.removeEventListener("selectionchange", onSelectionChange);
      engageListeners.clear();
      seenWriteCycles.clear();
      hoveredCardId = null;
    },
  };
}
