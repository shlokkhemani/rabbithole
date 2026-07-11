/**
 * Reducer state and event vocabulary.
 *
 * Runtime authority: {@link ../reducer.js} (`createHoleState`,
 * `holeStateToHole`, and the `reduceHoleEvent` discriminator). The reducer
 * performs coercion, not trust-boundary validation: unknown event types throw,
 * while malformed known events retain each handler's current normalize/no-op/
 * throw behavior.
 */

import type { BaseUrlSource, NodeSize, PersistedViewState, Position } from "./artifact.js";

export interface HoleNode {
  id: string;
  parent_id?: string | null;
  title?: string;
  markdown?: string;
  base_url?: string | null;
  base_url_source?: BaseUrlSource | null;
  /** Application metadata is intentionally opaque to the reducer. */
  origin?: unknown;
  position?: Position;
  size?: NodeSize | null;
  font_scale?: number;
  collapsed?: boolean;
  status?: "pending" | "answered";
  read?: boolean;
  created_at?: string | null;
  /** Opaque JSON extension bag; reducer operations preserve it structurally. */
  extensions?: Record<string, unknown>;
  [field: string]: unknown;
}

export interface HoleState {
  hole_id: string;
  title: string;
  root_id: string | null;
  created_at: unknown;
  view_state: PersistedViewState | null | unknown;
  nodes: Map<string, HoleNode>;
  /**
   * Ephemeral per-node progress ordering records. This reducer-only ledger is
   * never persisted or emitted by `holeStateToHole` and starts empty after
   * every hydration.
   */
  progressRuns: Map<string, ProgressRun>;
}

export interface ProgressRun {
  id: string;
  seq: number;
  /** Ephemeral reducer guard; never serialized. */
  superseded?: Set<string>;
}

interface NodeTarget { node_id?: unknown; }
interface BaseUrlFields { base_url?: unknown; base_url_source?: unknown; }
export interface NodePresentationFields {
  position?: unknown;
  size?: unknown;
  collapsed?: unknown;
  font_scale?: unknown;
  read?: unknown;
}

export interface BranchRequestEvent extends NodePresentationFields {
  type: "branch_request";
  parent_id?: unknown;
  node_id?: unknown;
  selected_text?: unknown;
  question?: unknown;
  lens?: unknown;
  synthesis?: unknown;
  anchor?: unknown;
  branch_type?: unknown;
}
export interface NodeProgressEvent extends NodeTarget, BaseUrlFields {
  type: "node_progress";
  markdown?: unknown;
  /**
   * Optional ordering tag. For the same run id, sequence numbers at or below
   * the recorded value are discarded; a higher sequence or different id is
   * accepted. Untagged progress deliberately remains accepted for embedders and
   * replay; run tagging is a producer-side discipline.
   */
  run?: ProgressRun;
}
export interface NodeAnsweredEvent extends NodeTarget, BaseUrlFields, NodePresentationFields {
  type: "node_answered";
  parent_id?: unknown;
  title?: unknown;
  markdown?: unknown;
  origin?: unknown;
  created_at?: unknown;
}
export interface DeleteNodeEvent extends NodeTarget {
  type: "delete_node" | "node_deleted";
  node_ids?: unknown;
}
export interface NodeUpdateEvent extends NodeTarget, NodePresentationFields { type: "node_update"; }
export interface NodesUpdateEvent { type: "nodes_update"; nodes?: unknown; }
export interface ViewStateEvent { type: "view_state"; state?: unknown; }
/** Internal engine event; not part of the MCP/SSE wire vocabulary. */
export interface HoleTitleEvent { type: "hole_title"; title?: unknown; }
/** Internal engine event; not part of the MCP/SSE wire vocabulary. */
export interface NodeOriginEvent extends NodeTarget { type: "node_origin"; origin?: unknown; }
export interface BlockStateEvent extends NodeTarget {
  type: "block_state";
  block_id?: unknown;
  state?: unknown;
  /**
   * User interaction state is deliberately tolerant: an absent/invalid block
   * id or unknown node is ignored. It never participates in the generation
   * `{id,seq}` run guard, just as untagged progress remains permissive.
   */
}

export type DocEvent = BranchRequestEvent | NodeProgressEvent | NodeAnsweredEvent |
  DeleteNodeEvent | NodeUpdateEvent | NodesUpdateEvent | ViewStateEvent |
  HoleTitleEvent | NodeOriginEvent | BlockStateEvent;

export interface ReduceEffects {
  node_id?: string;
  createdNode?: HoleNode;
  answeredNode?: HoleNode;
  deletedNodeIds?: string[];
  deletedNodes?: HoleNode[];
}
export interface ReduceResult { state: HoleState; effects: ReduceEffects; }
export interface ReduceOptions { now?: string; idFactory?: () => string; }

export declare function createHoleState(input?: Partial<Omit<HoleState, "nodes" | "progressRuns">> & { nodes?: Map<string, HoleNode> | HoleNode[] }): HoleState;
export declare function holeStateToHole(state: HoleState): Omit<HoleState, "nodes" | "progressRuns"> & { nodes: HoleNode[] };
export declare function holeStateToHydrationNodes(state: HoleState, options?: { suppressRootOrigin?: boolean }): Array<Omit<Required<HoleNode>, "created_at">>;
export declare function reduceHoleEvent(state: HoleState, event: DocEvent, options?: ReduceOptions): ReduceResult;
