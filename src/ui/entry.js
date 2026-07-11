import { createRabbitholeUi } from "./composition.js";
import {
  connectSse,
  disposeTransportStatus,
  flushPendingSaves,
  initTransportStatus,
  persistNode,
  persistNodesBulk,
  post,
  refreshStatus,
  scheduleViewSave,
  setTransportAdapter
} from "./transport-status.js";
import { downloadSnapshot, resetSnapshotHooks, setSnapshotHooks } from "./snapshot.js";

export function startRabbithole(hydration, options) {
  options = options || {};
  if (options.snapshotHooks) setSnapshotHooks(options.snapshotHooks);
  setTransportAdapter(options.transport);
  var runtime = createRabbitholeUi({
    hydration: hydration,
    host: {
      post: post,
      connect: connectSse,
      refreshStatus: refreshStatus,
      persistNode: persistNode,
      persistNodesBulk: persistNodesBulk,
      scheduleViewSave: scheduleViewSave,
      start: initTransportStatus,
      flush: flushPendingSaves,
      dispose: disposeTransportStatus
    },
    capabilities: {
      exportSnapshot: downloadSnapshot,
      exportPortable: options.exportPortable || null
    }
  });
  var dispose = runtime.dispose;
  runtime.dispose = async function(){
    try { await dispose(); }
    finally { resetSnapshotHooks(); }
  };
  return runtime;
}
