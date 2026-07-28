/**
 * Source and evidence contracts for Nora documents.
 *
 * Runtime authority: ../document-schema.js validates every persisted record.
 */

export interface SourceRecord {
  id: string;
  type: string;
  stableLocator: unknown;
  title: string;
  revision?: string;
  commit?: string;
  capturedAt: string | null;
  extensions: Record<string, unknown>;
}

export interface EvidenceRecord {
  id: string;
  sourceId: string | null;
  sourceType: string;
  stableLocator: unknown;
  title: string;
  excerpt: string;
  revision?: string;
  commit?: string;
  permalink?: string;
  capturedAt: string;
  range: unknown | null;
  extensions: Record<string, unknown>;
}
