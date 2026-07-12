import { getAssetContentType } from "./assets.js";
import { createPortableProjection } from "./portable-projection.js";

/** @typedef {import("./contracts/artifact.js").PersistedHole} PersistedHole */
/** @typedef {import("./contracts/artifact.js").PortableArtifact} PortableArtifact */

/**
 * @param {PersistedHole} hole
 * @param {PersistedHole["view_state"]} viewState
 * @param {Record<string, string>} assets
 * @returns {PortableArtifact}
 */
export function createSnapshotProjection(hole, viewState, assets) {
  const projection = createPortableProjection({ ...hole, view_state: viewState }, assets);
  // Shares exclude personal extension state while remaining valid canonical artifacts.
  projection.hole = {
    ...projection.hole,
    nodes: projection.hole.nodes.map((node) => ({ ...node, extensions: {} })),
  };
  return projection;
}

/** @param {PortableArtifact} projection */
export function snapshotProjectionToFrozenHydration(projection) {
  const hole = projection.hole;
  /** @type {Record<string, string>} */
  const assetData = {};
  for (const [name, encoded] of Object.entries(projection.assets)) {
    assetData[name] = `data:${getAssetContentType(name)};base64,${encoded}`;
  }
  return {
    session_id: `snapshot-${hole.hole_id}`,
    hole_id: hole.hole_id,
    title: hole.title,
    root_id: hole.root_id,
    last_event_id: 0,
    agent_attached: false,
    view_state: hole.view_state,
    frozen: true,
    asset_data: assetData,
    nodes: hole.nodes,
  };
}
