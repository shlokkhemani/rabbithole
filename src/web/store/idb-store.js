import { maxAssetBytes, validateAssetName } from "../../core/assets.js";
import { normalizeViewState } from "../../core/hole/bookmark.js";
import { parsePersistedHole, toPersistedHole } from "../../core/schema.js";
import { assertSafeHoleId, assertSafeIngestId, createIngestId, holeSummary } from "../../core/store.js";

const DB_NAME = "rabbithole-browser";
const DB_VERSION = 1;
const HOLES = "holes";
const HOLE_SUMMARIES = "hole-summaries";
const ASSETS = "assets";
const STAGING = "staging";
const META = "meta";

// A hole's view, when it moved after the hole was last written in full.
function viewKey(holeId) {
  return `view:${holeId}`;
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

function bytesToBlob(bytes, label = "asset bytes", name = "asset.png") {
  let blob;
  if (bytes instanceof Blob) blob = bytes;
  else if (bytes instanceof Uint8Array || bytes instanceof ArrayBuffer) blob = new Blob([/** @type {BlobPart} */ (bytes)]);
  else throw new Error(`${label} must be a Blob, ArrayBuffer, or Uint8Array`);
  const limit = maxAssetBytes(name);
  if (blob.size > limit) throw new Error(`${label} exceeds ${Math.round(limit / 1024 / 1024)} MB`);
  return blob;
}

export class IdbStore {
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
    let tx = db.transaction([HOLES, HOLE_SUMMARIES], "readonly");
    let done = txDone(tx);
    const holesStore = tx.objectStore(HOLES);
    let [summaries, holeCount] = await Promise.all([
      requestToPromise(tx.objectStore(HOLE_SUMMARIES).getAll()),
      requestToPromise(holesStore.count()),
    ]);
    await done;
    if (summaries.length !== holeCount) {
      tx = db.transaction([HOLES, HOLE_SUMMARIES], "readwrite");
      done = txDone(tx);
      const holes = await requestToPromise(tx.objectStore(HOLES).getAll());
      const summaryStore = tx.objectStore(HOLE_SUMMARIES);
      summaries = holes.map(holeSummary);
      for (const summary of summaries) summaryStore.put(summary);
      await done;
    }
    return summaries.sort(compareSummaries);
  }

  async loadHole(holeId) {
    const safeHoleId = assertSafeHoleId(holeId);
    const db = await this.open();
    const tx = db.transaction([HOLES, META], "readonly");
    const done = txDone(tx);
    const [raw, view] = await Promise.all([
      requestToPromise(tx.objectStore(HOLES).get(safeHoleId)),
      requestToPromise(tx.objectStore(META).get(viewKey(safeHoleId))),
    ]);
    await done;
    if (!raw) return null;
    // IndexedDB has already returned a structured clone owned by this request.
    const hole = parsePersistedHole(raw, { clone: false });
    if (view) hole.view_state = normalizeViewState(view.view_state);
    return hole;
  }

  async saveHole(hole, options = {}) {
    assertSafeHoleId(hole?.hole_id);
    this.requestPersistenceOnce();
    const persisted = toPersistedHole(hole, { ...options, cloneExtensions: false });
    const db = await this.open();
    const tx = db.transaction([HOLES, HOLE_SUMMARIES, META], "readwrite");
    const done = txDone(tx);
    tx.objectStore(HOLES).put(persisted);
    tx.objectStore(HOLE_SUMMARIES).put(holeSummary(persisted));
    // The hole now carries the latest view; an older one must not outrank it.
    tx.objectStore(META).delete(viewKey(persisted.hole_id));
    await done;
  }

  /** Where the human was reading, written without every document (see loadHole). */
  async saveViewState(holeId, viewState) {
    const safeHoleId = assertSafeHoleId(holeId);
    const db = await this.open();
    const tx = db.transaction(META, "readwrite");
    const done = txDone(tx);
    tx.objectStore(META).put({ key: viewKey(safeHoleId), view_state: normalizeViewState(viewState) });
    await done;
  }

  async deleteHole(holeId) {
    const safeHoleId = assertSafeHoleId(holeId);
    this.requestPersistenceOnce();
    const db = await this.open();
    const tx = db.transaction([HOLES, HOLE_SUMMARIES, ASSETS, META], "readwrite");
    const done = txDone(tx);
    tx.objectStore(HOLES).delete(safeHoleId);
    tx.objectStore(HOLE_SUMMARIES).delete(safeHoleId);
    tx.objectStore(META).delete(viewKey(safeHoleId));
    await deleteByPrefix(tx.objectStore(ASSETS), safeHoleId, this.IDBKeyRange, "hole_id");
    await done;
  }

  async listAssets(holeId) {
    const safeHoleId = assertSafeHoleId(holeId);
    const db = await this.open();
    const tx = db.transaction(ASSETS, "readonly");
    const done = txDone(tx);
    const store = tx.objectStore(ASSETS);
    const keys = this.IDBKeyRange
      ? await requestToPromise(store.getAllKeys(this.IDBKeyRange.bound([safeHoleId, ""], [safeHoleId, "\uffff"])))
      : null;
    const rows = keys ? [] : await requestToPromise(store.getAll());
    await done;
    return (keys ? keys.map((key) => key[1]) : rows.filter((row) => row.hole_id === safeHoleId).map((row) => row.name)).sort();
  }

  async getAsset(holeId, name) {
    const safeHoleId = assertSafeHoleId(holeId);
    const safeName = validateAssetName(name);
    const db = await this.open();
    const tx = db.transaction(ASSETS, "readonly");
    const done = txDone(tx);
    const row = await requestToPromise(tx.objectStore(ASSETS).get([safeHoleId, safeName]));
    await done;
    return row ? row.blob : null;
  }

  async getAssets(holeId) {
    const safeHoleId = assertSafeHoleId(holeId);
    const db = await this.open();
    const tx = db.transaction(ASSETS, "readonly");
    const done = txDone(tx);
    const store = tx.objectStore(ASSETS);
    const rows = await requestToPromise(this.IDBKeyRange
      ? store.getAll(this.IDBKeyRange.bound([safeHoleId, ""], [safeHoleId, "\uffff"]))
      : store.getAll());
    await done;
    return rows
      .filter((row) => row.hole_id === safeHoleId)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((row) => ({ name: row.name, blob: row.blob }));
  }

  async putAsset(holeId, name, bytes) {
    const safeHoleId = assertSafeHoleId(holeId);
    const safeName = validateAssetName(name);
    const blob = bytesToBlob(bytes, "asset bytes", safeName);
    this.requestPersistenceOnce();
    const db = await this.open();
    const tx = db.transaction(ASSETS, "readwrite");
    const done = txDone(tx);
    tx.objectStore(ASSETS).put({ hole_id: safeHoleId, name: safeName, blob, updated_at: new Date().toISOString() });
    await done;
  }

  async putAssets(holeId, assets) {
    const safeHoleId = assertSafeHoleId(holeId);
    if (!Array.isArray(assets)) throw new Error("assets must be an array");
    const rows = assets.map((asset, index) => {
      const safeName = validateAssetName(asset?.name, `assets[${index}].name`);
      return {
        hole_id: safeHoleId,
        name: safeName,
        blob: bytesToBlob(asset?.blob ?? asset?.bytes, `assets[${index}].bytes`, safeName),
      };
    });
    if (!rows.length) return;
    this.requestPersistenceOnce();
    const db = await this.open();
    const tx = db.transaction(ASSETS, "readwrite");
    const done = txDone(tx);
    const store = tx.objectStore(ASSETS);
    const updated_at = new Date().toISOString();
    for (const row of rows) store.put({ ...row, updated_at });
    await done;
  }

  async deleteAsset(holeId, name) {
    const safeHoleId = assertSafeHoleId(holeId);
    const safeName = validateAssetName(name);
    this.requestPersistenceOnce();
    const db = await this.open();
    const tx = db.transaction(ASSETS, "readwrite");
    const done = txDone(tx);
    tx.objectStore(ASSETS).delete([safeHoleId, safeName]);
    await done;
  }

  async createStaging() {
    this.requestPersistenceOnce();
    const ingest_id = createIngestId();
    const db = await this.open();
    const tx = db.transaction(META, "readwrite");
    const done = txDone(tx);
    tx.objectStore(META).put({ key: `staging:${ingest_id}`, created_at: new Date().toISOString() });
    await done;
    return { ingest_id };
  }

  async putStagedAsset(ingestId, name, bytes) {
    const safeIngestId = assertSafeIngestId(ingestId);
    const safeName = validateAssetName(name);
    const blob = bytesToBlob(bytes, "staged asset bytes", safeName);
    this.requestPersistenceOnce();
    const db = await this.open();
    const tx = db.transaction(STAGING, "readwrite");
    const done = txDone(tx);
    tx.objectStore(STAGING).put({ ingest_id: safeIngestId, name: safeName, blob, updated_at: new Date().toISOString() });
    await done;
  }

  async adoptStagedAssets(holeId, ingestId) {
    const safeHoleId = assertSafeHoleId(holeId);
    const safeIngestId = assertSafeIngestId(ingestId);
    this.requestPersistenceOnce();
    const db = await this.open();
    const tx = db.transaction([STAGING, ASSETS, META], "readwrite");
    const done = txDone(tx);
    const staged = await getAllForIngest(tx.objectStore(STAGING), safeIngestId, this.IDBKeyRange);
    if (!staged.length) {
      tx.abort();
      try { await done; } catch {}
      throw new Error(`Unknown ingest_id ${JSON.stringify(ingestId)}; restart the PDF import.`);
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
    await done;
    return moved.sort();
  }

  async discardStaging(ingestId) {
    const safeIngestId = assertSafeIngestId(ingestId);
    const db = await this.open();
    const tx = db.transaction([STAGING, META], "readwrite");
    const done = txDone(tx);
    await deleteByPrefix(tx.objectStore(STAGING), safeIngestId, this.IDBKeyRange, "ingest_id");
    tx.objectStore(META).delete(`staging:${safeIngestId}`);
    await done;
  }

  open() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(HOLES)) db.createObjectStore(HOLES, { keyPath: "hole_id" });
        if (!db.objectStoreNames.contains(HOLE_SUMMARIES)) db.createObjectStore(HOLE_SUMMARIES, { keyPath: "hole_id" });
        if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS, { keyPath: ["hole_id", "name"] });
        if (!db.objectStoreNames.contains(STAGING)) db.createObjectStore(STAGING, { keyPath: ["ingest_id", "name"] });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
      };
      request.onsuccess = () => {
        const db = request.result;
        // Release this connection when another tab needs to upgrade the schema.
        // Without this, the other tab's open request can remain blocked forever.
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB"));
    });
    return this.dbPromise;
  }

  close() {
    const pending = this.dbPromise;
    this.dbPromise = null;
    pending?.then((db) => db.close()).catch(() => {});
  }

  requestPersistenceOnce() {
    if (this.persistRequested) return;
    this.persistRequested = true;
    try {
      // Persistent-storage permission is an optional durability enhancement. Some
      // embedded browsers leave this promise pending while they wait for a user
      // gesture or an unsupported permission flow, so it must never gate writes.
      const request = globalThis.navigator?.storage?.persist?.();
      Promise.resolve(request).catch(() => {});
    } catch {}
  }
}

function compareSummaries(a, b) {
  return String(b.updated_at).localeCompare(String(a.updated_at));
}

async function getAllForIngest(store, ingestId, IDBKeyRangeCtor) {
  if (!IDBKeyRangeCtor) {
    const rows = await requestToPromise(store.getAll());
    return rows.filter((row) => row.ingest_id === ingestId);
  }
  return requestToPromise(store.getAll(IDBKeyRangeCtor.bound([ingestId, ""], [ingestId, "\uffff"])));
}

async function deleteByPrefix(store, prefix, IDBKeyRangeCtor, field) {
  if (IDBKeyRangeCtor) {
    store.delete(IDBKeyRangeCtor.bound([prefix, ""], [prefix, "\uffff"]));
    return;
  }
  const rows = await requestToPromise(store.getAll());
  for (const row of rows) if (row[field] === prefix) store.delete([prefix, row.name]);
}
