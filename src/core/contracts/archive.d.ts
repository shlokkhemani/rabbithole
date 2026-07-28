/**
 * Runtime authority: ../../extension/archive/*.js.
 */

import type { NoraDocument } from "./document.js";

export interface NoraArchiveEntry {
  path: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}

export interface NoraArchiveManifest {
  format: "nora";
  formatVersion: 1;
  documentId: string;
  createdAt: string | null;
  updatedAt: string | null;
  entries: NoraArchiveEntry[];
}

export interface NoraArchiveAssetSource {
  sha256: string;
  bytes: number;
  mediaType?: string;
  filePath?: string;
  archivePath?: string;
  path?: string;
  bytesBuffer?: Uint8Array;
}

export interface NoraArchiveRunSource {
  runId: string;
  filePath?: string;
  records?: Array<Record<string, unknown>>;
}

export interface NoraArchiveReadResult {
  archivePath: string;
  manifest: NoraArchiveManifest;
  document: NoraDocument;
  runs: Map<string, Array<Record<string, unknown>>>;
  assets: Map<string, NoraArchiveAssetSource>;
}

export interface NoraArchiveWriteSnapshot {
  document: NoraDocument;
  previousDocument?: NoraDocument | null;
  previousArchive?: NoraArchiveReadResult | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  logicalRevisionChanged?: boolean;
  assets?: NoraArchiveAssetSource[];
  runs?: NoraArchiveRunSource[];
  runByteCutoffs?: Record<string, number>;
}
