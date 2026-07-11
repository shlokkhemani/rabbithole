import { snapshotProjectionToFrozenHydration } from "../core/snapshot-projection.js";
import { createRabbitholeUi } from "./composition.js";

export function startRabbithole(hydration) {
  return createRabbitholeUi({
    hydration: hydration,
    capabilities: { exportSnapshot: null, exportPortable: null }
  });
}

export function startPortableSnapshot(projection) {
  return startRabbithole(snapshotProjectionToFrozenHydration(projection));
}
