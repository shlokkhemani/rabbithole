import { snapshotProjectionToFrozenHydration } from "../core/snapshot-projection.js";
import { createRabbitholeUi } from "./composition.js";
import { mountPdfView } from "./pdf-view.js";

function startRabbithole(hydration) {
  return createRabbitholeUi({
    hydration: hydration,
    capabilities: { exportSnapshot: null, exportPortable: null, mountPdfView: mountPdfView }
  });
}

export function startPortableSnapshot(projection) {
  return startRabbithole(snapshotProjectionToFrozenHydration(projection));
}
