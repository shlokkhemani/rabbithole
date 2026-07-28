/**
 * Host-independent Nora document contracts.
 *
 * Runtime authority: ../document-schema.js and ../document-state.js.
 */

import type { BaseUrlSource, NodeSize, PersistedViewState, Position } from "./artifact.js";
import type { AgentRunSummary } from "./agent-run.js";
import type { EvidenceRecord, SourceRecord } from "./evidence.js";

export type NoraDocumentSchemaVersion = 1;
export type NoraNodeState = "pending" | "running" | "complete" | "cancelled" | "failed" | "interrupted";

export interface NoraNode {
  id: string;
  parentId: string | null;
  title: string;
  markdown: string;
  baseUrl: string | null;
  baseUrlSource: BaseUrlSource | null;
  origin: unknown | null;
  position: Position;
  size: NodeSize | null;
  fontScale: number;
  collapsed: boolean;
  state: NoraNodeState;
  read: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  sourceIds: string[];
  evidenceIds: string[];
  attachmentIds: string[];
  runId: string | null;
  extensions: Record<string, unknown>;
}

export interface NoraEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: string;
  createdAt: string | null;
  extensions: Record<string, unknown>;
}

export interface NoraAttachment {
  id: string;
  sha256: string;
  mediaType: string;
  title: string;
  filename: string | null;
  bytes: number;
  sourceId: string | null;
  evidenceIds: string[];
  createdAt: string | null;
  extensions: Record<string, unknown>;
}

export interface NoraCheckRecord {
  id: string;
  nodeId: string;
  blockId: string;
  state: unknown;
  createdAt: string | null;
  updatedAt: string | null;
  extensions: Record<string, unknown>;
}

export interface NoraDocument {
  schemaVersion: NoraDocumentSchemaVersion;
  documentId: string;
  title: string;
  rootNodeId: string;
  createdAt: string | null;
  updatedAt: string | null;
  viewState: PersistedViewState | null;
  selection: unknown | null;
  selectedProfileId: string | null;
  nodes: NoraNode[];
  edges: NoraEdge[];
  sources: SourceRecord[];
  evidence: EvidenceRecord[];
  attachments: NoraAttachment[];
  runs: AgentRunSummary[];
  checks: NoraCheckRecord[];
  extensions: Record<string, unknown>;
}

export interface NoraDocumentState extends Omit<NoraDocument, "nodes" | "edges" | "sources" | "evidence" | "attachments" | "runs" | "checks"> {
  nodes: Map<string, NoraNode>;
  edges: Map<string, NoraEdge>;
  sources: Map<string, SourceRecord>;
  evidence: Map<string, EvidenceRecord>;
  attachments: Map<string, NoraAttachment>;
  runs: Map<string, AgentRunSummary>;
  checks: Map<string, NoraCheckRecord>;
  revision: number;
  progressRuns: Map<string, { id: string; seq: number; superseded?: Set<string> }>;
}

export type NoraDocumentEvent =
  | { type: "document_title"; title?: unknown }
  | { type: "selected_profile"; profileId?: unknown; profile_id?: unknown }
  | { type: "node_state"; nodeId?: unknown; node_id?: unknown; state?: unknown; updatedAt?: unknown; updated_at?: unknown }
  | { type: "node_run"; nodeId?: unknown; node_id?: unknown; runId?: unknown; run_id?: unknown; updatedAt?: unknown; updated_at?: unknown }
  | { type: "source_record"; source: SourceRecord }
  | { type: "evidence_record"; evidence: EvidenceRecord }
  | { type: "attachment_record"; attachment: NoraAttachment }
  | { type: "run_summary"; run: AgentRunSummary }
  | { type: "check_record"; check: NoraCheckRecord }
  | {
      type: "node_references";
      nodeId?: unknown;
      node_id?: unknown;
      sourceIds?: unknown;
      source_ids?: unknown;
      evidenceIds?: unknown;
      evidence_ids?: unknown;
      attachmentIds?: unknown;
      attachment_ids?: unknown;
      updatedAt?: unknown;
      updated_at?: unknown;
    };

export declare function createDocumentState(input?: Partial<NoraDocument> & { revision?: number }): NoraDocumentState;
export declare function documentStateToPersisted(state: NoraDocumentState): NoraDocument;
export declare function documentStateToHydrationNodes(state: NoraDocumentState): Array<Record<string, unknown>>;
export declare function reduceDocumentEvent(state: NoraDocumentState, event: NoraDocumentEvent, options?: { now?: string; idFactory?: () => string; mutate?: boolean }): { state: NoraDocumentState; effects: Record<string, unknown> };
