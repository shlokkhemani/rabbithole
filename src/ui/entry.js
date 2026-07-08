import { initCore, registerCoreHooks } from "./core.js";
import { initVisuals, mountVisuals } from "./visuals.js";
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
  initTransportStatus,
  persistNode,
  persistNodesBulk,
  post,
  refreshStatus,
  scheduleViewSave
} from "./transport-status.js";
import { initChrome } from "./chrome-init.js";

export function startRabbithole(hydration) {
  initCore(hydration);
  initVisuals();

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
    closeShare: closeShare,
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
  initTransportStatus();
  initChrome();
}
