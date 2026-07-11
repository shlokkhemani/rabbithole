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
import {
  connectSse,
  initTransportStatus,
  persistNode,
  persistNodesBulk,
  post,
  refreshStatus,
  scheduleViewSave,
  setTransportAdapter
} from "./transport-status.js";
import { initChrome } from "./chrome-init.js";
import { setSnapshotHooks } from "./snapshot.js";

export function startRabbithole(hydration, options) {
  setSnapshotHooks(options && options.snapshotHooks);
  setTransportAdapter(options && options.transport);
  registerVisualHooks({ post: post, getNode: function(id){ return nodes[id] || null; } });
  initCore(hydration);
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
    scheduleViewSave: scheduleViewSave,
    setMode: setMode,
    post: post,
    mountVisuals: mountVisuals,
    mountDocImages: mountDocImages,
    persistNode: persistNode,
    animateScroll: animateScroll
  });
  registerCanvasHooks({
    hideAsk: hideAsk,
    hidePeek: hidePeek,
    sendFollowup: sendFollowup,
    confirmDelete: confirmDelete,
    persistNode: persistNode,
    persistNodesBulk: persistNodesBulk,
    scheduleViewSave: scheduleViewSave
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
  registerBranchHooks({
    post: post,
    exportPortable: options && options.exportPortable
  });

  initReader();
  initCanvasView();
  initAskFollowups();
  initPalette();
  initBranchSurfaces();
  initTransportStatus();
  initChrome({ connectSse: connectSse, post: post, refreshStatus: refreshStatus });
}
