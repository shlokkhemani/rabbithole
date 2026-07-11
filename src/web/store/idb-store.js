import { validateAssetName, MAX_ASSET_BYTES } from "../../core/assets.js";
import { CURRENT_SCHEMA_VERSION, migratePersistedHole, toPersistedHole } from "../../core/schema.js";
import { randomUuidOrFallback } from "../../core/utils.js";

const DB_NAME = "rabbithole-web";
const DB_VERSION = 1;
const HOLES = "holes";
const ASSETS = "assets";
const STAGING = "staging";
const META = "meta";

function assertSafeHoleId(holeId) {
  const id = String(holeId ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`Invalid hole id: ${JSON.stringify(holeId)}`);
  }
  return id;
}

function assertSafeIngestId(ingestId) {
  const id = String(ingestId ?? "");
  if (!/^ingest-[a-z0-9][a-z0-9_-]*$/.test(id)) {
    throw new Error(`Invalid ingest id: ${JSON.stringify(ingestId)}`);
  }
  return id;
}

function cloneJson(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value ?? null));
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
  });
}

async function bytesToBlob(bytes, label = "asset bytes") {
  let blob;
  if (bytes instanceof Blob) blob = bytes;
  else if (bytes instanceof Uint8Array || bytes instanceof ArrayBuffer) blob = new Blob([bytes]);
  else throw new Error(`${label} must be a Blob, ArrayBuffer, or Uint8Array`);
  if (blob.size > MAX_ASSET_BYTES) throw new Error(`${label} exceeds 20 MB`);
  return blob;
}

function newIngestId() {
  const stamp = Date.now().toString(36);
  const uuid = randomUuidOrFallback();
  return `ingest-${stamp}-${String(uuid).replace(/-/g, "").slice(0, 16)}`;
}

export class IdbStore {
  schema_version = CURRENT_SCHEMA_VERSION;

  constructor({ indexedDB = globalThis.indexedDB, IDBKeyRange = globalThis.IDBKeyRange, dbName = DB_NAME } = {}) {
    if (!indexedDB) throw new Error("IndexedDB is unavailable");
    this.indexedDB = indexedDB;
    this.IDBKeyRange = IDBKeyRange;
    this.dbName = dbName;
    this.dbPromise = null;
    this.persistRequested = false;
  }

  async listHoles() {
    const db = await this.open();
    const tx = db.transaction(HOLES, "readonly");
    const holes = await requestToPromise(tx.objectStore(HOLES).getAll());
    await txDone(tx);
    return holes
      .map((hole) => ({
        hole_id: hole.hole_id,
        title: hole.title,
        updated_at: hole.updated_at,
        node_count: Array.isArray(hole.nodes) ? hole.nodes.length : 0,
      }))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  async loadHole(holeId) {
    const safeHoleId = assertSafeHoleId(holeId);
    const db = await this.open();
    const tx = db.transaction(HOLES, "readonly");
    const raw = await requestToPromise(tx.objectStore(HOLES).get(safeHoleId));
    await txDone(tx);
    if (!raw) return null;
    const migrated = migratePersistedHole(raw);
    if (migrated.changed) await this.saveHole(migrated.hole);
    return migrated.hole;
  }

  async saveHole(hole, options = {}) {
    assertSafeHoleId(hole?.hole_id);
    await this.requestPersistenceOnce();
    const persisted = toPersistedHole(hole, options);
    const db = await this.open();
    const tx = db.transaction(HOLES, "readwrite");
    tx.objectStore(HOLES).put(cloneJson(persisted));
    await txDone(tx);
  }

  async deleteHole(holeId) {
    const safeHoleId = assertSafeHoleId(holeId);
    await this.requestPersistenceOnce();
    const db = await this.open();
    const tx = db.transaction([HOLES, ASSETS], "readwrite");
    tx.objectStore(HOLES).delete(safeHoleId);
    await deleteByHoleId(tx.objectStore(ASSETS), safeHoleId, this.IDBKeyRange);
    await txDone(tx);
  }

  async listAssets(holeId) {
    const safeHoleId = assertSafeHoleId(holeId);
    const db = await this.open();
    const tx = db.transaction(ASSETS, "readonly");
    const rows = await getAllForHole(tx.objectStore(ASSETS), safeHoleId, this.IDBKeyRange);
    await txDone(tx);
    return rows.map((row) => row.name).sort();
  }

  async getAsset(holeId, name) {
    const safeHoleId = assertSafeHoleId(holeId);
    const safeName = validateAssetName(name);
    const db = await this.open();
    const tx = db.transaction(ASSETS, "readonly");
    const row = await requestToPromise(tx.objectStore(ASSETS).get([safeHoleId, safeName]));
    await txDone(tx);
    return row ? row.blob : null;
  }

  async putAsset(holeId, name, bytes) {
    const safeHoleId = assertSafeHoleId(holeId);
    const safeName = validateAssetName(name);
    const blob = await bytesToBlob(bytes);
    await this.requestPersistenceOnce();
    const db = await this.open();
    const tx = db.transaction(ASSETS, "readwrite");
    tx.objectStore(ASSETS).put({ hole_id: safeHoleId, name: safeName, blob, updated_at: new Date().toISOString() });
    await txDone(tx);
  }

  async deleteAsset(holeId, name) {
    const safeHoleId = assertSafeHoleId(holeId);
    const safeName = validateAssetName(name);
    await this.requestPersistenceOnce();
    const db = await this.open();
    const tx = db.transaction(ASSETS, "readwrite");
    tx.objectStore(ASSETS).delete([safeHoleId, safeName]);
    await txDone(tx);
  }

  async createStaging() {
    await this.requestPersistenceOnce();
    const ingest_id = newIngestId();
    const db = await this.open();
    const tx = db.transaction(META, "readwrite");
    tx.objectStore(META).put({ key: `staging:${ingest_id}`, created_at: new Date().toISOString() });
    await txDone(tx);
    return { ingest_id };
  }

  async putStagedAsset(ingestId, name, bytes) {
    const safeIngestId = assertSafeIngestId(ingestId);
    const safeName = validateAssetName(name);
    const blob = await bytesToBlob(bytes, "staged asset bytes");
    await this.requestPersistenceOnce();
    const db = await this.open();
    const tx = db.transaction(STAGING, "readwrite");
    tx.objectStore(STAGING).put({ ingest_id: safeIngestId, name: safeName, blob, updated_at: new Date().toISOString() });
    await txDone(tx);
  }

  async adoptStagedAssets(holeId, ingestId) {
    const safeHoleId = assertSafeHoleId(holeId);
    const safeIngestId = assertSafeIngestId(ingestId);
    await this.requestPersistenceOnce();
    const db = await this.open();
    const tx = db.transaction([STAGING, ASSETS, META], "readwrite");
    const staged = await getAllForIngest(tx.objectStore(STAGING), safeIngestId, this.IDBKeyRange);
    if (!staged.length) {
      tx.abort();
      throw new Error(`Unknown ingest_id ${JSON.stringify(ingestId)}; run ingest_pdf again.`);
    }
    const assetStore = tx.objectStore(ASSETS);
    const stagingStore = tx.objectStore(STAGING);
    const moved = [];
    for (const row of staged) {
      assetStore.put({ hole_id: safeHoleId, name: row.name, blob: row.blob, updated_at: new Date().toISOString() });
      stagingStore.delete([safeIngestId, row.name]);
      moved.push(row.name);
    }
    tx.objectStore(META).delete(`staging:${safeIngestId}`);
    await txDone(tx);
    return moved.sort();
  }

  async discardStaging(ingestId) {
    const safeIngestId = assertSafeIngestId(ingestId);
    const db = await this.open();
    const tx = db.transaction([STAGING, META], "readwrite");
    const rows = await requestResult(tx.objectStore(STAGING).getAll());
    for (const row of rows) if (row.ingest_id === safeIngestId) tx.objectStore(STAGING).delete([safeIngestId, row.name]);
    tx.objectStore(META).delete(`staging:${safeIngestId}`);
    await txDone(tx);
  }

  async open() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(HOLES)) db.createObjectStore(HOLES, { keyPath: "hole_id" });
        if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS, { keyPath: ["hole_id", "name"] });
        if (!db.objectStoreNames.contains(STAGING)) db.createObjectStore(STAGING, { keyPath: ["ingest_id", "name"] });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB"));
    });
    return this.dbPromise;
  }

  async requestPersistenceOnce() {
    if (this.persistRequested) return;
    this.persistRequested = true;
    try {
      if (globalThis.navigator?.storage?.persist) await globalThis.navigator.storage.persist();
    } catch {}
  }
}

async function getAllForHole(store, holeId, IDBKeyRangeCtor) {
  if (!IDBKeyRangeCtor) {
    const rows = await requestToPromise(store.getAll());
    return rows.filter((row) => row.hole_id === holeId);
  }
  return requestToPromise(store.getAll(IDBKeyRangeCtor.bound([holeId, ""], [holeId, "\uffff"])));
}

async function getAllForIngest(store, ingestId, IDBKeyRangeCtor) {
  if (!IDBKeyRangeCtor) {
    const rows = await requestToPromise(store.getAll());
    return rows.filter((row) => row.ingest_id === ingestId);
  }
  return requestToPromise(store.getAll(IDBKeyRangeCtor.bound([ingestId, ""], [ingestId, "\uffff"])));
}

async function deleteByHoleId(store, holeId, IDBKeyRangeCtor) {
  const rows = await getAllForHole(store, holeId, IDBKeyRangeCtor);
  for (const row of rows) store.delete([row.hole_id, row.name]);
}
