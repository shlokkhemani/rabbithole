/** @typedef {import("../../../src/core/contracts/artifact.js").PersistedHole} PersistedHole */
/** @typedef {import("../../../src/core/contracts/artifact.js").LegacyPersistedHole} LegacyPersistedHole */
/** @typedef {import("../../../src/core/contracts/artifact.js").PortableArtifact} PortableArtifact */

/** @type {PersistedHole} */
export const persistedHoleFixture = {
  schema_version: 1,
  hole_id: "typed-artifact",
  title: "Typed artifact",
  root_id: "root",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
  view_state: { mode: "canvas", node_id: "root", scroll: 12, view: { x: 3, y: -4, scale: 1.25 } },
  nodes: [{
    id: "root", parent_id: null, title: "Root", markdown: "Body",
    base_url: null, base_url_source: null, origin: { type: "fixture" },
    position: { x: 0, y: 0 }, size: { w: 420, h: 240 }, font_scale: 1,
    collapsed: false, status: "answered", read: true,
    created_at: "2026-01-01T00:00:00.000Z",
  }],
};

/** @type {LegacyPersistedHole} */
export const nullSchemaLegacyFixture = {
  schema_version: null,
  hole_id: "typed-legacy",
  title: "Legacy",
  root_id: "root",
  created_at: null,
  updated_at: null,
  nodes: [{ id: "root" }],
};

/** @type {PortableArtifact} */
export const portableArtifactFixture = {
  format: "rabbithole",
  format_version: 1,
  hole: persistedHoleFixture,
  assets: { "pixel.png": "iVBORw==" },
};

