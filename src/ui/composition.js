import { disposeCore, initCore, nodes, registerCoreHooks } from "./core.js";
import { disposeVisuals, mountVisuals, registerVisualHooks } from "./visuals.js";
import { disposeImageUx, mountDocImages } from "./image-ux.js";
import { disposeReader, initReader, openNode, registerReaderHooks } from "./reader.js";
import {
  disposeCanvasView,
  diveToNode,
  effH,
  initCanvasView,
  registerCanvasHooks,
  setMode
} from "./canvas-view.js";
import {
  animateScroll,
  disposeAskFollowups,
  hideAsk,
  initAskFollowups,
  registerAskHooks,
  sendFollowup,
  updateComposerState
} from "./ask-followups.js";
import { disposePalette, initPalette, registerPaletteHooks } from "./palette.js";
import {
  closeShare,
  confirmDelete,
  disposeBranchSurfaces,
  hideConfirm,
  hidePeek,
  initBranchSurfaces,
  registerBranchHooks
} from "./branch-surfaces.js";
import { disposeChrome, initChrome } from "./chrome-init.js";
import { setRendererAssetData } from "./renderer.js";

var activeRuntime = null;

function noop() {}
function resolved() { return Promise.resolve({ ok: true }); }

export function createRabbitholeUi({ hydration, host, capabilities } = {}) {
  if (activeRuntime && !activeRuntime.disposed) {
    throw new Error("Dispose the active Rabbithole UI before starting another one");
  }

  host = host || {};
  capabilities = capabilities || {};
  var post = typeof host.post === "function" ? host.post : resolved;
  var cleanups = [];
  var disposed = false;

  function own(cleanup) {
    cleanups.push(cleanup);
  }

  try {
    registerVisualHooks({ post: post, getNode: function(id){ return nodes[id] || null; } });
    initCore(hydration);
    own(disposeCore);
    own(function(){ setRendererAssetData(null); });
    own(disposeVisuals);
    own(disposeImageUx);

    registerCoreHooks({
      post: post,
      openNode: openNode,
      mountVisuals: mountVisuals,
      mountDocImages: mountDocImages,
      ensureCanvasBuilt: noop,
      diveToNode: diveToNode,
      effH: effH
    });
    registerReaderHooks({
      hideAsk: hideAsk,
      hidePeek: hidePeek,
      updateComposerState: updateComposerState,
      scheduleViewSave: host.scheduleViewSave || noop,
      setMode: setMode,
      post: post,
      mountVisuals: mountVisuals,
      mountDocImages: mountDocImages,
      persistNode: host.persistNode || noop,
      animateScroll: animateScroll
    });
    registerCanvasHooks({
      hideAsk: hideAsk,
      hidePeek: hidePeek,
      sendFollowup: sendFollowup,
      confirmDelete: confirmDelete,
      persistNode: host.persistNode || noop,
      persistNodesBulk: host.persistNodesBulk || noop,
      scheduleViewSave: host.scheduleViewSave || noop
    });
    registerAskHooks({ post: post, hideConfirm: hideConfirm, hidePeek: hidePeek });
    registerPaletteHooks({
      hideAsk: hideAsk,
      hidePeek: hidePeek,
      closeShare: closeShare,
      hideConfirm: hideConfirm
    });
    registerBranchHooks({
      post: post,
      exportSnapshot: capabilities.exportSnapshot || null,
      exportPortable: capabilities.exportPortable || null
    });

    initReader(); own(disposeReader);
    initCanvasView(); own(disposeCanvasView);
    initAskFollowups(); own(disposeAskFollowups);
    initPalette(); own(disposePalette);
    initBranchSurfaces(); own(disposeBranchSurfaces);
    if (typeof host.start === "function") host.start();
    initChrome({
      connectSse: host.connect || null,
      post: post,
      refreshStatus: host.refreshStatus || noop
    });
    own(disposeChrome);
  } catch (error) {
    disposeOwned();
    throw error;
  }

  var runtime = {
    get disposed(){ return disposed; },
    flush: function(){
      return typeof host.flush === "function" ? Promise.resolve(host.flush()) : Promise.resolve();
    },
    dispose: async function(){
      if (disposed) return;
      disposed = true;
      if (activeRuntime === runtime) activeRuntime = null;
      var errors = [];
      if (typeof host.dispose === "function") {
        try { await host.dispose(); } catch (error) { errors.push(error); }
      }
      try { disposeOwned(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Rabbithole UI disposal failed");
    }
  };
  activeRuntime = runtime;
  return runtime;

  function disposeOwned() {
    var errors = [];
    while (cleanups.length) {
      try { cleanups.pop()(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Rabbithole UI cleanup failed");
  }
}
