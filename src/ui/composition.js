import {
  animateScroll,
  disposeAskFollowups,
  hideAsk,
  initAskFollowups,
  rollbackBranch,
  sendFollowup,
  showAskFromSelection,
  updateComposerState,
} from "./ask-followups.js";
import {
  closeShare,
  commitPendingBranchRemoval,
  copyNodeMarkdown,
  disposeBranchSurfaces,
  initBranchSurfaces,
  removeBranch,
} from "./branch-surfaces.js";
import {
  closeCardMenu,
  disposeCanvasView,
  diveToNode,
  ensureCanvasBuilt,
  initCanvasView,
  raiseCard,
  scheduleEdges,
  setMode,
} from "./canvas/index.js";
import { disposeChrome, initChrome } from "./chrome-init.js";
import { closed, disposeCore, frozen, initCore, nodes } from "./core.js";
import {
  closeDockedNotePopover,
  createPlacedNote,
  disposeDockedNotes,
  initDockedNotes,
  positionDockedNotes,
  renderDockedNotes,
  revealDockedNote,
} from "./docked-notes.js";
import { disposeImageUx, mountDocImages } from "./image-ux.js";
import { createCleanupScope } from "./kit/scope.js";
import { disposePalette, initPalette } from "./palette.js";
import { disposeReader, initReader, openNode } from "./reader.js";
import { ensureNodeHtml, setRendererAssetData } from "./renderer.js";
import { closeSettingsSheet, initSettingsSheet, registerSettingsSection } from "./settings-sheet.js";
import { disposeVisuals, initVisuals } from "./visuals.js";

let activeRuntime = null;

function noop() {}
function resolved() {
  return Promise.resolve({ ok: true });
}

/** @param {{hydration?: any, host?: any, capabilities?: any}} [options] */
export function createRabbitholeUi({ hydration, host, capabilities } = {}) {
  if (activeRuntime && !activeRuntime.disposed) {
    throw new Error("Dispose the active Rabbithole UI before starting another one");
  }

  host = host || {};
  capabilities = capabilities || {};
  const post = typeof host.post === "function" ? host.post : resolved;
  const putAsset = typeof host.putAsset === "function" ? host.putAsset : resolved;
  const deleteAsset = typeof host.deleteAsset === "function" ? host.deleteAsset : resolved;
  const scope = createCleanupScope();
  let disposed = false;

  function own(cleanup) {
    scope.addCleanup(cleanup);
  }

  try {
    const visualRuntimeHooks = {
      post: post,
      getNode: function (id) {
        return nodes[id] || null;
      },
      getBlockBranches: function (nodeId, blockId) {
        return Object.values(nodes).filter(function (node) {
          return node.parent_id === nodeId && node.origin?.anchor?.block?.block_id === blockId;
        });
      },
      openBranch: function (id) {
        openNode(id);
      },
      askSelection: showAskFromSelection,
      canAsk: function () {
        return !frozen && !closed;
      },
    };
    if (typeof capabilities.loadMermaid === "function") visualRuntimeHooks.loadMermaid = capabilities.loadMermaid;
    initVisuals(visualRuntimeHooks);
    own(disposeCore);
    own(function () {
      setRendererAssetData(null);
    });
    own(disposeVisuals);
    own(disposeImageUx);
    const mountImages = function (dc, surfaceKey) {
      mountDocImages(dc, surfaceKey, {
        hideAsk: hideAsk,
        scheduleEdges: scheduleEdges,
        provenanceFor: function (nodeId, assetName) {
          const generatedImages = nodes[nodeId]?.extensions?.generated_images;
          const provenance = generatedImages && generatedImages[assetName];
          return provenance && typeof provenance === "object" ? provenance : null;
        },
      });
    };

    initCore(hydration, {
      post: post,
      putAsset: putAsset,
      deleteAsset: deleteAsset,
      openNode: openNode,
      ensureNodeHtml: ensureNodeHtml,
      persistNode: host.persistNode || noop,
      revealDockedNote: revealDockedNote,
      mountDocImages: mountImages,
      mountPdfView: capabilities.mountPdfView || null,
      ensureCanvasBuilt: ensureCanvasBuilt,
      diveToNode: diveToNode,
      scheduleEdges: scheduleEdges,
      modeChanged: capabilities.modeChanged || noop,
    });
    const readerHooks = {
      hideAsk: hideAsk,
      updateComposerState: updateComposerState,
      scheduleViewSave: host.scheduleViewSave || noop,
      setMode: setMode,
      raiseCard: raiseCard,
      mountDocImages: mountImages,
      animateScroll: animateScroll,
      renderDockedNotes: renderDockedNotes,
    };
    const canvasHooks = {
      hideAsk: hideAsk,
      sendFollowup: sendFollowup,
      sendPlacedNote: createPlacedNote,
      renderDockedNotes: renderDockedNotes,
      positionDockedNotes: positionDockedNotes,
      closeDockedNotePopover: closeDockedNotePopover,
      rollbackBranch: rollbackBranch,
      copyNodeMarkdown: copyNodeMarkdown,
      removeBranch: removeBranch,
      persistNode: host.persistNode || noop,
      persistNodesBulk: host.persistNodesBulk || noop,
      scheduleViewSave: host.scheduleViewSave || noop,
      createCanvasMaintenance: capabilities.canvasMaintenanceFactory || null,
    };
    const paletteHooks = {
      hideAsk: hideAsk,
      closeShare: closeShare,
      closeCardMenu: closeCardMenu,
    };
    const branchHooks = {
      exportSnapshot: capabilities.exportSnapshot || null,
      exportPortable: capabilities.exportPortable || null,
    };

    /* The gear lives in the shared taskbar, which outlives any one hole: the
       sheet binds once per host and every hole simply re-confirms it. Sections
       are data — a host that registers none still gets Appearance. */
    (capabilities.settingsSections || []).forEach(function (section) {
      registerSettingsSection(section);
    });
    initSettingsSheet({ hostLabel: capabilities.settingsHostLabel });
    own(function () {
      closeSettingsSheet({ restoreFocus: false });
    });

    initReader(readerHooks);
    own(disposeReader);
    initCanvasView(canvasHooks);
    own(disposeCanvasView);
    // After the reader and the canvas, so a docked note's own click handling
    // sees the event once its surfaces have declined it.
    initDockedNotes();
    own(disposeDockedNotes);
    initAskFollowups();
    own(disposeAskFollowups);
    initPalette(paletteHooks);
    own(disposePalette);
    initBranchSurfaces(branchHooks);
    own(disposeBranchSurfaces);
    if (typeof host.start === "function") host.start();
    initChrome({
      connectSse: host.connect || null,
      post: post,
      refreshStatus: host.refreshStatus || noop,
    });
    own(disposeChrome);
  } catch (error) {
    disposeOwned();
    throw error;
  }

  const runtime = {
    get disposed() {
      return disposed;
    },
    flush: function () {
      return typeof host.flush === "function" ? Promise.resolve(host.flush()) : Promise.resolve();
    },
    dispose: async function () {
      if (disposed) return;
      disposed = true;
      if (activeRuntime === runtime) activeRuntime = null;
      const errors = [];
      try {
        await commitPendingBranchRemoval();
      } catch (error) {
        errors.push(error);
      }
      if (typeof host.dispose === "function") {
        try {
          await host.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        disposeOwned();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Rabbithole UI disposal failed");
    },
  };
  activeRuntime = runtime;
  return runtime;

  function disposeOwned() {
    scope.dispose();
  }
}
