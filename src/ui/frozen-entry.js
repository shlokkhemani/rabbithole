import { initCore, registerCoreHooks } from "./core.js";
import { mountVisuals, registerVisualHooks } from "./visuals.js";
import { nodes } from "./core.js";
import { mountDocImages } from "./image-ux.js";
import {
  initReader,
  openNode,
  registerReaderHooks
} from "./reader.js";
import {
  diveToNode,
  effH,
  initCanvasView,
  registerCanvasHooks,
  setMode
} from "./canvas-view.js";
import {
  animateScroll,
  hideAsk,
  initAskFollowups,
  registerAskHooks,
  sendFollowup,
  updateComposerState
} from "./ask-followups.js";
import { initPalette, registerPaletteHooks } from "./palette.js";
import {
  closeShare,
  confirmDelete,
  hideConfirm,
  hidePeek,
  initBranchSurfaces,
  registerBranchHooks
} from "./branch-surfaces.js";
import { initChrome } from "./chrome-init.js";
import { snapshotProjectionToFrozenHydration } from "../core/snapshot-projection.js";

function post() {
  return Promise.resolve({ ok: true });
}

function refreshStatus() {}

export function startRabbithole(hydration) {
  initCore(hydration);
  registerVisualHooks({ post: post, getNode: function(id){ return nodes[id] || null; } });
  registerCoreHooks({
    post: post,
    openNode: openNode,
    mountVisuals: mountVisuals,
    mountDocImages: mountDocImages,
    ensureCanvasBuilt: function(){},
    diveToNode: diveToNode,
    effH: effH
  });
  registerReaderHooks({
    hideAsk: hideAsk,
    hidePeek: hidePeek,
    updateComposerState: updateComposerState,
    scheduleViewSave: function(){},
    setMode: setMode,
    post: post,
    mountVisuals: mountVisuals,
    mountDocImages: mountDocImages,
    persistNode: function(){},
    animateScroll: animateScroll
  });
  registerCanvasHooks({
    hideAsk: hideAsk,
    hidePeek: hidePeek,
    sendFollowup: sendFollowup,
    confirmDelete: confirmDelete,
    persistNode: function(){},
    persistNodesBulk: function(){},
    scheduleViewSave: function(){}
  });
  registerAskHooks({
    post: post,
    hideConfirm: hideConfirm,
    hidePeek: hidePeek
  });
  registerPaletteHooks({
    hideAsk: hideAsk,
    hidePeek: hidePeek,
    closeShare: closeShare,
    hideConfirm: hideConfirm
  });
  registerBranchHooks({ post: post });

  initReader();
  initCanvasView();
  initAskFollowups();
  initPalette();
  initBranchSurfaces();
  initChrome({ post: post, refreshStatus: refreshStatus });
}

export function startPortableSnapshot(projection) {
  startRabbithole(snapshotProjectionToFrozenHydration(projection));
}
