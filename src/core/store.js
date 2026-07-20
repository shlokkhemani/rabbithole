import { randomUuidOrFallback } from "./utils.js";

/**
 * RabbitholeStore port.
 *
 * Implementations must provide:
 * - listHoles(): Promise<Array<{ hole_id, title, updated_at, node_count }>>
 * - loadHole(holeId): Promise<PersistedHole | null>
 * - saveHole(hole): Promise<void>
 * - deleteHole(holeId): Promise<void>
 * - listAssets(holeId): Promise<string[]>
 * - getAsset(holeId, name): Promise<Blob | Uint8Array | null>
 * - putAsset(holeId, name, bytes): Promise<void>
 * - deleteAsset(holeId, name): Promise<void>
 * - createStaging(): Promise<{ ingest_id: string }>
 * - putStagedAsset(ingestId, name, bytes): Promise<void>
 * - adoptStagedAssets(holeId, ingestId): Promise<string[]>
 * - discardStaging(ingestId): Promise<void>
 */

export const RABBITHOLE_STORE_METHODS = Object.freeze([
  "listHoles",
  "loadHole",
  "saveHole",
  "deleteHole",
  "listAssets",
  "getAsset",
  "putAsset",
  "deleteAsset",
  "createStaging",
  "putStagedAsset",
  "adoptStagedAssets",
  "discardStaging",
]);

/**
 * Checks the runtime store port by method presence. Detailed method shapes are
 * intentionally reserved for the reviewed store contract declaration.
 * @param {object | null | undefined} store
 * @returns {object}
 */
export function assertRabbitholeStore(store) {
  for (const method of RABBITHOLE_STORE_METHODS) {
    if (typeof /** @type {Record<string, unknown> | null | undefined} */ (store)?.[method] !== "function") {
      throw new Error(`RabbitholeStore missing ${method}()`);
    }
  }
  return /** @type {object} */ (store);
}

/** @param {unknown} holeId */
export function assertSafeHoleId(holeId) {
  const id = String(holeId ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`Invalid hole id: ${JSON.stringify(holeId)}`);
  return id;
}

/** @param {unknown} ingestId */
export function assertSafeIngestId(ingestId) {
  const id = String(ingestId ?? "");
  if (!/^ingest-[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`Invalid ingest id: ${JSON.stringify(ingestId)}`);
  return id;
}

export function createIngestId() {
  return `ingest-${Date.now().toString(36)}-${randomUuidOrFallback().replace(/-/g, "").slice(0, 16)}`;
}

/** @param {{ hole_id?: unknown, title?: unknown, updated_at?: unknown, nodes?: unknown[] }} hole */
export function holeSummary(hole) {
  return {
    hole_id: String(hole.hole_id ?? ""),
    title: String(hole.title ?? ""),
    updated_at: hole.updated_at ?? null,
    node_count: Array.isArray(hole.nodes) ? hole.nodes.length : 0,
  };
}
