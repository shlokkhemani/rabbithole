import { snapshotProjectionToFrozenHydration } from "../core/snapshot-projection.js";
import { createNoraUi } from "./composition.js";
import { mountPdfView } from "./pdf-view.js";

function startNora(hydration) {
  return createNoraUi({
    hydration: hydration,
    capabilities: { exportSnapshot: null, exportPortable: null, mountPdfView: mountPdfView }
  });
}

export function startPortableSnapshot(projection) {
  return startNora(snapshotProjectionToFrozenHydration(projection));
}
