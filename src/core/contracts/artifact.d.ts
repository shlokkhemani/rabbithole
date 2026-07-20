/**
 * Persisted and portable Rabbithole artifacts.
 *
 * Runtime authority for persisted documents:
 * {@link ../schema.js} (`toPersistedHole`, `toPersistedNode`,
 * `validatePersistedHole`, and `parsePersistedHole`). Runtime validation is
 * still required for every value crossing a trust boundary.
 *
 * Runtime authority for the portable envelope:
 * {@link ../portable-projection.js} (`createPortableProjection` and
 * `validatePortableProjection`).
 */

export type SchemaVersion = 2;
export type BaseUrlSource = "explicit" | "frontmatter" | "inherited";
export type NodeStatus = "pending" | "answered";

export interface Position {
  x: number;
  y: number;
}

export interface NodeSize {
  w: number;
  h: number;
}

export interface CanvasView {
  x: number;
  y: number;
  scale: number;
}

export interface PersistedViewState {
  mode: "canvas" | "reader";
  node_id: string | null;
  scroll: number;
  view?: CanvasView;
}

/** Canonical node projection returned by `toPersistedNode`. */
export interface PersistedNode {
  id: string;
  parent_id: string | null;
  title: string;
  markdown: string;
  base_url: string | null;
  base_url_source: BaseUrlSource | null;
  /** Preserved application metadata; schema.js does not currently validate it. */
  origin: unknown;
  position: Position;
  size: NodeSize | null;
  font_scale: number;
  collapsed: boolean;
  status: NodeStatus;
  read: boolean;
  created_at: string | null;
  /** Opaque learner/application state, preserved with structural JSON fidelity. */
  extensions: Record<string, unknown>;
}

/** Canonical schema-v2 document accepted by `validatePersistedHole`. */
export interface PersistedHole {
  schema_version: SchemaVersion;
  hole_id: string;
  title: string;
  root_id: string;
  created_at: string | null;
  updated_at: string | null;
  view_state: PersistedViewState | null;
  nodes: PersistedNode[];
}

/** Portable `.rabbithole` JSON emitted by `buildRabbitholeExport`. */
export interface PortableArtifact {
  format: "rabbithole";
  format_version: 1;
  hole: PersistedHole;
  /** Validated asset name to base64-encoded bytes. */
  assets: Record<string, string>;
}
