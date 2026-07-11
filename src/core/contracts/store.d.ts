import type { PersistedHole } from "./artifact.js";

/**
 * Storage port implemented by `FsStore` and `IdbStore`.
 *
 * Runtime authority: {@link ../store.js} (`RABBITHOLE_STORE_METHODS` and
 * `assertRabbitholeStore`). The assertion checks capabilities by method
 * presence; argument and result validation remains each implementation's job.
 */

export interface HoleSummary {
  hole_id: string;
  title: string;
  updated_at: string | null;
  node_count: number;
}

export type AssetBytes = Blob | ArrayBuffer | Uint8Array;

/** Structural Node.js `Buffer` view without requiring Node ambient types. */
export interface Buffer extends Uint8Array {}

export interface SaveHoleOptions {
  updatedAt?: string;
}

/** In-memory document accepted for canonicalization by both store backends. */
export type HoleForPersistence = Omit<PersistedHole, "schema_version" | "updated_at"> & {
  schema_version?: 2;
  updated_at?: string | null;
};

export interface StagingHandle {
  ingest_id: string;
}

export interface RabbitholeStore {
  listHoles(): Promise<HoleSummary[]>;
  loadHole(holeId: string): Promise<PersistedHole | null>;
  saveHole(hole: HoleForPersistence, options?: SaveHoleOptions): Promise<void>;
  deleteHole(holeId: string): Promise<void>;
  listAssets(holeId: string): Promise<string[]>;
  /**
   * Implementations expose their native binary type: `FsStore` returns a Node
   * `Buffer`, while `IdbStore` returns a browser `Blob`. Portable projection
   * normalizes either representation at its boundary.
   */
  getAsset(holeId: string, name: string): Promise<Buffer | Blob | null>;
  putAsset(holeId: string, name: string, bytes: AssetBytes): Promise<void>;
  deleteAsset(holeId: string, name: string): Promise<void>;
  createStaging(): Promise<StagingHandle>;
  putStagedAsset(ingestId: string, name: string, bytes: AssetBytes): Promise<void>;
  adoptStagedAssets(holeId: string, ingestId: string): Promise<string[]>;
  discardStaging(ingestId: string): Promise<void>;
}
